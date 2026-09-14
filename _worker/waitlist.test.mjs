// Run with: node --test _worker/waitlist.test.mjs
// Resend and Turnstile are faked, so nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isAcceptableEmail, verifyWebhook, countWithNewcomer, signupNoteText } from './waitlist.js';

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a test signing key, 32 bytes long').toString('base64');
const env = {
  RESEND_API_KEY: 're_test',
  TURNSTILE_SECRET_KEY: 'turnstile_test',
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let calls;
let turnstileSays;
let contactLookup; // { status, body }
let contactPages; // successive responses for the contact list
let emailSendFails;

beforeEach(() => {
  calls = [];
  turnstileSays = true;
  contactLookup = { status: 404, body: {} };
  contactPages = [{ data: [{ id: 'c1', email: 'someone@example.com' }], has_more: false }];
  emailSendFails = false;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body });
    if (url.startsWith('https://challenges.cloudflare.com')) {
      return Response.json({ success: turnstileSays });
    }
    if (method === 'GET' && url.includes('/contacts/')) {
      return Response.json(contactLookup.body, { status: contactLookup.status });
    }
    if (method === 'GET' && url.includes('/contacts?')) {
      return Response.json(contactPages.shift() || { data: [], has_more: false });
    }
    if (method === 'POST' && url.endsWith('/emails') && emailSendFails) {
      throw new Error('network down');
    }
    return Response.json({ ok: true });
  };
});

// Waits for the after-response work too, the way Cloudflare lets it finish.
async function join(body) {
  const pending = [];
  const res = await worker.fetch(
    new Request('https://api.zoryaritual.com/join', {
      method: 'POST',
      headers: { Origin: 'https://zoryaritual.com', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

const noteSent = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/emails'));

async function signedWebhook(payload, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(payload);
  const id = 'msg_test';
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret.replace(/^whsec_/, ''), 'base64'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`))).toString('base64');
  return new Request('https://api.zoryaritual.com/resend-webhook', {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` },
    body: raw,
  });
}

const resendCalls = () => calls.filter((c) => c.url.startsWith('https://api.resend.com'));

test('email rules match the form', () => {
  assert.equal(isAcceptableEmail('cj@zoryaritual.com'), true);
  assert.equal(isAcceptableEmail('=cmd@evil.com'), false);
  assert.equal(isAcceptableEmail('not-an-email'), false);
  assert.equal(isAcceptableEmail('a@b.c'), false);
  assert.equal(isAcceptableEmail('x'.repeat(250) + '@a.com'), false);
});

test('a new signup sends the join event', async () => {
  const res = await join({ email: ' new@example.com ', turnstileToken: 't' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://zoryaritual.com');
  const sent = resendCalls().find((c) => c.url.endsWith('/events/send'));
  assert.deepEqual(JSON.parse(sent.body), { event: 'waitlist.joined', email: 'new@example.com' });
});

test('someone already on the list gets no second welcome', async () => {
  contactLookup = { status: 200, body: { id: 'c1', unsubscribed: false } };
  const res = await join({ email: 'again@example.com', turnstileToken: 't' });
  assert.equal(res.status, 200);
  assert.equal(resendCalls().some((c) => c.url.endsWith('/events/send')), false);
});

test('rejoining after unsubscribing resubscribes, then welcomes', async () => {
  contactLookup = { status: 200, body: { id: 'c1', unsubscribed: true } };
  await join({ email: 'back@example.com', turnstileToken: 't' });
  const methods = resendCalls().slice(0, 3).map((c) => c.method);
  assert.deepEqual(methods, ['GET', 'PATCH', 'POST']);
});

test('a new signup notifies hello@ with the total and no address', async () => {
  await join({ email: 'fresh@example.com', turnstileToken: 't' });
  const note = JSON.parse(noteSent().body);
  assert.deepEqual(note.to, ['hello@zoryaritual.com']);
  assert.equal(note.subject, 'New Zorya waitlist signup');
  assert.match(note.text, /You now have 2 people on the list\./);
  assert.equal(noteSent().body.includes('fresh@example.com'), false);
});

test('someone already on the list triggers no notification', async () => {
  contactLookup = { status: 200, body: { id: 'c1', unsubscribed: false } };
  await join({ email: 'again@example.com', turnstileToken: 't' });
  assert.equal(noteSent(), undefined);
});

test('a failed notification still leaves the signup a success', async () => {
  emailSendFails = true;
  const res = await join({ email: 'fresh@example.com', turnstileToken: 't' });
  assert.equal(res.status, 200);
});

test('the count walks every page and does not double-count the newcomer', async () => {
  contactPages = [
    { data: [{ id: 'a', email: 'A@example.com' }, { id: 'b', email: 'new@example.com' }], has_more: true },
    { data: [{ id: 'c', email: 'c@example.com' }], has_more: false },
  ];
  assert.equal(await countWithNewcomer(env, 'NEW@example.com'), 3);
  const listUrls = calls.filter((c) => c.url.includes('/contacts?')).map((c) => c.url);
  assert.ok(listUrls[1].endsWith('&after=b'));
});

test('the note reads naturally for one person, and survives a failed count', () => {
  assert.match(signupNoteText(1), /You now have 1 person on the list\./);
  assert.equal(signupNoteText(null).includes('You now have'), false);
});

test('the honeypot answers success and contacts nobody', async () => {
  const res = await join({ email: 'bot@example.com', _gotcha: 'Acme' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('a bad address is refused before any outside call', async () => {
  const res = await join({ email: '+1@example.com', turnstileToken: 't' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('failing the bot check stops the signup', async () => {
  turnstileSays = false;
  const res = await join({ email: 'real@example.com', turnstileToken: 't' });
  assert.equal(res.status, 403);
  assert.equal(resendCalls().length, 0);
});

test('a missing bot-check token never reaches Cloudflare or Resend', async () => {
  const res = await join({ email: 'real@example.com' });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('an unsubscribe webhook deletes the contact', async () => {
  const req = await signedWebhook({ type: 'contact.updated', data: { id: 'c9', email: 'x@example.com', unsubscribed: true } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const del = resendCalls().find((c) => c.method === 'DELETE');
  assert.ok(del.url.endsWith('/contacts/c9'));
});

test('other contact updates delete nothing', async () => {
  const req = await signedWebhook({ type: 'contact.updated', data: { id: 'c9', unsubscribed: false } });
  await worker.fetch(req, env);
  assert.equal(resendCalls().length, 0);
});

test('a forged webhook is rejected', async () => {
  const forgedSecret = 'whsec_' + Buffer.from('somebody else entirely, 32 bytes').toString('base64');
  const req = await signedWebhook({ type: 'contact.updated', data: { id: 'c9', unsubscribed: true } }, { secret: forgedSecret });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('a replayed old webhook is rejected', async () => {
  const req = await signedWebhook(
    { type: 'contact.updated', data: { id: 'c9', unsubscribed: true } },
    { timestamp: Math.floor(Date.now() / 1000) - 600 },
  );
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
});

test('verifyWebhook accepts any matching signature in a rotated list', async () => {
  const req = await signedWebhook({ type: 'ping' });
  const headers = new Headers(req.headers);
  headers.set('svix-signature', 'v1,bm90IGl0 ' + req.headers.get('svix-signature'));
  assert.equal(await verifyWebhook(WEBHOOK_SECRET, headers, await req.text()), true);
});

test('unknown paths are 404', async () => {
  const res = await worker.fetch(new Request('https://api.zoryaritual.com/'), env);
  assert.equal(res.status, 404);
});

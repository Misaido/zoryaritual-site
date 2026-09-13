// Run with: node --test _worker/waitlist.test.mjs
// Resend and Turnstile are faked, so nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isAcceptableEmail, verifyWebhook } from './waitlist.js';

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a test signing key, 32 bytes long').toString('base64');
const env = {
  RESEND_API_KEY: 're_test',
  TURNSTILE_SECRET_KEY: 'turnstile_test',
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let calls;
let turnstileSays;
let contactLookup; // { status, body }

beforeEach(() => {
  calls = [];
  turnstileSays = true;
  contactLookup = { status: 404, body: {} };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body });
    if (url.startsWith('https://challenges.cloudflare.com')) {
      return Response.json({ success: turnstileSays });
    }
    if (method === 'GET' && url.includes('/contacts/')) {
      return Response.json(contactLookup.body, { status: contactLookup.status });
    }
    return Response.json({ ok: true });
  };
});

function join(body) {
  return worker.fetch(
    new Request('https://api.zoryaritual.com/join', {
      method: 'POST',
      headers: { Origin: 'https://zoryaritual.com', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

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
  const methods = resendCalls().map((c) => c.method);
  assert.deepEqual(methods, ['GET', 'PATCH', 'POST']);
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

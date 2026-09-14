// Zorya waitlist, as a Cloudflare Worker.
//
// The website is static, so it cannot hold the Resend API key. This Worker
// holds it instead and does two jobs:
//
//   POST /join            The waitlist form posts here. Checks the bot guard,
//                         then sends Resend the "waitlist.joined" event. A
//                         Resend Automation listening for that event creates
//                         the contact and sends the welcome email. Then
//                         hello@ gets a note with the new total, and no
//                         address in it.
//
//   POST /resend-webhook  Resend calls this when a contact changes. When
//                         someone has unsubscribed, their contact is deleted,
//                         because privacy.html promises deletion rather than
//                         an "inactive" flag.
//
// Secrets (set in Cloudflare, never in this file):
//   RESEND_API_KEY          Full access key. A sending-only key cannot touch contacts.
//   TURNSTILE_SECRET_KEY    From the Turnstile widget for zoryaritual.com.
//   RESEND_WEBHOOK_SECRET   The whsec_... signing secret of the Resend webhook.
//
// No dependencies, so the whole file can be pasted into the Cloudflare editor.

const ALLOWED_ORIGINS = ['https://zoryaritual.com', 'https://www.zoryaritual.com'];
const JOIN_EVENT = 'waitlist.joined';
// CJ gets a note for each new signup. It deliberately leaves out the address,
// so an unsubscribe leaves no copy behind in the inbox.
const NOTIFY_FROM = 'Zorya <hello@zoryaritual.com>';
const NOTIFY_TO = 'hello@zoryaritual.com';
const CONTACTS_PAGE_SIZE = 100;
const MAX_CONTACT_PAGES = 50;
const RESEND_API = 'https://api.resend.com';
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Svix, which signs Resend webhooks, rejects anything older than five minutes.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// Same rules as the form in index.html, repeated here because anyone can post
// to this Worker without going through the page.
const FORMULA_STARTERS = ['=', '+', '-', '@'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isAcceptableEmail(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 254) return false;
  if (FORMULA_STARTERS.includes(value.charAt(0))) return false;
  return EMAIL_PATTERN.test(value);
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function resend(env, path, init = {}) {
  return fetch(RESEND_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function passesTurnstile(env, token, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body: form });
  if (!res.ok) return false;
  const outcome = await res.json();
  return outcome.success === true;
}

// The Automation creates the contact a moment after the event, so the new
// person may not be in the list yet. Count them either way.
export async function countWithNewcomer(env, email) {
  const target = email.toLowerCase();
  let total = 0;
  let seen = false;
  let after = '';
  for (let page = 0; page < MAX_CONTACT_PAGES; page++) {
    const res = await resend(env, `/contacts?limit=${CONTACTS_PAGE_SIZE}` + (after ? `&after=${encodeURIComponent(after)}` : ''));
    if (!res.ok) return null;
    const { data = [], has_more: hasMore } = await res.json();
    total += data.length;
    if (data.some((c) => typeof c.email === 'string' && c.email.toLowerCase() === target)) seen = true;
    if (!hasMore || data.length === 0) break;
    after = data[data.length - 1].id;
  }
  return seen ? total : total + 1;
}

export function signupNoteText(count) {
  const tally = count === null ? '' : ` You now have ${count} ${count === 1 ? 'person' : 'people'} on the list.`;
  return `Someone new joined the Zorya waitlist.${tally}\n\nSee everyone in Resend: https://resend.com/audience`;
}

async function notifyNewSignup(env, email) {
  try {
    const count = await countWithNewcomer(env, email);
    await resend(env, '/emails', {
      method: 'POST',
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [NOTIFY_TO],
        subject: 'New Zorya waitlist signup',
        text: signupNoteText(count),
      }),
    });
  } catch {
    // A missed note must never turn a good signup into an error.
  }
}

async function handleJoin(request, env, ctx) {
  const cors = corsHeaders(request.headers.get('Origin'));

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400, cors);
  }

  // A bot filled the hidden field. Answer like a success so it learns nothing.
  if (body._gotcha) {
    return json({ ok: true }, 200, cors);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isAcceptableEmail(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400, cors);
  }

  const human = await passesTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) {
    return json({ ok: false, error: 'bot_check_failed' }, 403, cors);
  }

  const path = '/contacts/' + encodeURIComponent(email);
  const existing = await resend(env, path);
  if (existing.ok) {
    const contact = await existing.json();
    if (!contact.unsubscribed) {
      // Already on the list. Don't send a second welcome email.
      return json({ ok: true }, 200, cors);
    }
    // They unsubscribed and came back before the webhook deleted them.
    // Signing up again is a fresh opt-in.
    const resubscribed = await resend(env, path, {
      method: 'PATCH',
      body: JSON.stringify({ unsubscribed: false }),
    });
    if (!resubscribed.ok) {
      return json({ ok: false, error: 'upstream' }, 502, cors);
    }
  } else if (existing.status === 404) {
    // Create the contact ourselves, marked subscribed, before the event.
    // Resend keeps deleted contacts in the background: leaving creation to
    // the Automation revives someone who once unsubscribed still marked
    // unsubscribed, and their welcome email is silently skipped.
    const created = await resend(env, '/contacts', {
      method: 'POST',
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (!created.ok) {
      return json({ ok: false, error: 'upstream' }, 502, cors);
    }
  } else {
    return json({ ok: false, error: 'upstream' }, 502, cors);
  }

  const sent = await resend(env, '/events/send', {
    method: 'POST',
    body: JSON.stringify({ event: JOIN_EVENT, email }),
  });
  if (!sent.ok) {
    return json({ ok: false, error: 'upstream' }, 502, cors);
  }
  // Runs after the visitor already has their answer.
  ctx.waitUntil(notifyNewSignup(env, email));
  return json({ ok: true }, 200, cors);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Svix's documented manual check: HMAC-SHA256 over "id.timestamp.body", keyed
// with the base64 part of the whsec_ secret. The header may carry several
// space-separated "v1,<signature>" entries, and any one matching is enough.
export async function verifyWebhook(secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatureHeader = headers.get('svix-signature');
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = bytesToBase64(signed);

  return signatureHeader
    .split(' ')
    .map((entry) => entry.split(','))
    .some(([version, signature]) => version === 'v1' && signature !== undefined && constantTimeEqual(signature, expected));
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const genuine = await verifyWebhook(env.RESEND_WEBHOOK_SECRET, request.headers, rawBody);
  if (!genuine) {
    return json({ ok: false }, 401);
  }

  const event = JSON.parse(rawBody);
  // This covers every contact on the Resend account, not only the waitlist.
  // That's intended while the waitlist is the only thing using contacts.
  if (event.type === 'contact.updated' && event.data && event.data.unsubscribed === true) {
    const deleted = await resend(env, '/contacts/' + encodeURIComponent(event.data.id), { method: 'DELETE' });
    // Anything but success or already-gone returns an error, so Resend retries.
    if (!deleted.ok && deleted.status !== 404) {
      return json({ ok: false }, 502);
    }
  }
  return json({ ok: true }, 200);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/join') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
      }
      if (request.method === 'POST') return handleJoin(request, env, ctx);
    }

    if (pathname === '/resend-webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    return json({ ok: false }, 404);
  },
};

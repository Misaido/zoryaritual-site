# Waitlist backend

The folder name starts with `_` so GitHub Pages does not publish it. Nothing in here is
secret anyway: keys live only in Cloudflare and Resend.

## How a signup flows

1. Someone submits the form on `index.html`.
2. The form posts to this Worker at `/join`, with a Cloudflare Turnstile token (the
   invisible bot check).
3. The Worker checks the token, then sends Resend the event `waitlist.joined`.
4. A Resend Automation listening for that event creates the contact and sends the welcome
   email (`welcome-email.html`). Someone already on the list gets no second welcome.

## How removal flows

1. The person clicks **Unsubscribe** in any waitlist email. Resend marks them unsubscribed
   and shows its unsubscribe page.
2. Resend calls this Worker at `/resend-webhook` with `contact.updated`.
3. The Worker verifies the signature and deletes the contact.

Deletion is deliberate: `privacy.html` promises removed addresses are deleted, not marked
inactive. Someone who emails hello@ instead gets deleted by hand in Resend → Contacts.

## Where each piece lives

| Piece | Place |
|---|---|
| Worker code | `waitlist.js`, deployed to Cloudflare Workers |
| Worker secrets | Cloudflare → Workers → this Worker → Settings → Variables and Secrets |
| Bot check | Cloudflare → Turnstile (site key is public and sits in `index.html`) |
| Welcome email | Resend → Templates (source copy: `welcome-email.html`) |
| Send-on-signup rule | Resend → Automations, trigger `waitlist.joined` |
| Unsubscribe → delete | Resend → Webhooks, event `contact.updated`, URL `…/resend-webhook` |
| Unsubscribe page wording | Resend → Settings → Unsubscribe Page |

## Copy that lives outside this repo

**Unsubscribe page** (Resend → Settings → Unsubscribe Page)

- Title: `You're off the list`
- Description: `Your email address has been deleted from the Zorya waitlist, and you won't hear from us again. If you change your mind, you can rejoin any time at zoryaritual.com.`

**Reply for a removal request sent to hello@** (save as a Zoho template)

> Hi, all done. I've deleted your email address from the Zorya waitlist, so you won't hear
> from us again. Thank you for your interest, and the form at zoryaritual.com is always open
> if you'd like to come back.
> CJ

## Tests

```
node --test _worker/waitlist.test.mjs
```

Resend and Turnstile are faked, so the tests send nothing anywhere.

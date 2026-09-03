# zoryaritual.com

The marketing site for Zorya. Static HTML, no build step, no dependencies.
Hosted on GitHub Pages, DNS via Cloudflare.

## Files

| File | What it is |
|---|---|
| `index.html` | The landing page. Self-contained styles. |
| `privacy.html` | Privacy notice **for this website only**. Not the app's policy. |
| `404.html` | Not-found page. GitHub Pages serves this automatically. |
| `site.css` | Shared styles for the text pages. `index.html` does not use it. |
| `theme.js` | Light/dark toggle, persisted to `localStorage`. |
| `favicon.svg` | Wordmark glyph on the dark card. |
| `CNAME` | Tells GitHub Pages the custom domain. **Do not delete.** |
| `.nojekyll` | Stops Pages running Jekyll over the files. |

## Editing

Open a file, change it, commit, push to `main`. GitHub Pages redeploys in
under a minute. There is nothing to build and nothing to install.

## Theming

Both themes are CSS custom properties at the top of `index.html` and
`site.css`. The dark palette mirrors the app's "Glamour" theme in
`protocol-mobile/src/shared/theme/tokens.ts` — if those tokens change,
change these to match.

The theme is set by a small inline script in each `<head>` **before** first
paint, so there is no flash of the wrong colours. Leave it inline; moving it
to an external file reintroduces the flash.

## The waitlist form

`index.html` has a `FORMSPREE_ENDPOINT` constant near the bottom, currently
empty. While it is empty the form does **not** claim a signup it cannot
capture — it routes to email instead.

To turn it on: create a free form at [formspree.io](https://formspree.io),
paste the endpoint (`https://formspree.io/f/xxxxxxxx`) into that constant,
commit, push. Nothing else needs to change.

## Still outstanding

- **Waitlist backend** — see above.
- **`og:image`** — there is no link preview image, so shared links show text
  only. Needs a 1200x630 PNG committed here and referenced from the meta tags.
- **App legal pages** — the real Privacy Policy, Terms, and Medical Disclaimer
  live as unpublished drafts on the `docs/legal-launch-pack` branch of the app
  repo. They carry unfilled placeholders, are branded "Protocol" rather than
  "Zorya", and are marked as needing legal review before publication.

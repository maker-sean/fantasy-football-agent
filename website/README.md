# Marketing site

Static HTML and one stylesheet. No build step, no framework, no CDN, no webfonts.

```
index.html      home + messaging disclosures (#messaging)
pricing.html    $19/season + FAQ
privacy.html    privacy policy
terms.html      terms of service + messaging terms
styles.css      the whole design system
```

## Before this goes live

Every placeholder renders as a loud yellow `[BRACKETED]` chip so it cannot ship
unnoticed. Find them all:

```bash
grep -rn 'class="todo"' website/
```

| Placeholder | Where |
|---|---|
| `[LEGAL BUSINESS NAME]` | all four pages, footer |
| `[SUPPORT EMAIL]` | privacy, terms |
| `[MAILING ADDRESS]` | privacy |
| `[PAYMENT PROCESSOR]` | privacy |
| `[DATE]` | privacy, terms |
| `[30]` — data retention window | privacy |
| `[REFUND POLICY]` | terms |
| `[STATE/JURISDICTION]` | terms |

**These documents are drafts, not legal advice.** They were written to cover
what carrier registration asks for and to describe honestly what the system
actually does. Have someone qualified review them before you take money or
register a campaign.

## Why these pages exist

A2P 10DLC registration — required to lift the Sendblue contact cap that is
currently blocking roll call — asks for a public site showing:

- who operates the service, with real contact details
- what the messages are and how often they arrive
- how someone consents (opt-in) and how they stop (`STOP` / `HELP`)
- "message and data rates may apply"
- a privacy policy stating that mobile numbers are not sold or shared with
  third parties for marketing

All of that is on `index.html#messaging`, `privacy.html`, and `terms.html`.
Registration reviewers follow links, so those pages must stay reachable from
every page's footer — there is a CSS regression test for exactly this, because
a media query once hid a footer link at phone width.

## What is deliberately NOT claimed

The reference mockup advertised several things that do not exist. They are not
on this site:

- trade grades at the moment of a trade (needs projections; `src/verify.js`
  exists to stop the bot inventing numbers like that)
- playoff-odds percentages
- `@Commish` slash commands
- ESPN or Yahoo league support
- a free-text "make the bot say this" tool

If a feature is added later, it goes on the site then.

## Local preview

```bash
python3 -m http.server 4321 --directory website
```

## Deploy

Any static host. Vercel, Netlify, Cloudflare Pages — point it at `website/`
with no build command. The site must be served over HTTPS on the domain you
give the carrier during registration.

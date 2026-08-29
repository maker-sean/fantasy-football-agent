/**
 * The commissioner web app.
 *
 * Express in the same repo as the worker, deliberately. The entire domain layer
 * — db, sleeper, trades, lineup, stats — is already CommonJS in src/ and
 * imports as-is. A separate front-end app on another host would mean either
 * duplicating that logic or calling back here anyway, plus a second place for
 * DATABASE_URL to live. This is a form over Postgres; it does not need a
 * framework.
 *
 * Run:  npm run web
 */

const path = require('path');

// Load .env relative to this file, not the working directory. The server can be
// launched from anywhere (a process manager, an IDE, a different repo root) and
// silently starting with no DATABASE_URL because cwd was wrong is a confusing
// way to fail.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const db = require('../src/db');
const observe = require('../src/observe');
const flags = require('../src/flags');
const sleeper = require('../src/sleeper');
const errorlog = require('../src/errorlog');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-08-16';

// Webhook signatures are computed over the EXACT bytes that were sent, so the
// raw body has to survive JSON parsing. Capturing it here rather than mounting
// a separate raw parser keeps one body-parsing path for the whole app.
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.disable('x-powered-by');

/*
 * Record every 4xx and 5xx this API returns.
 *
 * On the response FINISHING rather than by wrapping res.json, so it catches
 * every path — handlers that return early, express's own 404, the error
 * handler at the bottom — without any of them having to remember.
 *
 * 401 on /api/me is excluded: an expired session hitting a page refresh is the
 * single most common 401 in the system and it is not a failure of anything. It
 * would bury the 400s that are.
 */
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    if (res.statusCode === 401 && req.path === '/api/me') return;
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/webhooks/')) return;
    errorlog.record({
      system: 'web',
      operation: `${req.method} ${req.route?.path || req.path}`,
      status: res.statusCode,
      message: res.locals.errorMessage || `${res.statusCode} on ${req.method} ${req.path}`,
    });
  });
  next();
});

/*
 * Render terminates TLS and forwards to this process over plain HTTP, so
 * without this req.protocol reports "http" on a site that is only ever reached
 * over https. That is not cosmetic: the operator sign-in builds its redirect
 * from the origin, and http://host/admin/ does not match an https allowlist
 * entry, so Supabase silently discards it and falls back to Site URL. The link
 * arrives and goes to the wrong place, which is the same failure this codebase
 * has now hit three times.
 *
 * 1, not true: trust exactly one hop, Render's proxy. Trusting the whole chain
 * would let a client forge X-Forwarded-For and, later, whatever is keyed on it.
 */
app.set('trust proxy', 1);

/**
 * Operator details, substituted into the pages at serve time.
 *
 * These change when an entity is actually formed — a real business name, a
 * registered address, possibly a different state. Editing five HTML files and
 * redeploying for that is silly, and worse, easy to do incompletely. Server-side
 * substitution rather than client-side so the values are in the HTML a crawler
 * or a carrier reviewer sees, and so the page still works with JavaScript off.
 *
 * An unset value renders the same loud placeholder as before. A legal page that
 * quietly ships with a blank contact is worse than one that shouts about it.
 */
const SITE = {
  BUSINESS_NAME: process.env.SITE_BUSINESS_NAME || 'Commish AI',
  SUPPORT_EMAIL: process.env.SITE_SUPPORT_EMAIL || null,
  JURISDICTION: process.env.SITE_JURISDICTION || 'the Commonwealth of Virginia',
  JURISDICTION_SHORT: process.env.SITE_JURISDICTION_SHORT || 'Virginia',
};

const loud = name => `<span class="todo">[${name.replace(/_/g, ' ')}]</span>`;
const mailto = e => `<a href="mailto:${e}">${e}</a>`;
const tel = n => `<a href="sms:${n}">${n}</a>`;

/**
 * How to reach a person, with a fallback that is true.
 *
 * The loud placeholder is right for a value nobody has decided yet and wrong
 * for this one, because these pages are live: the privacy policy promises data
 * deletion on request, commits to removing a child's data on contact, and
 * offers no way to make either request. "[SUPPORT EMAIL]" on a public legal
 * page is worse than an imperfect contact.
 *
 * So it degrades to the messaging number rather than shouting. That number is
 * genuinely monitored — the worker polls it every ten seconds, which is more
 * than most support inboxes manage — and for a product delivered over SMS it is
 * the obvious place to reach somebody. The prose on both pages was reworded to
 * say "contact" rather than "email" so neither answer reads oddly.
 */
function supportContact() {
  if (SITE.SUPPORT_EMAIL) return mailto(SITE.SUPPORT_EMAIL);
  const number = process.env.SENDBLUE_FROM_NUMBER;
  return number ? tel(number) : loud('SUPPORT_CONTACT');
}

function fillTokens(html) {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (key === 'SUPPORT_CONTACT') return supportContact();
    const v = SITE[key];
    if (!v) return loud(key);
    return key === 'SUPPORT_EMAIL' ? mailto(v) : v;
  });
}

// The marketing site ships from the same service. One origin means no CORS to
// configure and no preflight on every authenticated request.
const WEBSITE_DIR = path.join(__dirname, '..', 'website');
const pageCache = new Map();

/*
 * Count page views. Path and time, nothing else.
 *
 * Deliberately anonymous — see 0018_funnel.sql. It also has to be invisible to
 * the request: fire and forget, never awaited, and a failure is swallowed. A
 * marketing page that 500s because an analytics insert deadlocked would be a
 * remarkably stupid way to lose a signup.
 *
 * Only real page requests are counted. Assets, the API and the health check
 * would each multiply one human visit into a dozen rows and make the number
 * mean nothing.
 */
const COUNTED_PAGE = /^\/(?:|index\.html|start\.html|pricing\.html|messaging\.html|terms\.html|privacy\.html)$/;

app.use((req, _res, next) => {
  if (req.method === 'GET' && COUNTED_PAGE.test(req.path)) {
    db.query('insert into page_views (path) values ($1)', [req.path === '/' ? '/index.html' : req.path])
      .catch(() => { /* analytics must never break a page */ });
  }
  next();
});

/** Read a page and substitute the operator details, cached in production. */
function filledPage(file) {
  let html = pageCache.get(file);
  if (html === undefined) {
    html = fillTokens(require('fs').readFileSync(file, 'utf8'));
    if (process.env.NODE_ENV === 'production') pageCache.set(file, html);
  }
  return html;
}

app.get(/\.html$|^\/$/, (req, res, next) => {
  const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  if (rel.includes('..')) return next();
  const file = path.join(WEBSITE_DIR, rel);
  if (!file.startsWith(WEBSITE_DIR)) return next();

  try {
    res.type('html').send(filledPage(file));
  } catch {
    next();      // not a page we serve; fall through to static
  }
});

/*
 * The app and the operator board get the same substitution as the marketing
 * site.
 *
 * They did not, because express.static serves bytes and knows nothing about
 * {{BUSINESS_NAME}}. The consequence was visible and easy to misread: the
 * commissioner app's footer showed the loud [LEGAL BUSINESS NAME] placeholder,
 * which is what fillTokens renders for a MISSING value — so it looked like an
 * unset environment variable rather than a page that never ran the substitution
 * at all. Registered ahead of the static mounts, which still serve the CSS and
 * the JS beside them.
 */
for (const [route, dir] of [['/app', 'app'], ['/admin', 'admin']]) {
  const file = path.join(__dirname, dir, 'index.html');
  app.get([route, route + '/'], (_req, res, next) => {
    try { res.type('html').send(filledPage(file)); } catch { next(); }
  });
}

/*
 * A contact card for the bot.
 *
 * A group chat gets a message from a bare number and nobody knows what it is.
 * Sendblue has no way to give a line a name or a face — /api/lines returns the
 * number and nothing else — so the only route is to send a vCard the group can
 * tap and save.
 *
 * The photo is EMBEDDED base64 rather than linked. A linked photo is a request
 * the recipient's phone makes to us later, which is both a tracking vector this
 * site's privacy policy promises not to create and a picture that vanishes the
 * day the URL changes.
 *
 * vCard 3.0, not 4.0: it is what iOS and Android Contacts both import without
 * argument, and this is the one file where compatibility beats being current.
 */
let vcardCache = null;

function contactCard() {
  if (vcardCache) return vcardCache;
  const number = process.env.SENDBLUE_FROM_NUMBER || '';
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || null;
  const photo = require('fs')
    .readFileSync(path.join(WEBSITE_DIR, 'logo-512.png')).toString('base64');

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:;Commish AI;;;',
    'FN:Commish AI',
    'ORG:Commish AI',
    'TITLE:League assistant',
    number ? `TEL;type=CELL;type=VOICE;type=pref:${number}` : null,
    /*
     * No hardcoded origin. This used to name the Render subdomain, which meant
     * an unset env var did not fail — it shipped a retired origin into a card
     * already saved in somebody's Contacts, where nothing ever rechecks it.
     * Same chain as ballotlink and onboardlink; no URL beats the wrong one.
     */
    baseUrl ? `URL:${baseUrl}` : null,
    `PHOTO;ENCODING=b;TYPE=PNG:${photo}`,
    'END:VCARD',
  ].filter(Boolean);

  // Folding is not optional at this size. A vCard line over 75 octets must be
  // continued with CRLF and a single space, and an unfolded 7KB photo line is
  // exactly the kind of thing a strict parser rejects outright.
  const folded = lines.flatMap(line => {
    if (line.length <= 75) return [line];
    const out = [line.slice(0, 75)];
    for (let i = 75; i < line.length; i += 74) out.push(' ' + line.slice(i, i + 74));
    return out;
  });

  vcardCache = folded.join('\r\n') + '\r\n';
  return vcardCache;
}

app.get('/contact.vcf', (_req, res) => {
  res.type('text/vcard; charset=utf-8')
     .set('content-disposition', 'attachment; filename="Commish AI.vcf"')
     .send(contactCard());
});

app.use(express.static(WEBSITE_DIR, { extensions: ['html'] }));
app.use('/app', express.static(path.join(__dirname, 'app'), { extensions: ['html'] }));
// Operator UI. The static files are not secret; every byte of data behind them
// is gated on /api/admin, which is where the check belongs.
app.use('/admin', express.static(path.join(__dirname, 'admin'), { extensions: ['html'] }));

// One copy of the shared browser helper, served from src/ rather than copied
// into each front end. The bug it fixes came from app.js and admin.js building
// the same request slightly differently; duplicating the fix into two files
// would have set up the next divergence.
app.get('/shared/authlink.js', (_req, res) => {
  res.type('application/javascript')
     .sendFile(path.join(__dirname, '..', 'src', 'authlink.js'));
});

/**
 * Public browser configuration.
 *
 * The anon key is public by design — it identifies the project, it does not
 * authorize anything on its own, and Supabase expects it in client code. Served
 * from here rather than baked into the HTML so the same build works across
 * environments without a build step to substitute it.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null,
    devAuth: Boolean(DEV_AUTH),
    termsVersion: TERMS_VERSION,
    // Served rather than duplicated in the front end, so the labels a
    // commissioner picks from cannot drift away from the prompts they select.
    // That drift is the failure hardest to notice: a bot snarkier than its
    // setting says still looks like it works.
    tones: require('../src/tone').LEVELS.map(l =>
      ({ spice: l.spice, key: l.key, label: l.label, blurb: l.blurb })),
  });
});

// ---------------------------------------------------------------- auth ----

/**
 * Supabase Auth issues the token in the browser; this verifies it by asking
 * Supabase who it belongs to.
 *
 * Introspection rather than local JWT verification: it needs no signing secret,
 * survives key rotation, and involves no hand-rolled crypto. The cost is a
 * network call, which a short cache removes for all but the first request of a
 * session.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/**
 * Refuse to start on a privileged Supabase key.
 *
 * The anon/publishable key and the service_role/secret key sit next to each
 * other in the dashboard and look almost identical. This one is handed to every
 * browser by /api/config, so pasting the wrong one is not a small mistake — it
 * is full read/write on the database for anyone who views source, with row
 * level security bypassed. Crashing on boot is the kindest possible failure.
 */
function assertBrowserSafeKey(key) {
  if (!key) return;
  if (/^sb_secret_/.test(key)) throw new Error('SUPABASE_ANON_KEY is a SECRET key (sb_secret_…)');
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role;
      if (role && role !== 'anon') throw new Error(`SUPABASE_ANON_KEY has role "${role}"`);
    } catch (err) {
      if (/role/.test(err.message)) throw err;   // rethrow our own verdict, ignore parse noise
    }
  }
}

try {
  assertBrowserSafeKey(SUPABASE_ANON_KEY);
} catch (err) {
  console.error('[web] FATAL: ' + err.message);
  console.error('[web] This key is served to browsers. Use the key labelled "anon" / "public"');
  console.error('[web] (or sb_publishable_…), never service_role / sb_secret_.');
  process.exit(1);
}

const tokenCache = new Map();          // token -> { user, expires }
const CACHE_MS = 60 * 1000;

async function verifyToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  tokenCache.set(token, { user, expires: Date.now() + CACHE_MS });
  if (tokenCache.size > 500) tokenCache.clear();   // crude, but bounded
  return user;
}

/**
 * Local development without Supabase configured.
 *
 * Gated on three things at once — not production, an explicit opt-in flag, and
 * a named email — because an auth bypass that reaches production is the worst
 * bug in this file. It also announces itself on every boot.
 */
const DEV_AUTH = process.env.NODE_ENV !== 'production'
  && process.env.DEV_AUTH === 'true'
  && process.env.DEV_AUTH_EMAIL;

const onboardlink = require('../src/onboardlink');

/**
 * Exchange a texted invite for an account.
 *
 * The signup row is the authority, not the token: the token only says WHICH
 * signup, and if that row has been deleted the invite is dead. That is the
 * revocation mechanism, and it is worth knowing it is the only one.
 *
 * The account is keyed on the phone rather than created fresh each time, so a
 * commissioner who opens the link on their phone and again on a laptop lands in
 * the same account instead of two half-onboarded ones.
 */
async function accountForInvite(invite) {
  const { rows: [signup] } = await db.query('select * from signups where id = $1', [invite.signupId]);
  if (!signup || !signup.phone) return null;

  /*
   * Record that the link was opened.
   *
   * redeemed_at keeps the FIRST time only, so it measures "did they ever
   * start"; redeem_count keeps climbing, which is the audit trail the token
   * itself does not have. Fire and forget — a failed write here must not cost
   * somebody their sign-in.
   */
  db.query(
    `update signups
        set redeemed_at = coalesce(redeemed_at, now()),
            redeem_count = redeem_count + 1
      where id = $1`, [signup.id]
  ).catch(err => console.error('[invite] could not record redemption:', err.message));

  return {
    account: await db.accountByPhone(signup.phone)
             || await db.upsertAccountByPhone({ phone: signup.phone }),
    signup,
  };
}

async function requireAccount(req, res, next) {
  try {
    if (DEV_AUTH) {
      req.account = await db.upsertAccount({ email: process.env.DEV_AUTH_EMAIL });
      return next();
    }

    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

    /*
     * A texted invite, before anything Supabase.
     *
     * Two reasons for the order. It must not send our own token to Supabase's
     * introspection endpoint — that is somebody else's server and this is a
     * credential. And an invite has to work on a deployment where Supabase is
     * not configured at all, which is the entire point: the email path being
     * broken is why this exists, so it cannot depend on the email path being
     * set up.
     */
    const invite = onboardlink.read(token);
    if (invite) {
      // Distinct from invalid_token on purpose. "Your link expired, ask for a
      // new one" is actionable; "invalid" sends people hunting for a bug.
      if (invite.expired) return res.status(401).json({ error: 'link_expired' });

      /*
       * A roster link authorises the league's OWNER, not whoever asked for it.
       *
       * That is the whole security property. Anybody in a group chat can say
       * "somebody took my team"; only the person who owns the league can
       * reassign one, and the link is minted for them and texted to them. If
       * the league has no owning account there is nobody to be, so it fails
       * rather than falling back to anything.
       */
      if (invite.kind === onboardlink.KIND_ROSTER) {
        const { rows: [lg] } = await db.query(
          'select id, name, account_id from leagues where id = $1', [invite.leagueId]);
        if (!lg || !lg.account_id) return res.status(401).json({ error: 'invalid_token' });
        const { rows: [acct] } = await db.query(
          'select * from accounts where id = $1', [lg.account_id]);
        if (!acct) return res.status(401).json({ error: 'invalid_token' });

        req.account = acct;
        // Narrow on purpose: this token opens one league's roster and says so,
        // so the app can show that screen alone rather than the whole flow.
        req.manage = { leagueId: lg.id, leagueName: lg.name, expiresAt: invite.expiresAt };
        return next();
      }

      const resolved = await accountForInvite(invite);
      if (!resolved) return res.status(401).json({ error: 'invalid_token' });

      req.account = resolved.account;
      req.invite = {
        signupId: invite.signupId,
        expiresAt: invite.expiresAt,
        sleeperLeagueId: resolved.signup.sleeper_league_id || null,
        leagueName: resolved.signup.league_name || null,
      };
      return next();
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(503).json({ error: 'auth_not_configured' });
    }

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid_token' });

    // First login creates the account. Supabase owns the credential; this owns
    // everything about the commissioner.
    req.account = await db.accountByAuthId(user.id)
      || await db.upsertAccount({ email: user.email, authUserId: user.id });

    return next();
  } catch (err) {
    console.error('[web] auth failed:', err.message);
    return res.status(500).json({ error: 'auth_error' });
  }
}

/**
 * Resolve :leagueId, scoped to the signed-in account.
 *
 * Every league route goes through here so no handler ever queries a league by
 * id alone. That is the mistake this whole layer exists to make impossible.
 */
async function loadLeague(req, res, next) {
  const league = await db.leagueForAccount(req.account.id, req.params.leagueId);
  // 404 rather than 403: a wrong account should not be able to learn that a
  // league id exists at all.
  if (!league) return res.status(404).json({ error: 'not_found' });
  req.league = league;
  next();
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --------------------------------------------------------------- routes ----

app.get('/health', wrap(async (_req, res) => {
  const { rows } = await db.query('select now() as now');
  /*
   * Which commit is answering.
   *
   * src/version.js has computed this since the beginning and nothing exposed
   * it, so "is my change actually deployed?" was unanswerable from outside.
   * That cost real time twice in one evening: a 404 that looked like a bad
   * signing secret was an undeployed route, and a stale operator board looked
   * like a caching bug. A short sha is not a secret — it identifies a commit,
   * it does not reveal one.
   */
  res.json({
    ok: true,
    db: rows[0].now,
    devAuth: Boolean(DEV_AUTH),
    commit: (require('../src/version').commitSha() || 'unknown').slice(0, 8),
  });
}));

app.get('/api/me', requireAccount, wrap(async (req, res) => {
  res.json({
    account: {
      id: req.account.id,
      email: req.account.email,
      termsAcceptedAt: req.account.terms_accepted_at,
      termsVersion: req.account.terms_version,
      needsTerms: req.account.terms_version !== TERMS_VERSION,
    },
    leagues: await db.leaguesForAccount(req.account.id),
    termsVersion: TERMS_VERSION,
    // Present only when signed in by a texted invite. The signup already knows
    // which Sleeper league they picked on the site, so making them search for
    // it again would be asking a question we have the answer to.
    invite: req.invite || null,
    // Present only for a roster link. The app shows the roster editor alone
    // when this is set — no steps, no "and continue".
    manage: req.manage || null,
  });
}));

app.post('/api/me/terms', requireAccount, wrap(async (req, res) => {
  const account = await db.acceptTerms(req.account.id, TERMS_VERSION);
  res.json({ termsAcceptedAt: account.terms_accepted_at, termsVersion: account.terms_version });
}));

/**
 * Issue a signup code for a league picked on the marketing site.
 *
 * Public — no account exists yet at this point in the funnel; this is the step
 * before anyone signs in. It writes only a short code bound to a public Sleeper
 * league id, so the worst an abuser achieves is filling a table with codes
 * nobody texts.
 *
 * Returns the QR as inline SVG rather than a URL. The page must stay
 * self-contained: an <img> pointing at a QR service would leak every visitor's
 * league id to a third party, on a site whose privacy policy promises otherwise.
 */
/**
 * Is this promo code good, and how many slots are left on it?
 *
 * Public, like the rest of the pre-account funnel: the person asking is on the
 * start page and has no session yet. It leaks nothing an attacker wants —
 * whether a code is live, and a count — and for a code that came off a Reddit
 * post, both are already public.
 *
 * A no comes back with a REASON rather than a bare false, because the page
 * renders each one differently. "The cohort is full" is a different screen from
 * "we don't recognise that", and collapsing them would tell fifty people their
 * code was mistyped on the day the pilot filled up.
 */
app.get('/api/promo/validate', wrap(async (req, res) => {
  const promo = require('../src/promo');
  const out = await promo.validate(req.query?.code);
  // 200 either way. The code being full is an answer, not a failed request, and
  // a 4xx here would land in the browser console of every visitor who arrives
  // after slot fifty.
  res.json(out.ok
    ? { valid: true, promo: out.promo }
    : { valid: false, reason: out.reason, promo: out.promo || null,
        message: promoMessage(out.reason) });
}));

/** One place for the copy, so the page and the API cannot drift apart. */
function promoMessage(reason) {
  switch (reason) {
    case 'exhausted':
      return 'The 50 free beta slots are full. You are enrolling in our 7-day free trial.';
    case 'expired':  return 'That code has expired.';
    case 'inactive': return 'That code is no longer active.';
    case 'missing':  return 'Enter a code.';
    default:         return "We don't recognise that code.";
  }
}

app.post('/api/signup-intent', wrap(async (req, res) => {
  const sleeperLeagueId = String(req.body?.sleeperLeagueId || '').trim();
  if (!/^\d{6,25}$/.test(sleeperLeagueId)) return res.status(400).json({ error: 'bad_league_id' });

  const lg = await sleeper.league(sleeperLeagueId).catch(() => null);
  if (!lg?.league_id) return res.status(404).json({ error: 'league_not_found' });

  /*
   * No code without a name, an address and a platform.
   *
   * Checked here and not only in the browser, for the reason this codebase
   * keeps relearning: a rule enforced at one call site is a rule every other
   * caller skips. The page disables the button, and that is a courtesy — this
   * is the rule.
   *
   * Somebody who texts the number directly, having never seen this page, is
   * unaffected. They have no code, and src/intake.js asks them the same three
   * questions conversationally after they land.
   */
  const profile = readProfile(req.body);
  const missing = ['firstName', 'email', 'platform', 'plan'].filter(k => !profile[k]);
  if (profile.platform === 'other' && !profile.platformOther) missing.push('platformOther');
  if (missing.length) return res.status(400).json({ error: 'incomplete_profile', missing });

  const signup = require('../src/signup');
  const issued = await signup.issueCode({ sleeperLeagueId, league: lg, profile });

  /*
   * Hold a pilot slot, if they arrived on a link that grants one.
   *
   * This is the moment the cohort is actually defined. The person came from a
   * Reddit post or another commissioner's text, and this is the first point
   * where that fact is attached to a name and an email — after this they are
   * one of twenty-three signups that month and nothing says which door they
   * used.
   *
   * A FAILURE HERE DOES NOT FAIL THE SIGNUP. Somebody who typed a dead code
   * still wants to onboard, and the promo is the least important thing on the
   * screen. The reason comes back so the page can say what happened, and the
   * banner for an exhausted pilot is written to be reassuring rather than an
   * error: they get the trial instead.
   */
  let promoOut = null;
  const rawPromo = req.body?.promo || req.body?.ref;
  if (rawPromo) {
    const promo = require('../src/promo');
    const source = req.body?.ref && !req.body?.promo ? 'ref' : 'promo';
    try {
      const r = await promo.reserve(rawPromo, {
        sleeperLeagueId, signupCode: issued.code, email: profile.email, source,
      });
      promoOut = r.ok
        ? { applied: true, ...r.promo }
        : { applied: false, reason: r.reason, message: promoMessage(r.reason),
            code: promo.normalize(rawPromo) };
    } catch (err) {
      console.error('[promo] reserve failed:', err.message);
      promoOut = { applied: false, reason: 'error', message: promoMessage('error') };
    }
  }

  const number = process.env.SENDBLUE_FROM_NUMBER || null;
  const body = `${signup.KEYWORD} ${issued.code}`;
  // Both separators appear in the wild — iOS historically wanted &, Android ?.
  const smsUri = number ? `sms:${number}?&body=${encodeURIComponent(body)}` : null;

  let qrSvg = null;
  if (smsUri) {
    try {
      const QR = require('qrcode');
      qrSvg = await QR.toString(smsUri, { type: 'svg', margin: 1, width: 240,
        color: { dark: '#f4f5f6', light: '#00000000' } });
    } catch (err) {
      // A missing QR is a degraded page, not a broken one — the number and the
      // code are still right there to type.
      console.error('[qr] render failed:', err.message);
    }
  }

  /*
   * Tell the operator somebody filled the form.
   *
   * THIS WAS THE GAP. signup.record() alerts on a new signups row, and the
   * comment above it claims every path passes through there — true of the
   * texted keyword, the conversational path and /api/signup-email, but NOT of
   * this endpoint, which is the main form. It only issues a code. So somebody
   * could pick their league, hand over a name and an email, and be told to
   * text a number, and the operator heard nothing until they did. Three of the
   * last five codes issued were never texted in.
   *
   * It fires HERE rather than inside issueCode, which is where record()'s
   * one-funnel argument would put it. That argument holds for record() because
   * three paths reach it; issueCode has exactly one production caller, and the
   * promo result — the thing that makes this alert worth sending — is only
   * known out here, after the slot has actually been taken.
   *
   * Swallowed, like every other operator alert: a signup that is recorded and
   * not announced is a missed notification, one that throws is a lost lead.
   */
  const notify = require('../src/notify');
  await notify.operator(null, notify.codeIssuedText({
    leagueName: lg.name,
    teams: lg.total_rosters,
    name: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
    email: profile.email,
    plan: profile.plan,
    code: issued.code,
    promo: promoOut?.applied ? promoOut.code : null,
  })).catch(() => {});

  res.json({
    code: issued.code,
    keyword: signup.KEYWORD,
    body,
    number,
    smsUri,
    qrSvg,
    league: { name: lg.name, season: lg.season, totalRosters: lg.total_rosters },
    promo: promoOut,
  });
}));

/**
 * Name, email and platform off a request body, parsed the way the texted
 * intake parses them.
 *
 * One set of parsers, deliberately. "my name is Chris Dalton" typed into a box
 * and texted back at a question have to land in the same two columns, and a
 * form that split on the first space would file the same person twice under
 * different names depending on which door they came through.
 */
function readProfile(body) {
  const intake = require('../src/intake');
  const parsed = intake.parseName(body?.name);
  const wanted = String(body?.platform || '').trim().toLowerCase();
  const platform = intake.PLATFORMS.some(([key]) => key === wanted) ? wanted : null;
  const email = String(body?.email || '').trim();
  // Season or dynasty. Validated against the same two the tiles offer, so a
  // hand-rolled request cannot invent a third plan nobody sells.
  const wantedPlan = String(body?.plan || '').trim().toLowerCase();
  return {
    plan: ['season', 'dynasty'].includes(wantedPlan) ? wantedPlan : null,
    firstName: parsed?.first || null,
    lastName: parsed?.last || null,
    // Permissive, like every other address check here: bouncing a valid one
    // costs a lead, a bad one costs a row.
    email: intake.EMAIL.test(email) ? email.toLowerCase() : null,
    platform,
    platformOther: platform === 'other'
      ? String(body?.platformOther || '').trim().slice(0, 200) || null
      : null,
  };
}

/**
 * Has this code been texted in yet?
 *
 * Returns only a boolean, and answers identically for an unknown code and an
 * unused one. That is deliberate: the code space is 30^4, and distinguishing
 * "no such code" from "not used yet" would turn this into an enumeration
 * oracle. The person polling already knows which league they picked, so there
 * is nothing else worth returning.
 */
app.get('/api/signup-intent/:code/status', wrap(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return res.json({ used: false });
  const { rows } = await db.query(
    'select used_at from signup_codes where code = $1 and used_at is not null', [code]
  );
  res.json({ used: rows.length > 0, usedAt: rows[0]?.used_at || null });
}));

/**
 * Email signup — the path for people who will not text a number they just met,
 * and the one that does not stop working when the messaging plan's contact cap
 * is reached.
 *
 * Public, like the code endpoint: no account exists this early in the funnel.
 */
app.post('/api/signup-email', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const sleeperLeagueId = String(req.body?.sleeperLeagueId || '').trim() || null;

  // Deliberately permissive. Bouncing a valid address because it fails a clever
  // regex costs a real signup; a bad one costs one useless row.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'bad_email' });
  }
  if (sleeperLeagueId && !/^\d{6,25}$/.test(sleeperLeagueId)) {
    return res.status(400).json({ error: 'bad_league_id' });
  }

  /*
   * Name and platform, asked in the form because this path has no conversation.
   *
   * A texted signup gets these from src/intake.js one question at a time,
   * straight after the confirmation. Somebody who leaves an email never texts
   * anything, so nothing later ever asks them — that lead used to be an address
   * and nothing else, permanently.
   *
   * Parsed with intake's own parsers rather than a second set. "Chris Dalton"
   * typed into a box and texted back at a question have to land in the same two
   * columns, and a form that split on the first space while intake stripped
   * "my name is" would put different things in first_name depending on the door
   * somebody came through.
   */
  const profile = readProfile(req.body);
  const signup = require('../src/signup');
  const out = await signup.record({
    email, leagueId: sleeperLeagueId, source: 'web',
    firstName: profile.firstName,
    lastName: profile.lastName,
    platform: profile.platform,
    platformOther: profile.platformOther,
    plan: profile.plan,
  });
  res.json({
    ok: true,
    created: out.created,
    league: out.league ? { name: out.league.name, totalRosters: out.league.total_rosters } : null,
  });
}));

// --- onboarding step 4: pick a Sleeper league ------------------------------

app.get('/api/sleeper/leagues', requireAccount, wrap(async (req, res) => {
  const username = String(req.query.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'username_required' });

  let user;
  try {
    user = await sleeper.get(`/user/${encodeURIComponent(username)}`);
  } catch {
    return res.status(404).json({ error: 'no_such_user' });
  }
  if (!user?.user_id) return res.status(404).json({ error: 'no_such_user' });

  const now = new Date();
  const years = now.getMonth() < 2
    ? [now.getFullYear() - 1, now.getFullYear()]
    : [now.getFullYear(), now.getFullYear() - 1];

  for (const season of years) {
    const leagues = await sleeper.get(`/user/${user.user_id}/leagues/nfl/${season}`).catch(() => []);
    if (leagues?.length) return res.json({ user: { id: user.user_id, name: user.display_name }, season, leagues });
  }
  res.json({ user: { id: user.user_id, name: user.display_name }, season: null, leagues: [] });
}));

app.post('/api/leagues', requireAccount, wrap(async (req, res) => {
  const sleeperLeagueId = String(req.body?.sleeperLeagueId || '').trim();
  if (!/^\d{6,25}$/.test(sleeperLeagueId)) return res.status(400).json({ error: 'bad_league_id' });

  const lg = await sleeper.league(sleeperLeagueId).catch(() => null);
  if (!lg?.league_id) return res.status(404).json({ error: 'league_not_found' });

  /*
   * One Sleeper league, one live row, whoever is asking.
   *
   * This checked leaguesForAccount, so the same person re-adding a league
   * resumed and a DIFFERENT person onboarding the same league quietly created a
   * second one. In a twelve person league that is not a rare accident, it is
   * whoever else got excited and followed the link. Two rows means two sets of
   * members, two chat links racing for the same thread, and recaps computed
   * twice, none of which errors.
   */
  const claimed = await db.liveLeagueBySleeperId(sleeperLeagueId);
  if (claimed) {
    // Same account: this is a resume, which is the normal way back into a
    // half finished onboarding.
    if (claimed.account_id && claimed.account_id === req.account.id) {
      return res.json({ league: claimed, resumed: true });
    }
    // Somebody else already has it. Say so plainly and do not name them: the
    // account holder did not consent to having their identity handed to
    // whoever types a league id into the form.
    return res.status(409).json({
      error: 'league_already_onboarded',
      leagueName: claimed.name,
      state: claimed.onboarding_state,
      message: `${claimed.name} is already set up on Commish AI. `
             + 'Ask whoever set it up to add you to the group chat.',
    });
  }

  const { rows } = await db.query(
    `insert into leagues (name, sleeper_league_id, account_id, provider, season,
                          previous_sleeper_league_id, onboarding_state)
     values ($1,$2,$3,'sendblue',$4,$5,'league_linked')
     returning *`,
    [lg.name, sleeperLeagueId, req.account.id, lg.season, lg.previous_league_id || null]
  );
  res.status(201).json({ league: rows[0], resumed: false });
}));

// --- onboarding step 5: name and number for each roster --------------------

app.get('/api/leagues/:leagueId/roster', requireAccount, loadLeague, wrap(async (req, res) => {
  const payload = await sleeper.weekSnapshot(req.league.sleeper_league_id, 1).catch(() => null);
  const owners = payload ? sleeper.rosterOwners(payload) : [];

  const { rows: members } = await db.query(
    'select * from members where league_id = $1', [req.league.id]
  );

  /*
   * Grouped by ROSTER, not by Sleeper user.
   *
   * A roster can hold more than one person — co-managed teams are ordinary in
   * real leagues — and a co-owner has no Sleeper account of their own to key
   * on, so keying this map by sleeper_user_id could only ever find the primary.
   */
  const byRoster = new Map();
  for (const m of members) {
    if (m.sleeper_roster_id == null) continue;
    if (!byRoster.has(m.sleeper_roster_id)) byRoster.set(m.sleeper_roster_id, []);
    byRoster.get(m.sleeper_roster_id).push(m);
  }

  res.json({
    league: { id: req.league.id, name: req.league.name, state: req.league.onboarding_state },
    rosters: owners.map(o => {
      const rows = (byRoster.get(o.sleeperRosterId) || [])
        // Primary first — the one Sleeper says owns the roster.
        .sort((a, b) => (a.sleeper_user_id ? 0 : 1) - (b.sleeper_user_id ? 0 : 1));

      return {
        sleeperUserId: o.sleeperUserId,
        sleeperRosterId: o.sleeperRosterId,
        // Both labels, separately. The team name is a joke that changes
        // mid-season; the username is how you actually tell rosters apart.
        username: o.username,
        teamName: o.teamName,
        owners: rows.map(m => ({
          id: m.id,
          humanName: m.display_name || null,
          // Never return the stored number. The commissioner typed it; echoing
          // it back to any future session is a needless way to leak it.
          hasPhone: Boolean(m.phone),
          locked: Boolean(m.locked),
          isPrimary: Boolean(m.sleeper_user_id),
        })),
      };
    }),
  });
}));

app.post('/api/leagues/:leagueId/members', requireAccount, loadLeague, wrap(async (req, res) => {
  const entries = Array.isArray(req.body?.members) ? req.body.members : [];
  const removalsAsked = Array.isArray(req.body?.removedMemberIds) ? req.body.removedMemberIds : [];
  // A save can be nothing BUT removals — dropping the only co-owner on a team
  // whose name and number are already correct submits no member entries at all,
  // because untouched rows are deliberately skipped by the form.
  if (!entries.length && !removalsAsked.length) return res.status(400).json({ error: 'no_members' });

  /*
   * Sleeper's labels for each roster, fetched once for the whole save.
   *
   * Without this the columns stay null until members:sync runs overnight, and
   * everything that identifies a person in the meantime — the roll call, the
   * first recap — has only what the commissioner typed. One call per save is a
   * fair price for the league being legible on day one rather than day two.
   *
   * A Sleeper outage must not block onboarding, so a failure here leaves the
   * labels null and the save proceeds. The nightly sync fills them in later.
   */
  const labels = new Map();
  const rosterOfUser = new Map();
  try {
    const snap = await sleeper.weekSnapshot(req.league.sleeper_league_id, 1);
    for (const o of sleeper.rosterOwners(snap)) {
      labels.set(o.sleeperRosterId, { username: o.username, teamName: o.teamName });
      if (o.sleeperUserId) rosterOfUser.set(o.sleeperUserId, o.sleeperRosterId);
    }
  } catch (err) {
    console.warn('[roster] could not read Sleeper labels, saving without them:', err.message);
  }

  const results = [];

  for (const e of entries) {
    // Keyed on the ROSTER now. A co-owner has no Sleeper account, so the old
    // `if (!e.sleeperUserId) continue` skipped them in silence — they would
    // vanish on save with the form still showing them.
    /*
     * The roster is the key, but a caller that names only a Sleeper user still
     * works — Sleeper already knows which roster that account owns, so deriving
     * it beats rejecting a request we have the answer to. Only a co-owner, who
     * has no Sleeper account at all, genuinely has to supply the roster id.
     */
    const rosterId = e.sleeperRosterId ?? rosterOfUser.get(e.sleeperUserId) ?? null;
    if (rosterId == null) {
      results.push({ sleeperUserId: e.sleeperUserId || null, outcome: 'no_roster' });
      continue;
    }

    const isPrimary = Boolean(e.sleeperUserId);
    const phone = e.phone ? db.normalizePhone(e.phone) : null;

    if (e.phone && !/^\+\d{10,15}$/.test(phone || '')) {
      results.push({ sleeperRosterId: rosterId, outcome: 'bad_phone' });
      continue;
    }

    /*
     * A co-owner without a number cannot exist, and the reason is structural
     * rather than a rule we chose: members are keyed on (league_id, phone), so
     * a phoneless second row on a roster has nothing to conflict on and would
     * be inserted afresh on every save. It would also be pointless — the entire
     * purpose of a co-owner row is so the bot recognises that person's texts.
     */
    if (!isPrimary && !phone) {
      results.push({ sleeperRosterId: rosterId, outcome: 'phone_required' });
      continue;
    }

    const out = await db.bindMember(req.league.id, {
      phone,
      sleeperUserId: e.sleeperUserId || null,
      sleeperRosterId: rosterId,
      displayName: e.humanName || null,
      // Both owners of a co-managed team carry the same Sleeper labels — the
      // labels describe the ROSTER, not the person.
      username: labels.get(rosterId)?.username || null,
      teamName: labels.get(rosterId)?.teamName || null,
      boundBy: `account:${req.account.id}`,
      boundVia: 'onboarding',
      // The commissioner is the authority for their own league — this is the
      // override path that exists precisely so a mistyped number is fixable.
      force: true,
    });
    results.push({ sleeperRosterId: rosterId, isPrimary, outcome: out.outcome });
  }

  /*
   * Co-owners removed in the form, removed here — by id, not by omission.
   *
   * Reconciling by omission was the first attempt and it is subtly wrong: a
   * team whose name and number are already correct submits no entry at all
   * (untouched rows are skipped), so its roster never appears in the payload
   * and a removal on that team would silently do nothing.
   *
   * Scoped hard to sleeper_user_id IS NULL and to this league, so this can only
   * delete rows it created. A bad id must never be able to unbind the person
   * Sleeper says owns the roster.
   */
  const removedIds = removalsAsked.filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
  let removed = 0;
  if (removedIds.length) {
    const { rowCount } = await db.query(
      `delete from members
        where league_id = $1 and sleeper_user_id is null and id = any($2::uuid[])`,
      [req.league.id, removedIds]
    );
    removed = rowCount;
  }

  if (req.league.onboarding_state === 'league_linked') {
    await db.setOnboardingState(req.league.id, 'members_bound');
  }
  res.json({ results, removed });
}));

// --- onboarding step 6: prove the bot is in the group chat ------------------

app.post('/api/leagues/:leagueId/await-chat', requireAccount, loadLeague, wrap(async (req, res) => {
  // Never move a live league backwards. The app calls this when it renders the
  // waiting screen, so a stale tab or a back button could otherwise un-confirm
  // a chat that has already proved itself — and the league would go quiet with
  // nothing to explain why.
  const league = req.league.onboarding_state === 'live'
    ? req.league
    : await db.setOnboardingState(req.league.id, 'awaiting_chat');
  res.json({
    state: league.onboarding_state,
    number: process.env.SENDBLUE_FROM_NUMBER || null,
    // The screen holds here. Confirmation comes from a real inbound message,
    // not from the commissioner telling us they did it.
    instructions: 'Add this number to your league group chat, then send any message in it.',
  });
}));

app.get('/api/leagues/:leagueId/chat-status', requireAccount, loadLeague, wrap(async (req, res) => {
  res.json({
    state: req.league.onboarding_state,
    live: req.league.onboarding_state === 'live',
    chatLinkedAt: req.league.chat_linked_at,
  });
}));

/**
 * What this league ended up with, and the passes it has to give away.
 *
 * The spec called this complete-onboarding and had it do the completing. It
 * does not: a league goes live in src/chatlink.js when a real message lands in
 * the group chat, and the redemption and the minting happen there. If this
 * endpoint spent slots, anybody holding a session could drain the cohort and
 * print referral codes by calling it in a loop.
 *
 * So it reads. The one write it will do is a repair — a league that is live
 * with no passes, because the mint failed the first time — and minting is
 * idempotent and gated on the league genuinely being live.
 */
app.post('/api/leagues/:leagueId/complete-onboarding', requireAccount, loadLeague,
  wrap(async (req, res) => {
    const promo = require('../src/promo');
    const live = req.league.onboarding_state === 'live';

    const { rows: claims } = await db.query(
      `select c.*, p.discount_type, p.discount_value, p.label
         from promo_claims c join promo_codes p on p.code = c.code
        where c.league_id = $1 or (c.sleeper_league_id = $2 and c.state = 'reserved')
        order by c.created_at desc limit 1`,
      [req.league.id, req.league.sleeper_league_id]);
    const claim = claims[0] || null;

    /*
     * EARNED IS NOT THE SAME AS RELEASED.
     *
     * A live league's passes are minted the moment it goes live, and this
     * returns none of them until somebody has released them by hand. Asking a
     * commissioner to recommend the product to a friend four minutes after it
     * joined their group chat spends the ask before they have anything to base
     * it on; a few days later, after it has caught something, they offer.
     *
     * The screen renders nothing for an empty list and falls through to the
     * dashboard, so this one condition is what decides whether the referral
     * step exists at all.
     */
    let passes = [];
    if (live && claim && claim.state === 'redeemed') {
      // Minting stays here as the repair path for a league whose mint failed
      // at go-live. It is idempotent and it does not release anything.
      await promo.mintFounderPasses(req.league.id,
        { seed: await promo.seedFor(req.league) });
      passes = await promo.releasedPasses(req.league.id);
    }

    res.json({
      state: req.league.onboarding_state,
      live,
      promo: claim && {
        code: claim.code,
        state: claim.state,
        discountType: claim.discount_type,
        discountValue: Number(claim.discount_value),
        label: claim.label,
      },
      passes: passes.map(p => ({
        ...promo.shareFor(p.code),
        // Null once somebody has used it, so the screen can grey the row out
        // rather than inviting a second send that will not work.
        available: p.remaining === null ? true : p.remaining > 0,
      })),
    });
  }));

// --- dashboard -------------------------------------------------------------

const ALLOWED_CONFIG = new Set([
  'botNames', 'spice', 'autoPost', 'ownerPhone', 'timezone',
  'tradePollHours', 'requireBoundSender',
]);

app.patch('/api/leagues/:leagueId/config', requireAccount, loadLeague, wrap(async (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(req.body?.config || {})) {
    // Allowlist, not denylist: config drives the reply gate and the send rate,
    // so an unknown key silently landing in there is a way to turn off safety
    // rails from a browser.
    if (ALLOWED_CONFIG.has(k)) patch[k] = v;
  }
  const { rows } = await db.query(
    `update leagues set config = coalesce(config,'{}'::jsonb) || $2::jsonb
     where id = $1 and account_id = $3 returning config`,
    [req.league.id, JSON.stringify(patch), req.account.id]
  );
  res.json({ config: rows[0].config, applied: Object.keys(patch) });
}));

// -------------------------------------------------------------- ballots ----
//
// The voting surface. Public by design and by necessity: the link lands in a
// group chat and is opened in an in-app browser where nobody is signed in and
// nobody is going to sign in for a dinner poll. The token in the path IS the
// credential — minted per member, HMAC signed, verified here. That is what lets
// this be zero-auth for the voter while still being non-anonymous to us, which
// 0004_identity_binding.sql argues is the only defensible way to count a vote
// that comes out of a group chat.
//
// No rate limiter. The token is a MAC over a fixed body, so there is nothing to
// guess and no enumeration to slow down — and a limiter keyed on IP would
// throttle a whole league sitting behind one carrier NAT, which is precisely
// the collision this design exists to avoid.

const ballots = require('../src/ballots');
const ballotlink = require('../src/ballotlink');

if (!process.env.BALLOT_SECRET) {
  console.warn('[web] BALLOT_SECRET is unset, so every /v/ link will 404.');
  console.warn('[web] Set the SAME value here and on the worker, which mints the links.');
}

/*
 * The shell, with the question written into its Open Graph tags.
 *
 * This was a static sendFile, and the card iMessage drew for it said "A league
 * vote" over a Safari compass — indistinguishable from every other link anyone
 * has ever sent. The question is what makes it worth tapping.
 *
 * The first instinct was to keep the card contentless, on the reasoning that an
 * unfurl is visible to a whole group thread. That is the wrong model here:
 * ballot links are minted per member and fanned out 1:1 precisely because they
 * carry identity, so the card lands in one person's own thread. The question is
 * theirs to see.
 *
 * RESULTS STILL NEVER GO IN. Not the split, not the counts, not even for a
 * results_visible='live' ballot. A card is cached by Apple and by the device,
 * survives being forwarded, and cannot be revoked — so a tally in there is both
 * a leak and, minutes later, a lie. The page itself is the only place a number
 * is allowed to appear, because that is the only place the visibility rule in
 * ballots.view() is applied.
 *
 * The voter's NAME stays out for the same reason. The page greets them once
 * they open it; a card that says it can be screenshotted by anyone.
 *
 * An unknown or forged token still gets the generic card rather than a 404, so
 * a link mangled in transit shows something sane instead of an error page.
 */
const VOTE_SHELL = require('fs').readFileSync(path.join(__dirname, 'vote', 'index.html'), 'utf8');

const escapeAttr = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

app.get('/v/:token', wrap(async (req, res) => {
  let title = 'A league vote';
  let description = 'Tap to cast your vote.';

  const claim = ballotlink.read(req.params.token);
  if (claim) {
    const ballot = await ballots.byId(claim.ballotId).catch(() => null);
    if (ballot) {
      title = ballot.question;
      const opts = await ballots.optionsFor(ballot.id).catch(() => []);
      // Options, not results. Naming the choices is a fair thing to show
      // someone before they tap; how the others voted is not.
      const listed = opts.map(o => (o.emoji ? o.emoji + ' ' : '') + o.label).join(' · ');
      description = ballot.closed_at ? 'Voting is closed.'
        : listed ? `Tap to vote: ${listed}` : 'Tap to cast your vote.';
    }
  }

  // Rendered rather than templated at build time so the tags cannot drift from
  // the ballot, and so a question edited in the database is right on the next
  // send without a redeploy.
  const html = VOTE_SHELL
    .replace('<meta property="og:title" content="A league vote">',
             `<meta property="og:title" content="${escapeAttr(title)}">`)
    .replace('<meta property="og:description" content="Tap to cast your vote.">',
             `<meta property="og:description" content="${escapeAttr(description)}">`)
    .replace('<title>League vote</title>', `<title>${escapeAttr(title)}</title>`);

  // Apple caches aggressively and a stale question is worse than a slow one.
  res.set('cache-control', 'no-store').type('html').send(html);
}));

/**
 * One answer for every failure.
 *
 * A forged signature, a valid token for a deleted ballot, and a member who was
 * removed from the league all return the same 404. Telling them apart would
 * tell anyone probing which half of a token they had guessed right.
 */
function readBallotToken(req, res) {
  const claim = ballotlink.read(req.params.token);
  if (!claim) { res.status(404).json({ error: 'not_found' }); return null; }
  return claim;
}

app.get('/api/v/:token', wrap(async (req, res) => {
  const claim = readBallotToken(req, res);
  if (!claim) return;
  const view = await ballots.view(claim.ballotId, claim.memberId);
  if (!view) return res.status(404).json({ error: 'not_found' });
  res.json(view);
}));

app.post('/api/v/:token/vote', wrap(async (req, res) => {
  const claim = readBallotToken(req, res);
  if (!claim) return;

  const options = Array.isArray(req.body?.options) ? req.body.options : [];
  const out = await ballots.castVote(claim.ballotId, claim.memberId, options);

  if (!out.ok) {
    // "closed" is a normal thing to happen, not a malformed request — someone
    // tapped a second after the deadline. A distinct status lets the page say
    // that instead of the generic "did not save".
    const status = out.error === 'closed' ? 409
      : (out.error === 'not_eligible' || out.error === 'no_such_ballot') ? 404
      : 400;
    return res.status(status).json({ error: out.error });
  }
  res.json(out.view);
}));

// -------------------------------------------------------------- webhooks ----

/**
 * Linq inbound.
 *
 * Not active — Sendblue remains the primary transport and delivers inbound by
 * polling. This endpoint exists so that switching providers is a configuration
 * change rather than a build, and so the path is exercised by tests before it
 * is ever needed in anger.
 *
 * Unsigned requests are refused. Without that this URL is an open door: anyone
 * who learns it could post a message claiming to come from any number, and the
 * bot would answer it with another league's data.
 */
// --- operator views ---------------------------------------------------------
//
// The highest privilege surface in the system: these read every league's
// private group chat across every tenant. Three things follow from that.
//
// The allowlist is an ENV VAR, not a column. An is_admin flag is one bad UPDATE
// away from privilege escalation, and this database is written to by a worker,
// a web app and a handful of scripts. Changing who is an operator should take a
// deploy or a dashboard visit, not a query.
//
// It FAILS CLOSED. An unset ADMIN_EMAILS makes nobody an operator, including in
// development. The alternative, treating unset as "allow", turns a forgotten
// environment variable into an open door over other people's messages.
//
// And it is layered on requireAccount rather than replacing it, so an operator
// still has to hold a valid Supabase session. The allowlist narrows who may
// pass; it never substitutes for proving who they are.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

if (!ADMIN_EMAILS.size) {
  console.warn('[web] ADMIN_EMAILS is unset, so /api/admin is closed to everyone.');
}

function requireAdmin(req, res, next) {
  const email = String(req.account?.email || '').toLowerCase();
  if (!email || !ADMIN_EMAILS.has(email)) {
    // 404, not 403. A 403 confirms the route exists and that this account is
    // simply not on the list, which is a map of the system for anyone probing.
    return res.status(404).json({ error: 'not_found' });
  }
  return next();
}

const admin = [requireAccount, requireAdmin];

/*
 * Requesting an operator link.
 *
 * Public by necessity, since nobody is signed in yet, and gated anyway. The
 * browser used to call Supabase directly, which meant anyone could make this
 * project send an email by typing an address into the operator page.
 *
 * That matters more than it looks. Supabase's built-in SMTP allows two emails
 * per hour ACROSS THE WHOLE PROJECT, so a stranger hitting that form does not
 * just waste a message, they lock the operator out of signing in at all. The
 * allowlist check has to happen before Supabase is touched, and it has to
 * happen on the server: a browser-side check is bypassed by calling Supabase
 * directly with the anon key, which is public by design.
 *
 * The response is IDENTICAL either way. Saying "not an operator" would turn
 * this into an oracle for which addresses are operators, which is the one piece
 * of information the allowlist exists to protect.
 */
const LINK_MIN_GAP_MS = 60_000;
const linkLastSent = new Map();

app.post('/api/admin/request-link', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const same = { ok: true, message: 'If that address can sign in here, a link is on its way.' };

  if (!email || !ADMIN_EMAILS.has(email)) return res.json(same);

  // Throttled even for a real operator: the project quota is two per hour, so
  // an impatient double click is enough to spend half of it.
  const last = linkLastSent.get(email) || 0;
  if (Date.now() - last < LINK_MIN_GAP_MS) return res.json(same);
  linkLastSent.set(email, Date.now());

  // Fixed origin, never the request's. A redirect built from attacker supplied
  // headers is how an open redirect starts, and Supabase's allowlist is a
  // second line of defence rather than the only one.
  // PUBLIC_ORIGIN wins when set. Otherwise req.protocol, which is only correct
  // because of the trust proxy above: Render forwards over plain http, so
  // without it this built http:// links for an https-only site and Supabase
  // discarded them. req.get('host') is the real public host in production;
  // locally it carries the port, which req.hostname would drop.
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const url = `${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/otp`
            + `?redirect_to=${encodeURIComponent(origin + '/admin/')}`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!r.ok) console.error('[admin] link request failed:', r.status, (await r.text()).slice(0, 200));
    else console.log(`[admin] sign-in link sent to ${email}`);
  } catch (err) {
    console.error('[admin] link request threw:', err.message);
  }

  res.json(same);
}));

/**
 * Who the cohort is: invited, referred, or just turned up.
 *
 * The operator question this whole table exists for. A league with no claim is
 * organic, so this is a left join from leagues and the nulls are the answer.
 */
app.get('/api/admin/promo', admin, wrap(async (req, res) => {
  const promo = require('../src/promo');
  const [codes, leagues] = await Promise.all([
    promo.summary(),
    promo.cohort({ code: req.query?.code || null }),
  ]);
  const counts = leagues.reduce((a, r) => (a[r.arrival] = (a[r.arrival] || 0) + 1, a), {});
  res.json({ codes, leagues, counts });
}));

app.get('/api/admin/overview', admin, wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 365);
  const [replies, decisions, flagRows] = await Promise.all([
    observe.replyRate({ scope: null, days }),
    observe.decisionBreakdown({ scope: null, days }),
    flags.all(),
  ]);
  res.json({ days, replies, decisions, flags: flagRows, dryRunEnv: process.env.REPLY_DRY_RUN === 'true' });
}));

/**
 * The signup funnel: volume, traffic, and where people stop.
 *
 * One request rather than four, because the operator board renders it as a
 * single view and four round trips would let the tiles disagree with the funnel
 * beneath them by a few seconds.
 */
app.get('/api/admin/funnel', admin, wrap(async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  const [tiles, visits, stages, text] = await Promise.all([
    observe.signupTiles([1, 12, 24]),
    observe.visitsByHour(hours),
    observe.funnel(),
    observe.textFlow(),
  ]);
  res.json({ hours, tiles, visits, funnel: stages, textFlow: text });
}));

/** Every conversation, most recent first. Group threads and 1:1 alike. */
app.get('/api/admin/threads', admin, wrap(async (_req, res) => {
  res.json({ conversations: await observe.conversations({ limit: 100 }) });
}));

/**
 * One conversation.
 *
 * The chat id arrives in the query string rather than the path: a Sendblue
 * group handle is fine in a path, but a 1:1 chat id is a phone number in E.164
 * and the leading + does not survive a path segment intact.
 */
app.get('/api/admin/thread', admin, wrap(async (req, res) => {
  const chatId = String(req.query.chatId || '');
  if (!chatId) return res.status(400).json({ error: 'chat_id_required' });
  res.json({ chatId, messages: await observe.conversation(chatId, { limit: 300 }) });
}));

/** Delivery, opt-outs, adoption, staleness, cost. The five that change a decision. */
app.get('/api/admin/ops', admin, wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  res.json(await observe.opsMetrics({ days }));
}));

/** Errors by system, by operation, and over time. */
app.get('/api/admin/errors', admin, wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  res.json(await observe.errors({ days }));
}));

/*
 * The waitlist, and the one action on it.
 *
 * The Signups tab showed COUNTS — last hour, 12, 24, total — so the evidence a
 * league was waiting was a number going from 1 to 2, with no way to see who
 * without opening a terminal. A signup sat unnoticed for eleven hours that way.
 */
/*
 * Asked for and missing: a feature list written by the league.
 *
 * A query, not a log. decisions holds every reply and messages holds every
 * question, so this works on history rather than only on what happens next.
 */
/*
 * Token spend per chat. A query over model_usage, not a scheduled pull: the
 * table is written locally on every call, so there is nothing to fetch and
 * nothing to be stale except the price, which pricing.js flags for itself.
 */
app.get('/api/admin/cost', admin, wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  res.json(await require('../src/observe').costPerChat({ days }));
}));

app.get('/api/admin/gaps', admin, wrap(async (req, res) => {
  const gaps = require('../src/gaps');
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json({ gaps: await gaps.withNames(await gaps.recent({ days, limit: 100 })) });
}));

app.get('/api/admin/signups', admin, wrap(async (_req, res) => {
  const invites = require('../src/invites');
  const { rows: recent } = await db.query(
    `select id, phone, league_name, season, total_rosters, status,
            source, created_at, invited_at, redeemed_at,
            first_name, last_name, email, platform, platform_other, plan
       from signups order by created_at desc limit 50`);

  /*
   * The split, because a per-signup column answers "what did this one pick" and
   * the question is "does anyone pick dynasty" — that decides whether the
   * offseason features are worth building.
   */
  const { rows: planSplit } = await db.query(
    `select coalesce(plan, 'not asked') as plan, count(*)::int as n
       from signups group by 1 order by n desc`);
  /*
   * The latest pre-flight per signup, in one query rather than N.
   *
   * The verdict is computed here rather than in the browser because
   * invites.send() computes it from the same function — a screen that decides
   * "green check" by its own rules would eventually disagree with the gate that
   * actually blocks the send, and the disagreement would look like a bug in the
   * button.
   */
  const preflight = require('../src/preflight');
  const { rows: runs } = await db.query(
    `select distinct on (signup_id) *
       from preflight_runs order by signup_id, started_at desc`);
  const bySignup = new Map(runs.map(r => [r.signup_id, r]));

  const decorate = r => {
    const run = bySignup.get(r.id) || null;
    const v = preflight.verdict(run);
    return {
      ...r,
      ref: r.phone ? String(r.phone).slice(-4) : null,
      preflight: run && {
        id: run.id, status: run.status, startedAt: run.started_at,
        finishedAt: run.finished_at, seasonsFound: run.seasons_found,
        seasonsCaptured: run.seasons_captured, seasonsFailed: run.seasons_failed,
        contextChars: run.context_chars, questions: (run.questions || []).length,
        error: run.error,
      },
      gate: { ok: v.ok, reason: v.reason, overridable: Boolean(v.overridable) },
    };
  };

  res.json({
    planSplit,
    pending: (await invites.pending()).map(decorate),
    // The whole list too, so an invited league does not vanish from the screen
    // the moment it is actioned and leave you wondering whether it worked.
    recent: recent.map(decorate),
  });
}));

/*
 * Start the onboarding pre-flight. Returns immediately with a run id.
 *
 * The work is a chain walk plus seven model calls — about ninety seconds — so
 * this hands back a row to poll rather than holding a request open. A killed
 * process leaves the row `running` and the verdict goes stale on its own after
 * ten minutes, which is a visible state rather than a permanently spinning
 * button.
 */
app.post('/api/admin/signups/:id/preflight', admin, wrap(async (req, res) => {
  const preflight = require('../src/preflight');
  const out = await preflight.start(req.params.id, { byEmail: req.account.email });
  if (!out.run) return res.status(404).json({ error: out.reason || 'not_found' });
  res.status(out.started ? 202 : 200).json({ run: out.run, started: out.started,
    reason: out.reason || null });
}));

/* Poll one signup's latest run, answers and all. */
app.get('/api/admin/signups/:id/preflight', admin, wrap(async (req, res) => {
  const preflight = require('../src/preflight');
  const run = await preflight.latest(req.params.id);
  if (!run) return res.status(404).json({ error: 'no_run' });
  res.json({ run, gate: preflight.verdict(run), questions: preflight.QUESTIONS });
}));

/*
 * Send the setup link. Same funnel as the text reply and the script, so the
 * localhost refusal and the invited_at bookkeeping cannot be skipped by
 * whichever path somebody happens to use.
 */
app.post('/api/admin/signups/:id/invite', admin, wrap(async (req, res) => {
  const invites = require('../src/invites');
  const { SendblueProvider } = require('../src/sendblue');
  const provider = process.env.SENDBLUE_API_KEY_ID
    ? new SendblueProvider(process.env.SENDBLUE_API_KEY_ID, process.env.SENDBLUE_API_SECRET_KEY,
        { fromNumber: process.env.SENDBLUE_FROM_NUMBER })
    : null;

  /*
   * force comes from the operator ticking an override in the browser, and only
   * moves a `thin` verdict. invites.send() decides what force is allowed to
   * skip; this just carries the intent.
   */
  const out = await invites.send(req.params.id, { provider, force: req.body?.force === true });
  if (out.sent) return res.json({ sent: true, signup: out.signup });

  const status = out.error === 'not_found' ? 404
    : out.error === 'localhost_base_url' ? 500
    : String(out.error).startsWith('preflight_') ? 409 : 400;
  res.status(status).json({ error: out.error, detail: out.detail || null,
    overridable: out.overridable || false, run: out.run || null });
}));

/* Decline a signup without texting them anything. */
app.post('/api/admin/signups/:id/decline', admin, wrap(async (req, res) => {
  const { rows } = await db.query(
    `update signups set status = 'declined', updated_at = now()
      where id = $1 returning id, league_name, status`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ declined: true, signup: rows[0] });
}));

app.get('/api/admin/leagues', admin, wrap(async (_req, res) => {
  res.json({ leagues: await observe.leagueList({ scope: null }) });
}));

app.get('/api/admin/leagues/:leagueId/thread', admin, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(await observe.thread({ leagueId: req.params.leagueId, limit }));
}));

app.get('/api/admin/drafts', admin, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 200);
  res.json({ drafts: await observe.draftHistory({ scope: null, leagueId: req.query.leagueId || null, limit }) });
}));

// The one write. Not CRUD: it flips a boolean the worker reads on its next
// poll, and it records who did it.
app.post('/api/admin/flags/replies-paused', admin, wrap(async (req, res) => {
  const paused = req.body?.paused === true;
  await flags.setRepliesPaused(paused, req.account.email);
  res.json({ replies_paused: paused, by: req.account.email });
}));

app.post('/webhooks/linq', wrap(async (req, res) => {
  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'webhook_not_configured' });

  const { LinqProvider } = require('../src/linq');
  const sig = req.get('linq-signature') || req.get('x-linq-signature') || req.get('webhook-signature');

  if (!LinqProvider.verifySignature(req.rawBody || '', sig, secret)) {
    console.warn('[webhook] rejected an unsigned or badly signed Linq payload');
    return res.status(401).json({ error: 'bad_signature' });
  }

  // Acknowledge fast. Providers retry on timeout, and a slow handler turns one
  // message into several.
  res.json({ ok: true });

  try {
    const provider = new LinqProvider(process.env.LINQ_API_KEY, { fromNumber: process.env.LINQ_FROM_NUMBER });
    const msg = provider.parseInbound(req.body);
    if (msg.direction === 'outbound') return;    // never react to ourselves
    const inbound = require('../src/inbound');
    await inbound.handleInbound(msg, provider, { providerName: 'linq', echo: false, source: 'webhook' });
    console.log('[webhook] linq ' + inbound.describe(msg, { stored: true }));
  } catch (err) {
    console.error('[webhook] linq handling failed:', err.message);
  }
}));

// ---------------------------------------------------------------- errors ----

app.use((err, req, res, _next) => {
  console.error('[web] unhandled:', err.message);
  // Stashed rather than recorded here, so the finish handler above writes ONE
  // row with the real message instead of two rows saying different things.
  res.locals.errorMessage = err.message;
  errorlog.record({
    system: 'web',
    operation: `${req.method} ${req.path}`,
    status: 500,
    message: err.message,
    detail: { stack: String(err.stack || '').split('\n').slice(0, 4).join('\n') },
  });
  res.status(500).json({ error: 'server_error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[web] listening on ${PORT}`);
    if (DEV_AUTH) {
      console.warn('[web] ***********************************************');
      console.warn(`[web] DEV_AUTH IS ON — every request is ${process.env.DEV_AUTH_EMAIL}`);
      console.warn('[web] Never set DEV_AUTH in production.');
      console.warn('[web] ***********************************************');
    } else if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.warn('[web] SUPABASE_URL / SUPABASE_ANON_KEY not set — authenticated routes return 503');
    }
  });
}

module.exports = { app };

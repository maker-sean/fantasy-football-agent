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

function fillTokens(html) {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const v = SITE[key];
    if (!v) return loud(key);
    return key === 'SUPPORT_EMAIL' ? mailto(v) : v;
  });
}

// The marketing site ships from the same service. One origin means no CORS to
// configure and no preflight on every authenticated request.
const WEBSITE_DIR = path.join(__dirname, '..', 'website');
const pageCache = new Map();

app.get(/\.html$|^\/$/, (req, res, next) => {
  const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  if (rel.includes('..')) return next();
  const file = path.join(WEBSITE_DIR, rel);
  if (!file.startsWith(WEBSITE_DIR)) return next();

  try {
    let html = pageCache.get(file);
    if (html === undefined) {
      html = fillTokens(require('fs').readFileSync(file, 'utf8'));
      if (process.env.NODE_ENV === 'production') pageCache.set(file, html);
    }
    res.type('html').send(html);
  } catch {
    next();      // not a page we serve; fall through to static
  }
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
  res.json({ ok: true, db: rows[0].now, devAuth: Boolean(DEV_AUTH) });
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
app.post('/api/signup-intent', wrap(async (req, res) => {
  const sleeperLeagueId = String(req.body?.sleeperLeagueId || '').trim();
  if (!/^\d{6,25}$/.test(sleeperLeagueId)) return res.status(400).json({ error: 'bad_league_id' });

  const lg = await sleeper.league(sleeperLeagueId).catch(() => null);
  if (!lg?.league_id) return res.status(404).json({ error: 'league_not_found' });

  const signup = require('../src/signup');
  const issued = await signup.issueCode({ sleeperLeagueId, league: lg });

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

  res.json({
    code: issued.code,
    keyword: signup.KEYWORD,
    body,
    number,
    smsUri,
    qrSvg,
    league: { name: lg.name, season: lg.season, totalRosters: lg.total_rosters },
  });
}));

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

  const signup = require('../src/signup');
  const out = await signup.record({ email, leagueId: sleeperLeagueId, source: 'web' });
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

  // Same league, same account, twice: resume rather than duplicate.
  const existing = (await db.leaguesForAccount(req.account.id))
    .find(l => l.sleeper_league_id === sleeperLeagueId);
  if (existing) return res.json({ league: existing, resumed: true });

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
  const byUser = new Map(members.map(m => [m.sleeper_user_id, m]));

  res.json({
    league: { id: req.league.id, name: req.league.name, state: req.league.onboarding_state },
    rosters: owners.map(o => {
      const m = byUser.get(o.sleeperUserId);
      return {
        sleeperUserId: o.sleeperUserId,
        sleeperRosterId: o.sleeperRosterId,
        teamName: o.displayName,
        humanName: m?.display_name || null,
        // Never return the stored number. The commissioner typed it; echoing it
        // back to any future session is a needless way to leak it.
        hasPhone: Boolean(m?.phone),
        locked: Boolean(m?.locked),
      };
    }),
  });
}));

app.post('/api/leagues/:leagueId/members', requireAccount, loadLeague, wrap(async (req, res) => {
  const entries = Array.isArray(req.body?.members) ? req.body.members : [];
  if (!entries.length) return res.status(400).json({ error: 'no_members' });

  const results = [];
  for (const e of entries) {
    if (!e.sleeperUserId) continue;
    const phone = e.phone ? db.normalizePhone(e.phone) : null;
    if (e.phone && !/^\+\d{10,15}$/.test(phone || '')) {
      results.push({ sleeperUserId: e.sleeperUserId, outcome: 'bad_phone' });
      continue;
    }
    const out = await db.bindMember(req.league.id, {
      phone,
      sleeperUserId: e.sleeperUserId,
      sleeperRosterId: e.sleeperRosterId,
      displayName: e.humanName || null,
      boundBy: `account:${req.account.id}`,
      boundVia: 'onboarding',
      // The commissioner is the authority for their own league — this is the
      // override path that exists precisely so a mistyped number is fixable.
      force: true,
    });
    results.push({ sleeperUserId: e.sleeperUserId, outcome: out.outcome });
  }

  if (req.league.onboarding_state === 'league_linked') {
    await db.setOnboardingState(req.league.id, 'members_bound');
  }
  res.json({ results });
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

app.get('/api/admin/overview', admin, wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 365);
  const [replies, decisions, flagRows] = await Promise.all([
    observe.replyRate({ scope: null, days }),
    observe.decisionBreakdown({ scope: null, days }),
    flags.all(),
  ]);
  res.json({ days, replies, decisions, flags: flagRows, dryRunEnv: process.env.REPLY_DRY_RUN === 'true' });
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

app.use((err, _req, res, _next) => {
  console.error('[web] unhandled:', err.message);
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

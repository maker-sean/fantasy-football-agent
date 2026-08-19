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

// The marketing site ships from the same service. One origin means no CORS to
// configure and no preflight on every authenticated request.
app.use(express.static(path.join(__dirname, '..', 'website'), { extensions: ['html'] }));
app.use('/app', express.static(path.join(__dirname, 'app'), { extensions: ['html'] }));

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

async function requireAccount(req, res, next) {
  try {
    if (DEV_AUTH) {
      req.account = await db.upsertAccount({ email: process.env.DEV_AUTH_EMAIL });
      return next();
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(503).json({ error: 'auth_not_configured' });
    }

    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

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

/**
 * Postgres access via a plain connection string.
 *
 * Supabase today, but nothing here is Supabase-specific — same reasoning as
 * the MessagingProvider seam. Set DATABASE_URL to the Supabase connection
 * string (Project Settings -> Database -> Connection string -> URI, session
 * pooler) and this moves to Neon or RDS unchanged.
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  // Supabase requires TLS; it presents a cert chain node doesn't ship a root for.
  ssl: connectionString && /supabase|neon|amazonaws/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
  max: Number(process.env.PG_POOL_MAX || 5),
});

pool.on('error', err => console.error('[db] idle client error:', err.message));

function assertConfigured() {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
      '  Supabase -> Project Settings -> Database -> Connection string (URI)\n' +
      '  Then add to .env:  DATABASE_URL=postgresql://...'
    );
  }
}

async function query(text, params = []) {
  assertConfigured();
  return pool.query(text, params);
}

/** Normalized E.164 is the identity anchor — never a provider contact id. */
function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return s || null;
}

// ------------------------------------------------------------- leagues ----

async function leagueByChat(provider, chatId) {
  if (!chatId) return null;
  const { rows } = await query(
    'select * from leagues where provider = $1 and chat_id = $2 and active limit 1',
    [provider, chatId]
  );
  return rows[0] || null;
}

async function leagueById(id) {
  const { rows } = await query('select * from leagues where id = $1', [id]);
  return rows[0] || null;
}

async function activeLeagues() {
  const { rows } = await query(
    'select * from leagues where active and sleeper_league_id is not null order by created_at'
  );
  return rows;
}

async function upsertLeague({ name, sleeperLeagueId, provider = 'sendblue', chatId, fromNumber }) {
  const { rows } = await query(
    `insert into leagues (name, sleeper_league_id, provider, chat_id, from_number)
     values ($1, $2, $3, $4, $5)
     on conflict (provider, chat_id) where chat_id is not null
     do update set name = excluded.name,
                   sleeper_league_id = coalesce(excluded.sleeper_league_id, leagues.sleeper_league_id),
                   from_number = coalesce(excluded.from_number, leagues.from_number)
     returning *`,
    [name, sleeperLeagueId || null, provider, chatId || null, fromNumber || null]
  );
  return rows[0];
}

// ------------------------------------------------------------- members ----

async function upsertMember(leagueId, { phone, sleeperUserId, sleeperRosterId, displayName, isBot = false }) {
  const normalized = normalizePhone(phone);
  const { rows } = await query(
    `insert into members (league_id, phone, sleeper_user_id, sleeper_roster_id, display_name, is_bot)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (league_id, phone) where phone is not null
     do update set display_name = coalesce(excluded.display_name, members.display_name),
                   sleeper_user_id = coalesce(excluded.sleeper_user_id, members.sleeper_user_id),
                   sleeper_roster_id = coalesce(excluded.sleeper_roster_id, members.sleeper_roster_id)
     returning *`,
    [leagueId, normalized, sleeperUserId || null, sleeperRosterId ?? null, displayName || null, isBot]
  );
  return rows[0];
}

// ------------------------------------------------------------ messages ----

/**
 * Idempotent on (provider, provider_message_id). Webhook retries are normal;
 * counting one reply three times would corrupt the Phase 2 engagement metric.
 */
async function recordMessage(msg) {
  const { rows } = await query(
    `insert into messages
       (league_id, provider, provider_message_id, direction, chat_id,
        sender_phone, is_group, protocol, body, raw, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (provider, provider_message_id) where provider_message_id is not null
     do nothing
     returning *`,
    [
      msg.leagueId || null,
      msg.provider,
      msg.providerMessageId || null,
      msg.direction,
      msg.chatId || null,
      normalizePhone(msg.senderPhone),
      Boolean(msg.isGroup),
      msg.protocol || null,
      msg.body ?? null,
      msg.raw || {},
      msg.occurredAt ? new Date(msg.occurredAt) : new Date(),
    ]
  );
  return rows[0] || null; // null means duplicate — already recorded
}

// ----------------------------------------------------------- snapshots ----

/**
 * Insert-only. If a snapshot for this (league, season, week, kind) already
 * exists, the original wins — a later re-run must never overwrite the state
 * captured at the real kickoff moment.
 */
async function recordSnapshot({ leagueId, season, week, kind, payload }) {
  const { rows } = await query(
    `insert into snapshots (league_id, season, week, kind, payload)
     values ($1,$2,$3,$4,$5)
     on conflict (league_id, season, week, kind) do nothing
     returning *`,
    [leagueId, String(season), Number(week), kind, payload]
  );
  return rows[0] || null; // null means one already existed and was preserved
}

async function listSnapshots(leagueId, season) {
  const { rows } = await query(
    `select id, season, week, kind, captured_at,
            pg_column_size(payload) as payload_bytes
     from snapshots where league_id = $1 and season = $2
     order by week, captured_at`,
    [leagueId, String(season)]
  );
  return rows;
}

// ------------------------------------------------------------- players ----

async function upsertPlayers(players) {
  if (!players.length) return 0;
  // Single round trip via unnest — 11k individual inserts would be absurd.
  const ids = players.map(p => p.player_id);
  const names = players.map(p => p.full_name);
  const positions = players.map(p => p.position);
  const teams = players.map(p => p.team);

  await query(
    `insert into players (player_id, full_name, position, team, updated_at)
     select p.player_id, p.full_name, p.position, p.team, now()
     from unnest($1::text[], $2::text[], $3::text[], $4::text[])
       as p(player_id, full_name, position, team)
     on conflict (player_id) do update
       set full_name = excluded.full_name,
           position  = excluded.position,
           team      = excluded.team,
           updated_at = now()`,
    [ids, names, positions, teams]
  );
  return players.length;
}

// ------------------------------------------------------------ job_runs ----

async function startJob(job) {
  const { rows } = await query(
    `insert into job_runs (job, status) values ($1, 'ok') returning id`,
    [job]
  );
  return rows[0].id;
}

async function finishJob(id, status, detail = {}) {
  await query(
    `update job_runs set status = $2, detail = $3, finished_at = now() where id = $1`,
    [id, status, detail]
  );
}

async function recentJobs(limit = 20) {
  const { rows } = await query(
    `select job, status, detail, started_at, finished_at
     from job_runs order by started_at desc limit $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  pool, query, normalizePhone,
  leagueByChat, leagueById, activeLeagues, upsertLeague,
  upsertMember,
  recordMessage,
  recordSnapshot, listSnapshots,
  upsertPlayers,
  startJob, finishJob, recentJobs,
};

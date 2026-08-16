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

/**
 * Bind a phone to a Sleeper user — WRITE ONCE.
 *
 * The phone is verified (it comes from the transport). Which team it belongs to
 * is a claim, and in a group chat anyone can make one. Observed in this very
 * league: the same number said "This is Marcus" and, four days later, "this is
 * Sean." If the last claim wins, a member can take over someone else's identity
 * and the bot will confidently misattribute their team and record.
 *
 * So a binding is refused rather than overwritten. Display names stay editable —
 * "Marcus" to "Marc" is cosmetic and carries no authority.
 *
 * @returns { member, outcome, existing }
 *   outcome: 'bound' | 'unchanged' | 'rejected_phone_taken' | 'rejected_team_taken'
 */
async function bindMember(leagueId, { phone, sleeperUserId, sleeperRosterId, displayName, boundBy = 'cli', boundVia = 'manual', force = false }) {
  const normalized = normalizePhone(phone);

  const { rows: existingRows } = await query(
    `select * from members where league_id = $1 and (phone = $2 or sleeper_user_id = $3)`,
    [leagueId, normalized, sleeperUserId || null]
  );

  const byPhone = existingRows.find(r => r.phone === normalized);
  const byUser = existingRows.find(r => r.sleeper_user_id && r.sleeper_user_id === sleeperUserId);

  // Already exactly this pairing — a name update is fine.
  if (byPhone && byPhone.sleeper_user_id === sleeperUserId) {
    if (displayName && displayName !== byPhone.display_name) {
      const { rows } = await query(
        'update members set display_name = $2 where id = $1 returning *',
        [byPhone.id, displayName]
      );
      return { member: rows[0], outcome: 'unchanged', existing: byPhone };
    }
    return { member: byPhone, outcome: 'unchanged', existing: byPhone };
  }

  if (!force) {
    // This phone is already someone. Refuse to move it.
    if (byPhone && byPhone.sleeper_user_id && byPhone.locked) {
      return { member: null, outcome: 'rejected_phone_taken', existing: byPhone };
    }
    // This team already belongs to a different phone.
    if (byUser && byUser.phone && byUser.phone !== normalized && byUser.locked) {
      return { member: null, outcome: 'rejected_team_taken', existing: byUser };
    }
  }

  // Clear any conflicting rows only when explicitly forced (commissioner).
  if (force) {
    if (byUser && byUser.phone !== normalized) {
      await query('update members set sleeper_user_id = null, sleeper_roster_id = null where id = $1', [byUser.id]);
    }
  }

  const { rows } = await query(
    `insert into members (league_id, phone, sleeper_user_id, sleeper_roster_id, display_name,
                          bound_at, bound_by, bound_via)
     values ($1,$2,$3,$4,$5, now(), $6, $7)
     on conflict (league_id, phone) where phone is not null
     do update set sleeper_user_id   = excluded.sleeper_user_id,
                   sleeper_roster_id = excluded.sleeper_roster_id,
                   display_name      = coalesce(excluded.display_name, members.display_name),
                   bound_at = now(), bound_by = excluded.bound_by, bound_via = excluded.bound_via
     returning *`,
    [leagueId, normalized, sleeperUserId || null, sleeperRosterId ?? null,
     displayName || null, boundBy, boundVia]
  );
  return { member: rows[0], outcome: force && byPhone ? 'rebound' : 'bound', existing: byPhone || byUser || null };
}

/** Record every identity claim, accepted or not. Rejections are the useful ones. */
async function recordClaim({ leagueId, phone, claimedText, matchedUser, matchedTeam, outcome, detail = {} }) {
  const { rows } = await query(
    `insert into identity_claims (league_id, phone, claimed_text, matched_user, matched_team, outcome, detail)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [leagueId, normalizePhone(phone), claimedText || null, matchedUser || null,
     matchedTeam || null, outcome, detail]
  );
  return rows[0];
}

/** Cosmetic only — never touches which team a phone belongs to. */
async function renameMember(leagueId, phone, displayName) {
  const { rows } = await query(
    'update members set display_name = $3 where league_id = $1 and phone = $2 returning *',
    [leagueId, normalizePhone(phone), displayName]
  );
  return rows[0] || null;
}

/** Back-compat shim; new code should call bindMember. */
async function upsertMember(leagueId, opts) {
  const { member } = await bindMember(leagueId, { ...opts, boundVia: opts.boundVia || 'legacy' });
  return member;
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
  upsertMember, bindMember, renameMember, recordClaim,
  recordMessage,
  recordSnapshot, listSnapshots,
  upsertPlayers,
  startJob, finishJob, recentJobs,
};

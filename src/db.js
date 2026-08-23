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

// -------------------------------------------------------- suppressions ----

/**
 * Record that a number asked us to stop. Idempotent — a second STOP is the
 * same person, not a new fact.
 */
async function suppress(phone, { reason = 'stop', rawText = null, provider = null } = {}) {
  const { rows } = await query(
    `insert into suppressions (phone, reason, raw_text, provider)
     values ($1,$2,$3,$4)
     on conflict (phone) do update
       set opted_out_at = now(), opted_in_at = null,
           reason = excluded.reason, raw_text = excluded.raw_text
     returning *`,
    [normalizePhone(phone), reason, rawText, provider]
  );
  return rows[0];
}

/** Opt back in. The row stays, so the history of a no is never erased. */
async function unsuppress(phone) {
  const { rows } = await query(
    'update suppressions set opted_in_at = now() where phone = $1 returning *',
    [normalizePhone(phone)]
  );
  return rows[0] || null;
}

async function isSuppressed(phone) {
  const { rows } = await query(
    'select 1 from suppressions where phone = $1 and opted_in_at is null limit 1',
    [normalizePhone(phone)]
  );
  return rows.length > 0;
}

// ------------------------------------------------------------ accounts ----

async function upsertAccount({ email, authUserId = null, displayName = null }) {
  const { rows } = await query(
    `insert into accounts (email, auth_user_id, display_name)
     values ($1,$2,$3)
     -- The predicate is required, not decorative: accounts_email_idx became
     -- PARTIAL when phone-anchored accounts arrived (0016), and Postgres cannot
     -- infer a partial index without being told its WHERE. Omit it and every
     -- email sign-in fails at runtime with "no unique or exclusion constraint
     -- matching the ON CONFLICT specification".
     on conflict (lower(email)) where email is not null do update
       set auth_user_id = coalesce(excluded.auth_user_id, accounts.auth_user_id),
           display_name = coalesce(excluded.display_name, accounts.display_name),
           updated_at = now()
     returning *`,
    [String(email).trim(), authUserId, displayName]
  );
  return rows[0];
}

async function accountByEmail(email) {
  const { rows } = await query('select * from accounts where lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

/**
 * The account behind a texted signup.
 *
 * Phone-anchored rather than email-anchored, because the phone is what the
 * signup funnel actually verified — see 0016_account_phone.sql. Normalised on
 * the way in for the same reason every other phone in this codebase is: the
 * same human writes their number four different ways.
 */
async function accountByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const { rows } = await query('select * from accounts where phone = $1', [p]);
  return rows[0] || null;
}

/**
 * Create-or-return the account for a phone.
 *
 * The conflict target names the index predicate because accounts_phone_idx is
 * PARTIAL. Without the `where`, Postgres cannot infer which index to arbitrate
 * on and the insert fails at runtime rather than at deploy — the kind of thing
 * that only shows up the second time somebody signs up.
 */
async function upsertAccountByPhone({ phone, displayName = null }) {
  const p = normalizePhone(phone);
  if (!p) throw new Error('a phone-anchored account needs a phone');
  const { rows } = await query(
    `insert into accounts (phone, display_name)
     values ($1,$2)
     on conflict (phone) where phone is not null do update
       set display_name = coalesce(excluded.display_name, accounts.display_name),
           updated_at = now()
     returning *`,
    [p, displayName]
  );
  return rows[0];
}

async function accountByAuthId(authUserId) {
  const { rows } = await query('select * from accounts where auth_user_id = $1', [authUserId]);
  return rows[0] || null;
}

async function acceptTerms(accountId, version) {
  const { rows } = await query(
    `update accounts set terms_accepted_at = now(), terms_version = $2, updated_at = now()
     where id = $1 returning *`,
    [accountId, version]
  );
  return rows[0] || null;
}

/**
 * Every league belonging to one account. THIS is what web requests use.
 *
 * The distinction from activeLeagues() below is the whole point of the tenancy
 * migration: one is scoped to a signed-in commissioner, the other deliberately
 * is not. Getting them confused in a request handler leaks another league's
 * data, and nothing about the return type would reveal the mistake.
 */
async function leaguesForAccount(accountId) {
  const { rows } = await query(
    `select l.*, s.status as subscription_status, s.current_period_end
       from leagues l
       left join subscriptions s on s.league_id = l.id
      where l.account_id = $1
      order by l.created_at`,
    [accountId]
  );
  return rows;
}

/**
 * One league, but only if this account owns it.
 *
 * Takes the account id as a REQUIRED argument rather than an optional filter,
 * so a handler cannot forget it and silently get someone else's row.
 */
async function leagueForAccount(accountId, leagueId) {
  const { rows } = await query(
    'select * from leagues where id = $1 and account_id = $2',
    [leagueId, accountId]
  );
  return rows[0] || null;
}

async function setOnboardingState(leagueId, state, extra = {}) {
  const { rows } = await query(
    `update leagues
        set onboarding_state = $2,
            chat_id = coalesce($3, chat_id),
            chat_linked_at = case when $2 = 'live' then coalesce(chat_linked_at, now()) else chat_linked_at end
      where id = $1
      returning *`,
    [leagueId, state, extra.chatId || null]
  );
  return rows[0] || null;
}

/** Leagues parked on the "add the number to your chat" screen, awaiting proof. */
async function leaguesAwaitingChat() {
  const { rows } = await query(
    `select * from leagues where onboarding_state = 'awaiting_chat' and active`
  );
  return rows;
}

async function upsertSubscription({ leagueId, accountId, stripeSubscriptionId = null, status = 'none', currentPeriodEnd = null, season = null }) {
  const { rows } = await query(
    `insert into subscriptions (league_id, account_id, stripe_subscription_id, status, current_period_end, season)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (league_id) do update
       set stripe_subscription_id = coalesce(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
           status = excluded.status,
           current_period_end = excluded.current_period_end,
           updated_at = now()
     returning *`,
    [leagueId, accountId, stripeSubscriptionId, status, currentPeriodEnd, season]
  );
  return rows[0];
}

/**
 * Cross-tenant BY DESIGN. The worker legitimately processes every league:
 * snapshots, injury alerts, trade polling and recaps all run for everyone.
 *
 * Never call this from a request handler. Use leaguesForAccount().
 */
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
async function bindMember(leagueId, { phone, sleeperUserId, sleeperRosterId, displayName,
                                      username = null, teamName = null,
                                      boundBy = 'cli', boundVia = 'manual', force = false }) {
  const normalized = normalizePhone(phone);

  /*
   * Automation may refresh Sleeper's labels. It may never touch the human name.
   *
   * members:sync used to call this once a night with the TEAM name as
   * displayName, so a commissioner typed "Marcus" and woke up to a bot calling
   * him "Big Yardage" in every recap. The guard lives here rather than at the call
   * site because there is more than one caller and only one of them is a
   * person.
   */
  const fromAutomation = boundVia === 'legacy' || boundVia === 'sync';
  if (fromAutomation) displayName = null;

  const { rows: existingRows } = await query(
    `select * from members where league_id = $1 and (phone = $2 or sleeper_user_id = $3)`,
    [leagueId, normalized, sleeperUserId || null]
  );

  const byPhone = existingRows.find(r => r.phone === normalized);
  const byUser = existingRows.find(r => r.sleeper_user_id && r.sleeper_user_id === sleeperUserId);

  /*
   * Already exactly this pairing — refresh the labels and leave the binding be.
   *
   * The Sleeper columns have to be updated HERE and not only in the insert
   * below. This branch returns early, and the nightly sync hits it on every run
   * for every member who has not changed teams — which is nearly all of them.
   * Updating them only in the insert meant sleeper_username and team_name were
   * written exactly once, at first bind, and then never refreshed again.
   */
  if (byPhone && byPhone.sleeper_user_id === sleeperUserId) {
    const nextName = (displayName && displayName !== byPhone.display_name)
      ? displayName : byPhone.display_name;
    const { rows } = await query(
      `update members
          set display_name     = $2,
              sleeper_username = coalesce($3, sleeper_username),
              team_name        = coalesce($4, team_name)
        where id = $1 returning *`,
      [byPhone.id, nextName, username, teamName]
    );
    return { member: rows[0], outcome: 'unchanged', existing: byPhone };
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
                          sleeper_username, team_name, bound_at, bound_by, bound_via)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9)
     on conflict (league_id, phone) where phone is not null
     do update set sleeper_user_id   = excluded.sleeper_user_id,
                   sleeper_roster_id = excluded.sleeper_roster_id,
                   display_name      = coalesce(excluded.display_name, members.display_name),
                   -- Sleeper owns these two, so the freshest value wins.
                   sleeper_username  = coalesce(excluded.sleeper_username, members.sleeper_username),
                   team_name         = coalesce(excluded.team_name, members.team_name),
                   bound_at = now(), bound_by = excluded.bound_by, bound_via = excluded.bound_via
     returning *`,
    [leagueId, normalized, sleeperUserId || null, sleeperRosterId ?? null,
     displayName || null, username, teamName, boundBy, boundVia]
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
/**
 * Phones bound to a roster in this league, normalized.
 *
 * This is the allowlist the reply gate reads. A number that is not in here is
 * not a league member as far as the bot is concerned, whatever it says.
 */
async function boundPhones(leagueId) {
  const { rows } = await query(
    `select phone from members
     where league_id = $1 and phone is not null and sleeper_roster_id is not null`,
    [leagueId]
  );
  return new Set(rows.map(r => r.phone));
}

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
  const injuries = players.map(p => p.injury_status ?? null);
  const parts = players.map(p => p.injury_body_part ?? null);
  const statuses = players.map(p => p.player_status ?? null);

  await query(
    `insert into players (player_id, full_name, position, team,
                          injury_status, injury_body_part, player_status, updated_at)
     select p.player_id, p.full_name, p.position, p.team,
            p.injury_status, p.injury_body_part, p.player_status, now()
     from unnest($1::text[], $2::text[], $3::text[], $4::text[],
                 $5::text[], $6::text[], $7::text[])
       as p(player_id, full_name, position, team,
            injury_status, injury_body_part, player_status)
     on conflict (player_id) do update
       set full_name        = excluded.full_name,
           position         = excluded.position,
           team             = excluded.team,
           injury_status    = excluded.injury_status,
           injury_body_part = excluded.injury_body_part,
           player_status    = excluded.player_status,
           updated_at = now()`,
    [ids, names, positions, teams, injuries, parts, statuses]
  );
  return players.length;
}

// --------------------------------------------------------------- games ----

async function upsertGames(games) {
  if (!games.length) return 0;
  for (const g of games) {
    await query(
      `insert into games (espn_id, season, week, kickoff_at, home_team, away_team,
                          short_name, state, neutral_site, venue, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (espn_id) do update
         set kickoff_at = excluded.kickoff_at,
             state      = excluded.state,
             short_name = excluded.short_name,
             venue      = excluded.venue,
             updated_at = now()`,
      [g.espnId, g.season, g.week, g.kickoffAt, g.homeTeam, g.awayTeam,
       g.shortName, g.state, g.neutralSite, g.venue]
    );
  }
  return games.length;
}

/** Games that have not kicked off yet, soonest first. */
async function upcomingGames(season, week, withinMs = null) {
  const { rows } = await query(
    `select * from games
     where season = $1 and week = $2 and kickoff_at > now()
       and ($3::bigint is null or kickoff_at <= now() + ($3 || ' milliseconds')::interval)
     order by kickoff_at`,
    [String(season), Number(week), withinMs == null ? null : String(withinMs)]
  );
  return rows;
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
  // A scheduled job that failed is the class of error nobody is watching when
  // it happens — it runs at 9am on a Tuesday and the only trace was a row in
  // job_runs nobody queries.
  if (status === 'error') {
    require('./errorlog').record({
      system: 'worker',
      operation: detail.job || 'job',
      message: detail.error || 'job failed',
      detail,
    });
  }
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

/**
 * The live league for a Sleeper id, whoever owns it.
 *
 * Deliberately NOT scoped to an account, which is what the onboarding endpoint
 * was doing: it resumed correctly for the same person and let a different one
 * create a second row for the same league. Archive rows are excluded because
 * history.js writes one per past season and they share the id space by design.
 */
async function liveLeagueBySleeperId(sleeperLeagueId) {
  if (!sleeperLeagueId) return null;
  const { rows } = await query(
    `select * from leagues
      where sleeper_league_id = $1 and provider <> 'archive'
      limit 1`, [String(sleeperLeagueId)]);
  return rows[0] || null;
}

module.exports = {
  liveLeagueBySleeperId,
  pool, query, normalizePhone,
  leagueByChat, leagueById, activeLeagues, upsertLeague,
  upsertMember, bindMember, renameMember, recordClaim, boundPhones,
  suppress, unsuppress, isSuppressed,
  upsertAccount, accountByEmail, accountByAuthId, accountByPhone,
  upsertAccountByPhone, acceptTerms,
  leaguesForAccount, leagueForAccount, setOnboardingState, leaguesAwaitingChat,
  upsertSubscription,
  recordMessage,
  recordSnapshot, listSnapshots,
  upsertPlayers, upsertGames, upcomingGames,
  startJob, finishJob, recentJobs,
};

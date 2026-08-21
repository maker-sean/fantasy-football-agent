/**
 * Read models for the operator view.
 *
 * Every function takes an explicit `scope`: null means every league, which is
 * the operator path, and an array of league ids means exactly those. That
 * parameter is the whole reason this file exists separately from a pile of SQL
 * in the route handler.
 *
 * The point is the same one src/db.js makes about leaguesForAccount versus
 * activeLeagues: a cross-tenant read has to be asked for, never defaulted into.
 * Some of these views may become commissioner-facing later, and when they do,
 * the tenant boundary is a scope argument at the query layer rather than a
 * filter someone remembers to apply in a template. Forgetting a filter in a
 * template looks completely normal in review. Forgetting to pass a scope here
 * reads every league, which is why null has to be written out.
 *
 * Nothing in here writes. The control plane lives in src/flags.js.
 */

const db = require('./db');

/** `scope` -> a WHERE fragment plus its parameter. null means unscoped. */
function scoped(scope, col = 'league_id', idx = 1) {
  if (scope === null || scope === undefined) return { sql: 'true', params: [] };
  if (!Array.isArray(scope)) throw new Error('scope must be an array of league ids or null');
  return { sql: `${col} = any($${idx}::uuid[])`, params: [scope] };
}

/**
 * Did anyone answer it?
 *
 * The metric that decides whether this product is real: a bot nobody replies to
 * is a notification, not a league member. Counted per outbound message, with a
 * reply being any inbound in the same chat inside the window.
 */
async function replyRate({ scope = null, days = 7, windowMinutes = 15 } = {}) {
  const s = scoped(scope, 'o.league_id', 3);
  const { rows } = await db.query(
    `select
       count(*)::int                                     as bot_messages,
       count(*) filter (where t.answered)::int           as answered
     from (
       select o.id, exists (
         select 1 from messages i
          where i.league_id = o.league_id
            and i.chat_id   = o.chat_id
            and i.direction = 'inbound'
            and i.occurred_at >  o.occurred_at
            and i.occurred_at <= o.occurred_at + ($2 || ' minutes')::interval
       ) as answered
       from messages o
       where o.direction = 'outbound'
         and o.occurred_at > now() - ($1 || ' days')::interval
         and ${s.sql}
     ) t`,
    [String(days), String(windowMinutes), ...s.params]
  );
  const r = rows[0] || { bot_messages: 0, answered: 0 };
  return { ...r, rate: r.bot_messages ? r.answered / r.bot_messages : null, days, windowMinutes };
}

/**
 * Why it stayed quiet.
 *
 * The companion to replyRate and the more useful of the two when something is
 * wrong. A low reply rate says the product might be failing. This says whether
 * the bot is being addressed and declining to answer, and which layer decided
 * that, which is a completely different problem with a completely different fix.
 */
async function decisionBreakdown({ scope = null, days = 7 } = {}) {
  const s = scoped(scope, 'league_id', 2);
  const { rows } = await db.query(
    `select layer, decision, reason, count(*)::int as n,
            round(avg(latency_ms))::int as avg_latency_ms
       from decisions
      where created_at > now() - ($1 || ' days')::interval
        and ${s.sql}
      group by layer, decision, reason
      order by n desc`,
    [String(days), ...s.params]
  );
  return rows;
}

/** Every league with enough context to decide which one to open. */
async function leagueList({ scope = null } = {}) {
  const s = scoped(scope, 'l.id', 1);
  const { rows } = await db.query(
    `select l.id, l.name, l.season, l.provider, l.onboarding_state, l.chat_id,
            l.config,
            (select count(*) from members m
              where m.league_id = l.id and m.phone is not null
                and m.sleeper_user_id is not null)::int          as bound_members,
            (select count(*) from members m where m.league_id = l.id)::int as total_members,
            (select count(*) from messages g where g.league_id = l.id)::int as messages,
            (select max(occurred_at) from messages g where g.league_id = l.id) as last_message_at,
            (select count(*) from recap_drafts d
              where d.league_id = l.id and d.status = 'pending')::int as pending_drafts
       from leagues l
      where ${s.sql}
      order by last_message_at desc nulls last, l.name`,
    s.params
  );
  return rows;
}

/**
 * One league's thread, with the decision that produced each bot message
 * attached to it.
 *
 * The join is the entire point. A chat replay on its own tells you nothing you
 * could not get by asking a league member for a screenshot; what you actually
 * need is why each message exists, and for the silences, why they do not.
 *
 * Silent decisions are returned as rows too. They have no message, so they
 * appear in the timeline as gaps with reasons, which is the only way to tell a
 * suppressed reply from a dry run from a worker that fell over.
 */
async function thread({ leagueId, limit = 200 } = {}) {
  if (!leagueId) throw new Error('thread requires a leagueId');

  const [{ rows: messages }, { rows: decisions }] = await Promise.all([
    db.query(
      `select id, direction, chat_id, sender_phone, protocol, body, occurred_at
         from messages
        where league_id = $1
        order by occurred_at desc
        limit $2`,
      [leagueId, limit]
    ),
    db.query(
      `select id, layer, decision, reason, detail, latency_ms, replied_text,
              trigger_message_id, message_count, created_at
         from decisions
        where league_id = $1
        order by created_at desc
        limit $2`,
      [leagueId, limit]
    ),
  ]);

  return {
    messages: messages.reverse(),
    decisions: decisions.reverse(),
  };
}

/**
 * Generated recaps and what the verifier made of them.
 *
 * facts and verification are already stored per draft, so this is the closest
 * thing to "why did it say that" the system can answer without replaying: the
 * exact inputs, the objections, the model, and the commit whose PERSONA and
 * factsBlock turn those facts back into the literal prompt.
 */
async function draftHistory({ scope = null, leagueId = null, limit = 25 } = {}) {
  const where = [];
  const params = [String(limit)];
  if (leagueId) { params.push(leagueId); where.push(`d.league_id = $${params.length}`); }
  else {
    const s = scoped(scope, 'd.league_id', 2);
    if (s.params.length) { params.push(...s.params); }
    where.push(s.sql);
  }
  const { rows } = await db.query(
    `select d.id, d.league_id, l.name as league_name, d.season, d.week, d.kind,
            d.body, d.facts, d.verification, d.model, d.usage, d.prompt_sha,
            d.status, d.created_at, d.decided_at, d.decided_by
       from recap_drafts d
       join leagues l on l.id = d.league_id
      where ${where.join(' and ')}
      order by d.created_at desc
      limit $1`,
    params
  );
  return rows;
}

module.exports = { replyRate, decisionBreakdown, leagueList, thread, draftHistory, scoped };

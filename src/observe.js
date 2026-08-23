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
            -- Roster, not Sleeper user. This must match db.boundPhones exactly:
            -- that is the reply gate, and a co-owner has no Sleeper account of
            -- their own. Counting sleeper_user_id here would report a league as
            -- half-bound while the bot happily answered everybody in it.
            (select count(*) from members m
              where m.league_id = l.id and m.phone is not null
                and m.sleeper_roster_id is not null)::int         as bound_members,
            (select count(*) from members m where m.league_id = l.id)::int as total_members,
            (select count(*) from messages g where g.league_id = l.id)::int as messages,
            (select count(*) from messages g
              where g.league_id = l.id and g.direction = 'inbound')::int  as inbound,
            (select count(*) from messages g
              where g.league_id = l.id and g.direction = 'outbound')::int as outbound,
            (select min(occurred_at) from messages g where g.league_id = l.id) as first_message_at,
            (select max(occurred_at) from messages g where g.league_id = l.id) as last_message_at,
            (select count(*) from recap_drafts d
              where d.league_id = l.id and d.status = 'pending')::int as pending_drafts
       from leagues l
      where ${s.sql}
      order by last_message_at desc nulls last, l.name`,
    s.params
  );

  return rows.map(r => ({
    ...r,
    /*
     * How much talking a send provokes.
     *
     * Deliberately a RATIO of inbound to outbound rather than an attempt to
     * attribute individual replies to individual sends. Group chat has no
     * threading — people answer four messages later, or answer each other —
     * so any attribution would be a guess dressed as a measurement. The ratio
     * is crude and honest: above 1 means the league talks back more than the
     * bot talks, which is the shape of a chat people are actually using.
     *
     * Null rather than zero when nothing has been sent, so a brand new league
     * does not report as the worst performing one.
     */
    responses_per_send: r.outbound > 0 ? Number((r.inbound / r.outbound).toFixed(1)) : null,
    days_active: r.first_message_at
      ? Math.max(1, Math.round((Date.now() - new Date(r.first_message_at)) / 86400000))
      : null,
  }));
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

/**
 * Signup volume over a few short windows.
 *
 * One query rather than three. Three round trips for three integers is silly on
 * its own, and worse than silly here: they would each read at a slightly
 * different instant, so "1h" could disagree with "24h" in a way nobody could
 * explain.
 */
async function signupTiles(hours = [1, 12, 24]) {
  const cols = hours.map((h, i) => `count(*) filter (where created_at > now() - ($${i + 1} || ' hours')::interval) as h${i}`);
  const { rows: [r] } = await db.query(
    `select ${cols.join(', ')}, count(*) as total from signups`,
    hours.map(String)
  );
  return hours.map((h, i) => ({ hours: h, count: Number(r[`h${i}`]) })).concat(
    [{ hours: null, count: Number(r.total) }]
  );
}

/**
 * Page views bucketed by hour.
 *
 * generate_series on the LEFT of the join so quiet hours come back as zero
 * rather than as missing rows. A chart built from only the hours that had
 * traffic silently rescales its own x-axis and makes a dead night look busy.
 */
async function visitsByHour(hours = 24) {
  const { rows } = await db.query(
    `select date_trunc('hour', g) as hour,
            count(v.id)::int as views
       from generate_series(date_trunc('hour', now()) - ($1 || ' hours')::interval,
                            date_trunc('hour', now()),
                            interval '1 hour') g
       left join page_views v on date_trunc('hour', v.at) = g
      group by 1 order by 1`,
    [String(hours)]
  );
  return rows.map(r => ({ hour: r.hour, views: r.views }));
}

/**
 * The funnel, as a list of stages with the count still standing at each.
 *
 * Deliberately NOT windowed. A signup that arrived on Tuesday and went live on
 * Thursday belongs in both stages, and slicing by "last 24h" at every step
 * would show people dropping out who had simply not got there yet — the most
 * misleading shape a funnel can have. Volume is what the tiles are for; this
 * answers "of everyone who ever started, where are they now".
 *
 * The league stages join back through the phone, so they count only leagues
 * that came from a signup rather than every league in the database.
 */
async function funnel() {
  const { rows: [r] } = await db.query(`
    select
      (select count(*) from page_views where path = '/start.html')            as visited_start,
      (select count(*) from signup_codes)                                     as code_issued,
      (select count(*) from signup_codes where used_at is not null)           as code_texted,
      (select count(*) from signups)                                          as on_waitlist,
      (select count(*) from signups where invited_at is not null)             as invited,
      (select count(*) from signups where redeemed_at is not null)            as opened_link,
      (select count(*) from leagues l
         join accounts a on a.id = l.account_id
         join signups s on s.phone = a.phone)                                 as league_linked,
      (select count(*) from leagues l
         join accounts a on a.id = l.account_id
         join signups s on s.phone = a.phone
        where l.onboarding_state in ('members_bound','awaiting_chat','live'))  as roster_bound,
      (select count(*) from leagues l
         join accounts a on a.id = l.account_id
         join signups s on s.phone = a.phone
        where l.onboarding_state = 'live')                                    as live
  `);

  const stages = [
    { key: 'visited_start', label: 'Opened the start page', note: 'anonymous count' },
    { key: 'code_issued',   label: 'Picked a league',       note: 'got a code' },
    { key: 'code_texted',   label: 'Texted the code' },
    { key: 'on_waitlist',   label: 'On the waitlist' },
    { key: 'invited',       label: 'Sent a setup link' },
    { key: 'opened_link',   label: 'Opened the link' },
    { key: 'league_linked', label: 'Linked their league' },
    { key: 'roster_bound',  label: 'Bound the roster' },
    { key: 'live',          label: 'Live in a group chat' },
  ];

  let prev = null;
  return stages.map(st => {
    const count = Number(r[st.key]);
    // Drop-off against the PREVIOUS stage, not against the top. Against the top
    // every late stage looks catastrophic and no single step stands out, which
    // is the opposite of what this is for.
    const dropped = prev === null ? null : Math.max(0, prev - count);
    const rate = prev ? Math.round((count / prev) * 100) : null;
    prev = count;
    return { ...st, count, dropped, rate };
  });
}

/**
 * How many people are talking to the bot rather than using the website.
 *
 * Two doors into the same funnel: a code from the site, or texting the keyword
 * cold. They fail differently — a code that is never texted is a website
 * problem, a conversation that stalls is a copy problem — so counting them
 * together would hide both.
 */
async function textFlow() {
  /*
   * Which door they came through, decided by whether a CODE was used.
   *
   * signups.source is the wrong field for this and reading it that way was a
   * real mistake: it records the transport — 'sms' or 'web' for the email form
   * — not whether the person had been to the website first. Somebody who picked
   * a league on the site and then texted their code is source='sms', so a split
   * on that column reports every website signup as a cold text.
   *
   * signup_codes.used_by_phone is the actual evidence: it is only ever written
   * when a code issued by the site is redeemed by a number.
   */
  const { rows: [r] } = await db.query(`
    select
      (select count(*) from signup_conversations)                          as conversations,
      (select count(*) from signups s
        where exists (select 1 from signup_codes c where c.used_by_phone = s.phone))
                                                                           as via_code,
      (select count(*) from signups s
        where not exists (select 1 from signup_codes c where c.used_by_phone = s.phone))
                                                                           as cold,
      (select count(*) from signup_codes where used_at is null)            as codes_unused,
      (select count(*) from suppressions)                                  as opted_out
  `);
  return {
    conversations: Number(r.conversations),
    viaCode: Number(r.via_code),
    cold: Number(r.cold),
    codesUnused: Number(r.codes_unused),
    optedOut: Number(r.opted_out),
  };
}

/**
 * Every conversation, most recent first.
 *
 * Keyed on chat_id rather than league_id, which is the whole point: a chat_id
 * is a group thread OR a single phone number, so this covers the 1:1 signup
 * texts as well as league group chats. thread() below is league-scoped and
 * cannot see a conversation with somebody who has no league yet — which,
 * during a signup push, is everybody who matters.
 *
 * The last message comes from array_agg rather than a correlated subquery or a
 * window function: one pass over the group, no second read of the table.
 */
async function conversations({ limit = 100 } = {}) {
  const { rows } = await db.query(
    `select m.chat_id,
            max(m.occurred_at)                                          as last_at,
            count(*)::int                                               as msgs,
            bool_or(m.is_group)                                         as is_group,
            (array_agg(m.body      order by m.occurred_at desc))[1]     as last_body,
            (array_agg(m.direction order by m.occurred_at desc))[1]     as last_direction,
            max(l.name)                                                 as league_name,
            max(mem.display_name)                                       as person
       from messages m
       left join leagues l on l.id = m.league_id
       -- Only ever matches a 1:1 chat, where chat_id IS the phone number. A
       -- group's chat_id is a provider handle and will never look like one.
       left join members mem on mem.phone = m.chat_id
      where m.chat_id is not null
      group by m.chat_id
      order by last_at desc
      limit $1`,
    [limit]
  );
  return rows.map(r => ({
    chatId: r.chat_id,
    lastAt: r.last_at,
    messages: r.msgs,
    isGroup: r.is_group,
    lastBody: r.last_body,
    lastDirection: r.last_direction,
    // What to call it, best available first. The raw chat id is the last
    // resort rather than the default, because "sb_group_00000000-0000-0000-0000-000000000000…" tells an
    // operator nothing they can act on.
    title: r.league_name || r.person || (r.is_group ? 'Group chat' : r.chat_id),
    subtitle: r.league_name && r.person ? r.person : null,
  }));
}

/**
 * One conversation, oldest first, the way a chat app reads.
 *
 * thread() returns newest-first-then-reversed because it is paired with
 * decisions; this is the plain message list and is ordered in SQL. Limit
 * applies to the most RECENT messages, so a long-running group chat opens on
 * what just happened rather than on its first ever text.
 */
async function conversation(chatId, { limit = 300 } = {}) {
  if (!chatId) throw new Error('conversation requires a chatId');
  const { rows } = await db.query(
    `select * from (
       select id, direction, sender_phone, protocol, body, occurred_at, is_group
         from messages
        where chat_id = $1
        order by occurred_at desc
        limit $2
     ) recent order by occurred_at asc`,
    [chatId, limit]
  );
  return rows;
}

/**
 * The five numbers that either kill this or predict it.
 *
 * Chosen because each one would change a decision. Total message counts and
 * cumulative signups are deliberately absent: they rise whether or not the
 * product works, and they crowd out the numbers that say it does not.
 */
async function opsMetrics({ days = 7 } = {}) {
  const [deliver, optOut, engagement, cost] = await Promise.all([
    /*
     * 1. Delivery. The only place a FAILED send exists — messages holds sends
     * that worked, so a failure rate computed from it is always zero.
     */
    db.query(
      `select count(*) filter (where ok)::int        as ok,
              count(*) filter (where not ok)::int    as failed,
              (array_agg(error order by at desc) filter (where not ok))[1] as last_error,
              max(at) filter (where not ok)          as last_failed_at
         from send_log where at > now() - ($1 || ' days')::interval`,
      [String(days)]
    ),

    /*
     * 2. Opt-outs, as a RATE against people we can actually message. The
     * absolute count is meaningless — two STOPs is nothing across a thousand
     * and a catastrophe across twenty. Carriers act on the rate, without
     * warning, so this has to be visible before they reach it.
     */
    db.query(
      `select (select count(*) from suppressions where opted_out_at is not null
                 and opted_in_at is null)::int                              as opted_out,
              (select count(distinct phone) from members
                where phone is not null and sleeper_roster_id is not null)::int as reachable`
    ),

    /*
     * 3 & 4. Adoption and staleness, per league.
     *
     * DISTINCT humans, not message count. Message count is vanity and one
     * enthusiastic person produces plenty of it; three different people
     * addressing the bot in week three is a league that adopted it, and one is
     * a novelty about to stop. days_quiet is the same fact from the other end
     * and is the one that says who to call.
     */
    db.query(
      `select l.id, l.name,
              count(distinct m.sender_phone) filter (
                where m.direction = 'inbound'
                  and m.occurred_at > now() - ($1 || ' days')::interval)::int as humans,
              max(m.occurred_at) filter (where m.direction = 'inbound')       as last_human_at
         from leagues l
         left join messages m on m.league_id = l.id
        where l.onboarding_state = 'live'
        group by l.id, l.name
        order by last_human_at asc nulls first`,
      [String(days)]
    ),

    // 5. Cost. Tokens, not dollars — the price per model changes and a stale
    // multiplier baked in here would be worse than no number at all.
    db.query(
      `select coalesce(sum(input_tokens),0)::int  as input,
              coalesce(sum(output_tokens),0)::int as output,
              count(*)::int                       as calls,
              count(distinct league_id)::int      as leagues
         from model_usage where at > now() - ($1 || ' days')::interval`,
      [String(days)]
    ),
  ]);

  const d = deliver.rows[0];
  const o = optOut.rows[0];
  const c = cost.rows[0];
  const attempts = d.ok + d.failed;

  return {
    days,
    delivery: {
      ok: d.ok,
      failed: d.failed,
      failureRate: attempts ? Math.round((d.failed / attempts) * 1000) / 10 : null,
      lastError: d.last_error,
      lastFailedAt: d.last_failed_at,
    },
    optOut: {
      count: Number(o.opted_out),
      reachable: Number(o.reachable),
      // One decimal. Rounding 1.4% to 1% hides the difference between fine and
      // a conversation with a carrier.
      rate: Number(o.reachable)
        ? Math.round((Number(o.opted_out) / Number(o.reachable)) * 1000) / 10
        : null,
    },
    leagues: engagement.rows.map(r => ({
      id: r.id,
      name: r.name,
      humans: r.humans,
      daysQuiet: r.last_human_at
        ? Math.floor((Date.now() - new Date(r.last_human_at)) / 86400000)
        : null,
    })),
    cost: {
      calls: c.calls,
      leagues: c.leagues,
      inputTokens: c.input,
      outputTokens: c.output,
      perLeague: c.leagues ? Math.round((c.input + c.output) / c.leagues) : null,
    },
  };
}

/**
 * Errors, broken down by the thing that broke.
 *
 * By SYSTEM first, because the systems fail independently and need entirely
 * different fixes: our own API returning 400s is a code problem, Sendblue
 * failing is a configuration or account problem, Anthropic failing is a quota
 * or outage, Sleeper failing is somebody else's outage that we ride out. A
 * single "error count" mixes four unrelated situations into one number that
 * cannot be acted on.
 */
async function errors({ days = 7 } = {}) {
  const [bySystem, byOperation, series, recent, windows] = await Promise.all([
    db.query(
      `select system, status, count(*)::int as n, max(at) as last_at
         from error_log where at > now() - ($1 || ' days')::interval
        group by system, status order by n desc`,
      [String(days)]
    ),
    db.query(
      `select system, operation, status, count(*)::int as n,
              (array_agg(message order by at desc))[1] as last_message,
              max(at) as last_at
         from error_log where at > now() - ($1 || ' days')::interval
        group by system, operation, status order by n desc limit 25`,
      [String(days)]
    ),
    // Bucketed by hour with the hours generated on the left, so a clean period
    // is a run of zeros rather than a gap. A gap and a quiet spell look
    // identical once they are drawn.
    db.query(
      `select date_trunc('hour', g) as hour,
              count(e.id)::int as n
         from generate_series(date_trunc('hour', now()) - interval '47 hours',
                              date_trunc('hour', now()), interval '1 hour') g
         left join error_log e on date_trunc('hour', e.at) = g
        group by 1 order by 1`
    ),
    db.query(
      `select at, system, operation, status, message
         from error_log order by at desc limit 40`
    ),

    /*
     * Client errors over short windows, and server errors kept apart.
     *
     * 4xx and 5xx are not the same event with different digits. A 400 is
     * usually somebody sending us something malformed — often expected, often
     * a client bug; a 500 is us falling over and is always ours. Summed
     * together, one 500 hides in forty 400s on the day it matters.
     *
     * One query for all six numbers so the windows are read at a single
     * instant and cannot disagree with each other.
     */
    db.query(
      `select
         count(*) filter (where status >= 400 and status < 500 and at > now() - interval '4 hours')::int  as c4h,
         count(*) filter (where status >= 400 and status < 500 and at > now() - interval '12 hours')::int as c12h,
         count(*) filter (where status >= 400 and status < 500 and at > now() - interval '24 hours')::int as c24h,
         count(*) filter (where status >= 500 and at > now() - interval '4 hours')::int  as s4h,
         count(*) filter (where status >= 500 and at > now() - interval '12 hours')::int as s12h,
         count(*) filter (where status >= 500 and at > now() - interval '24 hours')::int as s24h
       from error_log`
    ),
  ]);

  const total = bySystem.rows.reduce((n, r) => n + r.n, 0);
  return {
    days,
    total,
    bySystem: bySystem.rows.map(r => ({
      system: r.system, status: r.status, count: r.n, lastAt: r.last_at,
    })),
    byOperation: byOperation.rows.map(r => ({
      system: r.system, operation: r.operation, status: r.status,
      count: r.n, lastMessage: r.last_message, lastAt: r.last_at,
    })),
    series: series.rows.map(r => ({ hour: r.hour, count: r.n })),
    recent: recent.rows,
    windows: {
      client: [
        { hours: 4,  count: windows.rows[0].c4h },
        { hours: 12, count: windows.rows[0].c12h },
        { hours: 24, count: windows.rows[0].c24h },
      ],
      server: [
        { hours: 4,  count: windows.rows[0].s4h },
        { hours: 12, count: windows.rows[0].s12h },
        { hours: 24, count: windows.rows[0].s24h },
      ],
    },
  };
}

/**
 * Token spend per chat, with dollars.
 *
 * This file reported tokens and refused dollars, and said why: a stale
 * multiplier is worse than no number. Still true — so the rate carries an
 * expiry and src/pricing.js flags anything computed past it rather than
 * printing a confident wrong figure. Tokens stay alongside, because they are
 * the thing that does not go out of date.
 *
 * Per league, because "what does this cost" is only actionable per chat: one
 * busy league is a different decision from fifty quiet ones.
 */
async function costPerChat({ days = 7 } = {}) {
  const pricing = require('./pricing');

  const { rows } = await db.query(
    `select u.league_id, l.name as league_name, u.model,
            count(*)::int                                   as calls,
            coalesce(sum(u.input_tokens),0)::int            as input_tokens,
            coalesce(sum(u.output_tokens),0)::int           as output_tokens,
            coalesce(sum(u.cache_read_input_tokens),0)::int as cache_read_input_tokens,
            coalesce(sum(u.cache_creation_input_tokens),0)::int as cache_creation_input_tokens
       from model_usage u
       left join leagues l on l.id = u.league_id
      where u.at > now() - ($1 || ' days')::interval
      group by u.league_id, l.name, u.model
      order by 4 desc`, [String(days)]);

  const byLeague = new Map();
  for (const r of rows) {
    const key = r.league_id || 'unattributed';
    const acc = byLeague.get(key) || {
      leagueId: r.league_id, leagueName: r.league_name || 'not attributed to a league',
      calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      models: new Set(), rows: [],
    };
    acc.calls += r.calls;
    acc.inputTokens += r.input_tokens;
    acc.outputTokens += r.output_tokens;
    acc.cacheReadTokens += r.cache_read_input_tokens;
    acc.cacheWriteTokens += r.cache_creation_input_tokens;
    acc.models.add(r.model || 'unknown');
    acc.rows.push(r);
    byLeague.set(key, acc);
  }

  const leagues = [...byLeague.values()].map(a => {
    const t = pricing.totalOf(a.rows);
    const billedInput = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens;
    return {
      leagueId: a.leagueId, leagueName: a.leagueName,
      calls: a.calls,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens,
      cacheReadTokens: a.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens,
      models: [...a.models],
      cost: t.cost,
      costPerReply: a.calls ? Math.round((t.cost / a.calls) * 1e6) / 1e6 : null,
      /*
       * How much of the input came from cache. Zero across a busy league means
       * a silent invalidator, which is the single most expensive thing that can
       * go wrong here and produces no error of any kind.
       */
      cacheHitRate: billedInput
        ? Math.round((a.cacheReadTokens / billedInput) * 1000) / 10 : null,
      caveat: pricing.caveat(t),
    };
  }).sort((x, y) => (y.cost || 0) - (x.cost || 0));

  const all = pricing.totalOf(rows);
  return {
    days,
    leagues,
    total: {
      cost: all.cost,
      calls: leagues.reduce((n, l) => n + l.calls, 0),
      caveat: pricing.caveat(all),
    },
  };
}

module.exports = {
  costPerChat, replyRate, decisionBreakdown, leagueList, thread, draftHistory, scoped,
  signupTiles, visitsByHour, funnel, textFlow, conversations, conversation, opsMetrics, errors };

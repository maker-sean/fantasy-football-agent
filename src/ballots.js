/**
 * Ballots: the league decides something.
 *
 * The read path is deliberately narrow. One function builds the view a voter
 * sees, one function writes a vote, and both return the same shape — so the
 * webview renders the page identically whether it just loaded or just voted,
 * and there is exactly one place where "may this person see the split yet" is
 * decided. That question having two answers in two code paths is how a result
 * leaks early.
 *
 * Nothing here sends a message. close() computes and freezes an outcome; the
 * caller announces it. Keeping the transport out means this module is testable
 * against a database with no provider, and it means no code path in here can
 * surprise a live group chat.
 */

const db = require('./db');
const link = require('./ballotlink');

/** Defaults per kind. A veto is the reason the hidden default exists. */
const KIND_DEFAULTS = {
  poll: { resultsVisible: 'live', maxChoices: 1 },
  veto: { resultsVisible: 'after_close', maxChoices: 1 },
  rule: { resultsVisible: 'after_close', maxChoices: 1 },
  date: { resultsVisible: 'live', maxChoices: 8 },
};

const DEFAULT_MINUTES = Number(process.env.BALLOT_MINUTES || 24 * 60);

/**
 * Who is entitled to vote in this league.
 *
 * A bound phone, and not the bot. Unbound members are excluded rather than
 * counted-but-unable-to-vote: they have no link, so counting them in the
 * denominator means a ballot can never reach full participation and quorum
 * never fires. That would look exactly like a broken deadline.
 */
const ELIGIBLE_SQL = `
  select id, display_name, phone from members
   where league_id = $1 and phone is not null and is_bot = false
   order by display_name nulls last`;

async function eligibleMembers(leagueId) {
  const { rows } = await db.query(ELIGIBLE_SQL, [leagueId]);
  return rows;
}

/**
 * Open a ballot.
 *
 * Options are inserted with an explicit sort_order so the tiles keep the order
 * the asker wrote them in. Relying on insert order would look right until the
 * first time Postgres returned a different plan.
 */
async function open({
  leagueId, question, options,
  kind = 'poll', maxChoices, resultsVisible, quorum = null,
  durationMinutes = DEFAULT_MINUTES,
  subjectKind = null, subjectId = null, createdBy = 'agent',
}) {
  const defaults = KIND_DEFAULTS[kind] || KIND_DEFAULTS.poll;
  const opts = (options || []).map((o, i) => ({
    label: String(typeof o === 'string' ? o : o.label || '').trim(),
    emoji: (typeof o === 'object' && o.emoji) ? String(o.emoji) : null,
    sort: i,
  })).filter(o => o.label);

  if (!String(question || '').trim()) throw new Error('a ballot needs a question');
  if (opts.length < 2) throw new Error('a ballot needs at least two options');
  if (opts.length > 8) throw new Error('a ballot takes at most eight options');

  const max = Math.min(Number(maxChoices || defaults.maxChoices), opts.length);
  const visible = resultsVisible || defaults.resultsVisible;

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { rows: [ballot] } = await client.query(
      `insert into ballots (league_id, question, kind, subject_kind, subject_id,
                            max_choices, results_visible, quorum, closes_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval, $10)
       returning *`,
      [leagueId, String(question).trim(), kind, subjectKind, subjectId,
       max, visible, quorum, String(durationMinutes), createdBy]
    );

    for (const o of opts) {
      await client.query(
        'insert into ballot_options (ballot_id, label, emoji, sort_order) values ($1,$2,$3,$4)',
        [ballot.id, o.label, o.emoji, o.sort]
      );
    }
    await client.query('commit');
    return ballot;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function byId(ballotId) {
  const { rows } = await db.query('select * from ballots where id = $1', [ballotId]);
  return rows[0] || null;
}

async function optionsFor(ballotId) {
  const { rows } = await db.query(
    'select id, label, emoji, sort_order from ballot_options where ballot_id = $1 order by sort_order, label',
    [ballotId]
  );
  return rows;
}

/** Raw counts. Always computed; whether a caller may SHOW them is decided in view(). */
async function tally(ballotId) {
  const { rows } = await db.query(
    `select o.id, o.label, o.emoji, o.sort_order,
            count(v.member_id)::int as votes
       from ballot_options o
       left join ballot_votes v on v.option_id = o.id
      where o.ballot_id = $1
      group by o.id, o.label, o.emoji, o.sort_order
      order by o.sort_order, o.label`,
    [ballotId]
  );
  const { rows: [{ voters }] } = await db.query(
    'select count(distinct member_id)::int as voters from ballot_votes where ballot_id = $1',
    [ballotId]
  );
  return { options: rows, voters };
}

/**
 * Percentages are of VOTERS, not of votes cast.
 *
 * On a multi-choice ballot those differ, and "of votes cast" produces the
 * nonsense where four of ten people picking three nights each makes every night
 * look like 33% support. Of voters, an option that six of ten people can make
 * reads as 60%, which is the number somebody is actually trying to learn.
 */
function withPercentages(options, voters) {
  const d = voters || 1;
  return options.map(o => ({
    id: o.id, label: o.label, emoji: o.emoji,
    votes: o.votes,
    percentage: voters ? Math.round((o.votes / d) * 100) : 0,
  }));
}

function isClosed(ballot, now = Date.now()) {
  return Boolean(ballot.closed_at) || new Date(ballot.closes_at).getTime() <= now;
}

/**
 * Everything the webview needs, for one voter.
 *
 * The single place the visibility rule is applied. `results` is null while a
 * hidden ballot is open — not zeroed, not omitted-per-option, null — so a
 * client cannot accidentally render an empty bar chart as a real 0%.
 */
async function view(ballotId, memberId) {
  const ballot = await byId(ballotId);
  if (!ballot) return null;

  const [opts, counts, members] = await Promise.all([
    optionsFor(ballotId), tally(ballotId), eligibleMembers(ballot.league_id),
  ]);

  const { rows: mine } = await db.query(
    'select option_id from ballot_votes where ballot_id = $1 and member_id = $2',
    [ballotId, memberId]
  );
  const member = members.find(m => m.id === memberId) || null;

  const closed = isClosed(ballot);
  const show = closed || ballot.results_visible === 'live';

  return {
    id: ballot.id,
    question: ballot.question,
    kind: ballot.kind,
    maxChoices: ballot.max_choices,
    closesAt: ballot.closes_at,
    closed,
    // Always safe to show, and it is the number that gets stragglers moving.
    voted: counts.voters,
    eligible: members.length,
    resultsVisible: ballot.results_visible,
    you: {
      name: member?.display_name || null,
      choices: mine.map(r => r.option_id),
      hasVoted: mine.length > 0,
    },
    options: opts.map(o => ({ id: o.id, label: o.label, emoji: o.emoji })),
    results: show ? withPercentages(counts.options, counts.voters) : null,
  };
}

/**
 * Record a vote, replacing whatever this member chose before.
 *
 * Delete-then-insert inside one transaction, which does three jobs at once: it
 * caps a single-choice voter at one option (the constraint the schema cannot
 * express — see 0015_ballots.sql), it makes changing your mind work instead of
 * raising a duplicate key, and it makes a double-tap idempotent.
 *
 * The insert selects from ballot_options rather than trusting the ids given, so
 * an option belonging to a DIFFERENT ballot cannot be voted into this one. A
 * plain foreign key does not catch that: ballot_options.id is a valid target
 * whichever ballot it belongs to.
 */
async function castVote(ballotId, memberId, optionIds) {
  const ballot = await byId(ballotId);
  if (!ballot) return { ok: false, error: 'no_such_ballot' };
  if (isClosed(ballot)) return { ok: false, error: 'closed' };

  const { rows: [m] } = await db.query(
    `select id from members
      where id = $1 and league_id = $2 and phone is not null and is_bot = false`,
    [memberId, ballot.league_id]
  );
  // The token said this member; the database is the authority on whether they
  // are still in this league. A member removed mid-ballot holds a valid link.
  if (!m) return { ok: false, error: 'not_eligible' };

  const ids = [...new Set((optionIds || []).map(String))];
  if (!ids.length) return { ok: false, error: 'no_choice' };
  if (ids.length > ballot.max_choices) return { ok: false, error: 'too_many_choices' };
  if (!ids.every(id => /^[0-9a-f-]{36}$/i.test(id))) return { ok: false, error: 'bad_choice' };

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from ballot_votes where ballot_id = $1 and member_id = $2',
      [ballotId, memberId]);
    const { rowCount } = await client.query(
      `insert into ballot_votes (ballot_id, member_id, option_id)
       select $1, $2, o.id from ballot_options o
        where o.ballot_id = $1 and o.id = any($3::uuid[])`,
      [ballotId, memberId, ids]
    );
    if (rowCount !== ids.length) {
      // An id that is not an option on THIS ballot. Refuse the whole vote
      // rather than silently recording the subset that happened to be valid.
      await client.query('rollback');
      return { ok: false, error: 'bad_choice' };
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const closedNow = await maybeClose(ballotId);
  return { ok: true, closed: Boolean(closedNow), view: await view(ballotId, memberId) };
}

/**
 * Close if everyone has voted, or if quorum is met.
 *
 * Everyone-has-voted is the common case in a ten person league and it is worth
 * special casing: waiting out a 24 hour deadline after the last vote arrived is
 * how a decision that was made at 9pm gets announced at noon the next day.
 */
async function maybeClose(ballotId) {
  const ballot = await byId(ballotId);
  if (!ballot || ballot.closed_at) return null;

  const [counts, members] = await Promise.all([tally(ballotId), eligibleMembers(ballot.league_id)]);
  if (members.length && counts.voters >= members.length) return close(ballotId, 'everyone');
  if (ballot.quorum && counts.voters >= ballot.quorum) return close(ballotId, 'quorum');
  return null;
}

/**
 * Freeze the result.
 *
 * A tie is reported as a tie with no winner. Breaking it by sort order or by
 * whoever voted first would be inventing a rule the league never agreed to, and
 * in a veto the difference decides whether a trade stands.
 */
async function close(ballotId, reason = 'deadline') {
  const ballot = await byId(ballotId);
  if (!ballot) return null;
  if (ballot.closed_at) return ballot;

  const [counts, members] = await Promise.all([tally(ballotId), eligibleMembers(ballot.league_id)]);
  const breakdown = withPercentages(counts.options, counts.voters)
    .slice().sort((a, b) => b.votes - a.votes);

  const top = breakdown[0] || null;
  const tie = Boolean(top && breakdown[1] && breakdown[1].votes === top.votes);

  const outcome = {
    reason,
    voters: counts.voters,
    eligible: members.length,
    tie,
    winner: (top && top.votes > 0 && !tie) ? top : null,
    breakdown,
  };

  const { rows: [row] } = await db.query(
    `update ballots set closed_at = now(), outcome = $2::jsonb
      where id = $1 and closed_at is null returning *`,
    [ballotId, JSON.stringify(outcome)]
  );
  // Lost the race to another closer. Theirs is the outcome of record.
  return row || byId(ballotId);
}

/** Open ballots past their deadline. The worker's cron calls this and announces. */
async function closeDue(now = new Date()) {
  const { rows } = await db.query(
    'select id from ballots where closed_at is null and closes_at <= $1', [now]
  );
  const closed = [];
  for (const r of rows) closed.push(await close(r.id, 'deadline'));
  return closed;
}

/**
 * One link per member, for fanout.
 *
 * A group send cannot carry a per-person link — the whole thread gets one
 * message — so the announcement goes to the group and the links go 1:1. That is
 * more sends, which is exactly why src/fanout.js exists.
 */
async function links(ballotId) {
  const ballot = await byId(ballotId);
  if (!ballot) return [];
  const members = await eligibleMembers(ballot.league_id);
  return members.map(m => ({
    memberId: m.id, phone: m.phone, name: m.display_name,
    url: link.linkFor(ballotId, m.id),
  }));
}

module.exports = {
  open, byId, optionsFor, view, castVote, tally, close, maybeClose, closeDue,
  links, eligibleMembers, withPercentages, isClosed,
  KIND_DEFAULTS, DEFAULT_MINUTES,
};

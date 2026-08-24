/**
 * Every time the bot said it did not have something.
 *
 * This is a feature list written by the league. "I don't have game-by-game
 * scores" was said four times in one evening before anybody built game logs,
 * and the only record of it was scrollback. Asked-for-and-missing is the
 * highest quality demand signal this product gets, and it was being thrown away
 * as fast as it arrived.
 *
 * NO NEW LOGGING. decisions already stores every reply and messages stores
 * every question; provider_message_id joins them. So this is a query, it works
 * on everything already recorded rather than only on what happens next, and
 * there is no new write to forget on some future code path.
 *
 * TWO KINDS OF NO, and only one of them is a feature request.
 *
 *   A GAP    — "I don't have game logs", "that isn't a stat I've got". The data
 *              does not exist. This is the list.
 *
 *   A REFUSAL — "I can't crown a worst drafter, the counts are too close", "I
 *              only do football". The bot is working exactly as designed and
 *              building something would be the wrong response.
 *
 * Conflating them turns a backlog into noise, so refusals are excluded by
 * pattern. The exclusions are deliberately checked FIRST: a sentence can
 * contain both, and when it does the refusal is the reason.
 */

const db = require('./db');

/** Phrasings that mean the data is missing. */
const GAP = new RegExp([
  "do(?:n'?t| not) have",
  "have(?:n'?t| not) got",
  "i(?:'ve| have) got nothing",
  "isn'?t (?:a )?(?:stat|something|in)",
  "not (?:a )?(?:stat|something) (?:i'?ve |i )?(?:got|have)",
  // "no", "zero" and "nothing" all appear in real replies for the same idea,
  // and the corpus had "zero league data captured" sitting unflagged next to
  // "no league data captured".
  '(?:no|zero) (?:league )?(?:data|seasons?)',
  '(?:nothing|zero|no season)[^.]{0,20}(?:captured|synced|loaded)',
  "(?:not|never) (?:been )?(?:captured|synced|loaded)",
  '(?:no|zero) (?:game|weekly)[- ](?:by[- ]game )?(?:logs|scores|data)',
  "isn'?t in the .{0,24}history",
  '(?:nothing|zero) on (?:record|file)',
  "don'?t track",
  'no .{0,20}on (?:record|file)',
].join('|'), 'i');

/**
 * Phrasings that mean the bot chose not to, which is not a gap.
 *
 * Checked first, on purpose: "I can't crown a worst drafter, the counts are too
 * close, and I don't have a tiebreak" contains both, and the refusal is why.
 */
const REFUSAL = new RegExp([
  // The counts genuinely do not separate. Working as designed.
  'too (?:close|thin|tight)',
  'nobody leads',
  // Out of scope by policy, not by data.
  'only do football',
  "don'?t do personal",
  'not my department',
  "commissioner('?s)? (?:territory|setting|sets|picks|does)",
].join('|'), 'i');

/*
 * "can't crown" was here and has been removed.
 *
 * It appeared in both kinds of sentence. "I can't crown a worst drafter, the
 * counts are too close" is a refusal; "zero data loaded, so I can't crown a
 * worst drafter yet" is a gap wearing the same words, and excluding on the
 * phrase threw the second one away. The refusal is identifiable by its REASON
 * — too close, out of scope — not by the verb.
 *
 * "wrong bot" was removed for the same reason: a sentence beginning with a name
 * correction and continuing into a real gap is still a gap, and that correction
 * has since been fixed anyway.
 */

const isGap = text => {
  const t = String(text || '');
  if (!t) return false;
  if (REFUSAL.test(t)) return false;
  return GAP.test(t);
};

/**
 * The list, newest first, with the question that prompted it.
 *
 * Grouped by nothing: two people asking the same thing on different days is two
 * data points, and collapsing them hides that the second one asked again.
 */
/**
 * @param opts.days   rolling window, when you just want "lately"
 * @param opts.since  an explicit floor, when you want "since we shipped that"
 *
 * SINCE EXISTS BECAUSE A GAP IS NOT PERMANENT. Every one of these is a request,
 * and requests get built: "the closest game in league history" was asked four
 * times by four people in one evening, and it has been answerable since the
 * next morning. Left in the window it reads as demand for something that
 * already exists, and a report that lists satisfied requests trains you to skip
 * it.
 *
 * A floor rather than a hardcoded "fixed at" date. The obvious version of this
 * was a constant naming the commit that fixed the context bug, which would have
 * been both a stale magic number and WRONG — those requests landed after that
 * commit and before the archive was actually ingested, which is a different
 * moment and not one any commit hash knows.
 */
async function recent({ limit = 50, days = 30, since = null } = {}) {
  /*
   * A bare date means LOCAL midnight, not UTC.
   *
   * new Date('2026-08-24') is parsed as UTC by spec, which in Eastern time is
   * 8pm on the 23rd — so "--since 2026-08-24" would quietly include the
   * previous evening, and this report prints its timestamps in local time. A
   * filter and a display that disagree about what a day is will be trusted
   * until the one time it matters. Anything carrying a time or a zone is left
   * exactly as written.
   */
  const floor = since
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(since).trim())
        ? `${String(since).trim()}T00:00:00`
        : since)
    : null;
  if (floor && Number.isNaN(floor.getTime())) throw new Error(`bad --since date: ${since}`);

  const { rows } = await db.query(
    `select d.created_at, d.league_id, d.reason,
            m.body as question, m.sender_phone,
            d.replied_text as answer
       from decisions d
       left join messages m on m.provider_message_id = d.trigger_message_id
      where d.replied_text is not null
        and ($2::timestamptz is null or d.created_at >= $2::timestamptz)
        and ($2::timestamptz is not null
             or d.created_at > now() - ($1 || ' days')::interval)
      order by d.created_at desc
      limit 400`, [String(days), floor ? floor.toISOString() : null]);

  return rows.filter(r => isGap(r.answer)).slice(0, limit);
}

/** Who asked, when a name is known. Falls back to the number. */
async function withNames(rows) {
  const { rows: members } = await db.query(
    'select phone, display_name from members where phone is not null');
  const name = new Map(members.map(m => [m.phone, m.display_name]));
  return rows.map(r => ({ ...r, asker: name.get(r.sender_phone) || r.sender_phone || 'unknown' }));
}

module.exports = { recent, withNames, isGap, GAP, REFUSAL };

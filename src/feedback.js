/**
 * Telling us something, as opposed to asking us something.
 *
 * There was no way to do it. The gaps list catches "I don't have that", which
 * is demand inferred from a refusal, and it cannot catch "the recap is too
 * long" or "it got Kellan's record wrong" — the things somebody says when they
 * are annoyed rather than curious. Those were landing in a group chat and
 * staying there.
 *
 * A KEYWORD RATHER THAN DETECTION. Guessing which messages are feedback means
 * either missing most of them or filing jokes as product requests, and a
 * twelve-person chat produces a great many jokes. The word is explicit, and the
 * introduction advertises it, because a feature nobody knows about does not
 * exist.
 *
 * THE WORD THEY USE IS THE QUEUE. "bug" and "idea" go to different places in
 * anybody's head, and asking a follow-up question to sort them is a turn nobody
 * wants to spend. They already said which one.
 *
 * WORKS IN THE GROUP. That is where people are and where the annoyance happens,
 * and the alternative is asking somebody to leave a conversation to file a
 * ticket. 1:1 works too and reads differently: in-group feedback is public and
 * often performative, a private one is considered. Both are stored with which
 * it was.
 */

const db = require('./db');

const KINDS = { bug: 'bug', broken: 'bug', idea: 'idea', suggestion: 'idea',
  feature: 'idea', feedback: 'feedback' };

/*
 * <botname>? <word> <the actual thing>
 *
 * The bot name is optional because "feedback: X" in a 1:1 is unambiguous, and
 * requiring it in a group is fine since that is how you address it anyway. A
 * trailing colon or dash is swallowed: people type "bug: the recap is wrong".
 */
const FEEDBACK = /^\s*(?:(?:hey\s+)?[a-z0-9_]+[\s,]+)??\b(bug|broken|idea|suggestion|feature|feedback)\b\s*[:,-]?\s+(.{3,})$/is;

/**
 * Parse a message into feedback, or null.
 *
 * Requires the bot to have been named when it is a group, for the same reason
 * claims does: two people saying "that's a bug" to each other are having a
 * conversation, not filing one.
 */
function parse(text, { botNames = [], isGroup = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const named = botNames.some(n =>
    new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw));
  if (isGroup && !named) return null;

  // Strip a leading bot name so "bot bug the recap is wrong" parses.
  let body = raw;
  for (const n of botNames) {
    const re = new RegExp(`^\\s*(?:hey\\s+)?${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,:-]+`, 'i');
    if (re.test(body)) { body = body.replace(re, ''); break; }
  }

  const m = FEEDBACK.exec(body);
  if (!m) return null;
  const kind = KINDS[m[1].toLowerCase()] || 'feedback';
  const said = m[2].trim();
  // A bare keyword with nothing after it is somebody testing, not feedback.
  if (said.length < 3) return null;
  return { kind, body: said.slice(0, 2000) };
}

/** Store it and tell the operator, in that order. */
async function record({ leagueId = null, phone, saidBy = null, kind, body, inGroup = false }) {
  const { rows } = await db.query(
    `insert into feedback (league_id, phone, said_by, kind, body, in_group)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [leagueId, phone ? db.normalizePhone(phone) : null, saidBy, kind, body, inGroup]);
  return rows[0];
}

const thanks = (kind) => kind === 'bug'
  ? 'Logged as a bug. Somebody who can fix it will see it.'
  : kind === 'idea'
    ? 'Logged as an idea. It goes in front of the person deciding what gets built.'
    : 'Logged. It goes in front of the person deciding what gets built.';

/** One line for the operator's phone. */
const alertText = ({ kind, body, saidBy, inGroup, leagueName }) =>
  `${kind.toUpperCase()} from ${saidBy || 'someone'}`
  + `${leagueName ? ` (${leagueName})` : ''}${inGroup ? ' in the group' : ''}:\n\n"${body}"`;

/** The list, newest first. */
async function recent({ limit = 50, status = null } = {}) {
  const { rows } = await db.query(
    `select f.*, l.name as league_name
       from feedback f left join leagues l on l.id = f.league_id
      ${status ? 'where f.status = $2' : ''}
      order by f.created_at desc limit $1`,
    status ? [limit, status] : [limit]);
  return rows;
}

module.exports = { parse, record, recent, thanks, alertText, KINDS, FEEDBACK };

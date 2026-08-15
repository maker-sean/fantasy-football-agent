/**
 * Recap drafts awaiting a human.
 *
 * The approval step exists because the verifier can catch an invented number
 * but not a false claim built from true ones. It is also, not incidentally, the
 * onboarding flow for any future league: a commissioner approving the bot's
 * first few posts is how a stranger's league should start.
 *
 * Graduation is built in — set `autoPost` on a league's config once you trust
 * it and the approval step disappears for that league only.
 */

const db = require('./db');

const DEFAULT_TTL_HOURS = Number(process.env.DRAFT_TTL_HOURS || 24);

/** Phones allowed to approve for a league. */
function ownersOf(league) {
  const cfg = league?.config || {};
  const list = cfg.ownerPhones || (cfg.ownerPhone ? [cfg.ownerPhone] : []);
  return list.map(p => db.normalizePhone(p)).filter(Boolean);
}

function autoPostEnabled(league) {
  return Boolean(league?.config?.autoPost);
}

async function createDraft({ leagueId, season, week, kind = 'recap', body, facts = {}, verification = {}, model, ttlHours = DEFAULT_TTL_HOURS }) {
  const { rows } = await db.query(
    `insert into recap_drafts (league_id, season, week, kind, body, facts, verification, model, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval)
     on conflict (league_id, season, week, kind) where status in ('pending','approved','sent')
     do nothing
     returning *`,
    [leagueId, String(season), Number(week), kind, body, facts, verification, model || null, String(ttlHours)]
  );
  return rows[0] || null;   // null means one already exists for this week
}

/** The draft a reply like "send" should act on: newest pending, not expired. */
async function pendingFor(leagueId) {
  const { rows } = await db.query(
    `select * from recap_drafts
     where league_id = $1 and status = 'pending' and expires_at > now()
     order by created_at desc limit 1`,
    [leagueId]
  );
  return rows[0] || null;
}

async function pendingForOwner(phone) {
  const normalized = db.normalizePhone(phone);
  const { rows } = await db.query(
    `select d.*, l.name as league_name, l.chat_id, l.provider, l.config as league_config
     from recap_drafts d join leagues l on l.id = d.league_id
     where d.status = 'pending' and d.expires_at > now()
     order by d.created_at desc`
  );
  return rows.filter(r => ownersOf({ config: r.league_config }).includes(normalized));
}

async function markSent(id, { by, messageId }) {
  const { rows } = await db.query(
    `update recap_drafts set status = 'sent', decided_at = now(), decided_by = $2, sent_message_id = $3
     where id = $1 and status = 'pending' returning *`,
    [id, by || null, messageId || null]
  );
  return rows[0] || null;
}

async function markRejected(id, { by }) {
  const { rows } = await db.query(
    `update recap_drafts set status = 'rejected', decided_at = now(), decided_by = $2
     where id = $1 and status = 'pending' returning *`,
    [id, by || null]
  );
  return rows[0] || null;
}

/** Expire anything that sat too long. Stale recaps must never post late. */
async function expireStale() {
  const { rows } = await db.query(
    `update recap_drafts set status = 'expired', decided_at = now()
     where status = 'pending' and expires_at <= now() returning id, league_id, week`
  );
  return rows;
}

async function recent(leagueId, limit = 10) {
  const { rows } = await db.query(
    `select id, season, week, kind, status, model, created_at, decided_at, decided_by,
            left(body, 90) as preview
     from recap_drafts where league_id = $1 order by created_at desc limit $2`,
    [leagueId, limit]
  );
  return rows;
}

module.exports = {
  createDraft, pendingFor, pendingForOwner, markSent, markRejected,
  expireStale, recent, ownersOf, autoPostEnabled, DEFAULT_TTL_HOURS,
};

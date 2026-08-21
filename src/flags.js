/**
 * The control plane: a small set of switches over the running system.
 *
 * Deliberately NOT CRUD. Nothing here edits league data, rosters, messages or
 * snapshots. Hand-edited state in a system where a model reads from stored
 * facts produces bugs that are close to unfindable, because the trace shows the
 * model behaving correctly on data no code path ever wrote. Postgres stays
 * owned by the application; this file owns four booleans.
 *
 * Why a table and not REPLY_DRY_RUN, which already exists: that is an env var,
 * so flipping it means a Render dashboard visit and a worker restart, and
 * render.yaml re-applies literal values on deploy, which has silently reset it
 * before. A row here lands on the next read, which is one poll. That is the
 * difference between stopping a bot mid-Sunday and watching it finish.
 *
 * REPLY_DRY_RUN still wins when set. An operator who has pulled the env lever
 * should not find the database quietly overriding them.
 */

const db = require('./db');

/*
 * Five seconds of cache.
 *
 * The kill switch is read on every inbound burst, and a group chat arrives in
 * flurries, so this is the difference between one query and forty. Five seconds
 * is chosen against the ten second poll interval: it can never make the switch
 * take longer than two polls to bite, which still beats a redeploy by minutes.
 */
const TTL_MS = 5000;
let cache = { at: 0, value: null };

async function repliesPaused() {
  if (process.env.REPLY_DRY_RUN === 'true') return true;

  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) return cache.value;

  try {
    const { rows } = await db.query(`select value from system_flags where key = 'replies_paused'`);
    cache = { at: now, value: rows[0]?.value === true };
  } catch (err) {
    // A database that cannot be read must not silently un-pause a bot that an
    // operator deliberately stopped. Fail to the last known value, and to
    // paused if nothing is known yet.
    console.error('[flags] read failed, holding last value:', err.message);
    if (cache.value === null) cache = { at: now, value: true };
  }
  return cache.value;
}

async function setRepliesPaused(paused, by) {
  await db.query(
    `insert into system_flags (key, value, updated_by, updated_at)
     values ('replies_paused', $1::jsonb, $2, now())
     on conflict (key) do update
       set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(!!paused), by || 'unknown']
  );
  cache = { at: Date.now(), value: !!paused };
  console.log(`[flags] replies_paused = ${!!paused} (by ${by || 'unknown'})`);
  return !!paused;
}

async function all() {
  const { rows } = await db.query('select key, value, updated_at, updated_by from system_flags order by key');
  return rows;
}

/** Test seam. The cache is process-wide, so tests need to clear it. */
function _resetCache() { cache = { at: 0, value: null }; }

module.exports = { repliesPaused, setRepliesPaused, all, _resetCache, TTL_MS };

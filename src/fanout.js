/**
 * Running the same job across many leagues without hammering anything.
 *
 * Every scheduled job is shaped "for each league, call an API, then maybe send
 * a text". Serially that is fine at one league and slow at a thousand. All at
 * once it is worse than slow: a hundred simultaneous group sends is how you get
 * throttled by the messaging provider, and carrier spam filtering is a silent,
 * hard-to-reverse failure — nothing errors, the texts just stop arriving.
 *
 * So: a small number at a time, and spread out in time.
 *
 * This is deliberately NOT a work queue. A queue is the right destination —
 * durable retries, visibility, backpressure — but it is a lot of machinery to
 * maintain for a year before it earns anything. These two functions carry the
 * system to roughly 500 leagues, and the day a job stops finishing inside its
 * window is the day the queue is worth building.
 */

/** Default parallelism. Low on purpose — the APIs are the scarce resource. */
const DEFAULT_LIMIT = Number(process.env.FANOUT_LIMIT || 6);

/** How far apart to spread per-league work. */
const DEFAULT_SPREAD_MS = Number(process.env.FANOUT_SPREAD_MS || 10 * 60 * 1000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Run `fn` over `items`, at most `limit` at a time.
 *
 * Never rejects. A thrown handler is captured as { ok: false, error } so one
 * bad league cannot abort the other ninety-nine — the same contract as the
 * try/catch-and-continue these jobs already use, just concurrent.
 *
 * Results come back in input order regardless of completion order, so job
 * detail stays readable.
 */
async function mapLimit(items, fn, { limit = DEFAULT_LIMIT } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await fn(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error, item: list[i] };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker)
  );
  return results;
}

/**
 * A stable offset in [0, spreadMs) derived from a key.
 *
 * Deterministic rather than random so a league lands in the same slot every
 * week: "our recap shows up around 9:20" is a feature, and a random offset each
 * run makes a late job indistinguishable from a broken one.
 *
 * FNV-1a — not for security, just for an even spread from short ids.
 */
function jitterFor(key, spreadMs = DEFAULT_SPREAD_MS) {
  if (!spreadMs) return 0;
  let h = 0x811c9dc5;
  for (const ch of String(key)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % spreadMs;
}

/**
 * Fan out across leagues: bounded concurrency, each one staggered by its own
 * stable offset.
 *
 * The stagger is what protects the messaging provider. Without it every league
 * sends at the same cron minute — 12:55 on Sunday, every league at once — which
 * is precisely the burst shape that looks like spam.
 */
async function forEachLeague(leagues, fn, opts = {}) {
  const { limit = DEFAULT_LIMIT, spreadMs = DEFAULT_SPREAD_MS, key = l => l.id } = opts;
  return mapLimit(leagues, async (league, i) => {
    const wait = jitterFor(key(league), spreadMs);
    if (wait) await sleep(wait);
    return fn(league, i);
  }, { limit });
}

module.exports = {
  mapLimit, jitterFor, forEachLeague, sleep,
  DEFAULT_LIMIT, DEFAULT_SPREAD_MS,
};

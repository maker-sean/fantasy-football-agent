/**
 * Turning tokens into dollars, without the number quietly going wrong.
 *
 * src/observe.js reported tokens and not cost, and said why: "the price per
 * model changes and a stale multiplier baked in here would be worse than no
 * number at all." That is correct, and there is a live example of it — Sonnet
 * 5's introductory rate ends on 2026-08-31, after which the same traffic costs
 * 50% more. A hardcoded number would have started lying on 1 September and
 * nothing would have said so.
 *
 * So a rate carries the date it stops being true, and anything computed past
 * that date is returned flagged rather than silently wrong. The dashboard shows
 * the flag. That is the whole difference between a useful number and the one
 * observe.js was right to refuse.
 *
 * Prices are per MILLION tokens, from Anthropic's published rates.
 *
 * CACHE MULTIPLIERS. A cached read bills at roughly a tenth of the input rate
 * and a cache write at roughly 1.25x. Both are ratios of the model's own input
 * price rather than separate rates, so they survive a price change.
 */

const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/**
 * Rates as of 2026-08-23. `until` is the date the rate stops applying; null
 * means no announced change.
 */
const RATES = {
  'claude-sonnet-5': { in: 2.00, out: 10.00, until: '2026-08-31',
    note: 'introductory rate, rises to $3.00 / $15.00' },
  'claude-opus-5':   { in: 5.00, out: 25.00, until: null },
  'claude-haiku-4-5': { in: 1.00, out: 5.00, until: null },
};

/** The rate for a model, or null when we have never been told one. */
const rateFor = model => RATES[String(model || '')] || null;

/**
 * Cost of one row of usage.
 *
 * Returns { cost, stale, unknownModel } rather than a bare number, because a
 * caller that cannot tell a good figure from an expired one will print the
 * expired one.
 */
function costOf({ model, input_tokens = 0, output_tokens = 0,
                  cache_read_input_tokens = 0, cache_creation_input_tokens = 0 },
                { now = new Date() } = {}) {
  const rate = rateFor(model);
  if (!rate) return { cost: null, stale: false, unknownModel: true, model };

  const cost =
      (input_tokens / 1e6) * rate.in
    + (output_tokens / 1e6) * rate.out
    + (cache_read_input_tokens / 1e6) * rate.in * CACHE_READ
    + (cache_creation_input_tokens / 1e6) * rate.in * CACHE_WRITE;

  return {
    cost: Math.round(cost * 1e6) / 1e6,
    // Past its announced change date: the figure is real arithmetic on a rate
    // that no longer applies, which is exactly the failure observe.js named.
    stale: Boolean(rate.until && now > new Date(rate.until + 'T23:59:59Z')),
    unknownModel: false,
    rate, model,
  };
}

/** Sum a set of rows, carrying any staleness forward rather than losing it. */
function totalOf(rows, opts = {}) {
  let cost = 0, stale = false;
  const unknown = new Set();
  for (const r of rows) {
    const c = costOf(r, opts);
    if (c.unknownModel) { unknown.add(c.model || 'unknown'); continue; }
    cost += c.cost;
    if (c.stale) stale = true;
  }
  return { cost: Math.round(cost * 1e6) / 1e6, stale, unknownModels: [...unknown] };
}

/** One line for a dashboard, saying plainly when the number cannot be trusted. */
function caveat({ stale, unknownModels = [] }) {
  const bits = [];
  if (stale) bits.push('a rate used here has passed its announced change date, so this is understated');
  if (unknownModels.length) bits.push(`no rate on file for ${unknownModels.join(', ')}, excluded`);
  return bits.length ? bits.join('; ') : null;
}

module.exports = { costOf, totalOf, caveat, rateFor, RATES, CACHE_READ, CACHE_WRITE };

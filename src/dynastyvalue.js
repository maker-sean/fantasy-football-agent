/**
 * What a dynasty trade is worth right now, and what the price cannot see.
 *
 * src/trades.js grades a settled REDRAFT trade on points actually scored three
 * weeks later, which is ground truth and needs no opinion. Dynasty gets none of
 * that: a 2021 dynasty trade is still resolving, so nothing here is ever a
 * verdict on how it worked out. It answers the other question — was this fair
 * when it was made — which is the one a chat actually argues about.
 *
 * WHY A LOOKUP IS ENOUGH. Dynasty market values already price the things that
 * would otherwise need modelling: age, years of team control, breakout odds,
 * how much a 29 year old running back is discounted. Sean's framing and it is
 * the right one — do not rebuild what the market has already priced. What the
 * market cannot know is the ROSTER the asset is landing on, and that is the
 * only place this adds its own judgement.
 *
 * The handcuff is the case that forced it. A second round pick was spent on the
 * backup to a starting running back who is carrying a knee injury, on the same
 * roster. Every fact needed to see that was in this database — both men on the
 * same NFL team, same position, one of them Questionable — and nothing joined
 * them. By pure value it reads as an overpay. With the roster in view it is a
 * premium somebody chose to pay, which is a different sentence and possibly a
 * different verdict.
 *
 * NOT PRICED IS SAID OUT LOUD. Future picks beyond the source's horizon have no
 * value here at all — the sheet carries 2026 and no 2027 — and a side whose
 * assets could not be priced must never come back as "worth zero". That is the
 * false absence this codebase keeps paying for.
 */

const db = require('./db');

/** Early, Mid or Late, by thirds of the round. */
function bucketFor(slot, teams) {
  if (!slot || !teams) return null;
  const third = teams / 3;
  if (slot <= third) return 'Early';
  if (slot <= third * 2) return 'Mid';
  return 'Late';
}

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

/**
 * The label the value sheet uses, e.g. "2026 Early 2nd".
 *
 * Needs the slot the pick will land in, which is NOT reverse standings in every
 * league — this one's real order had a team that finished 7th picking 3rd. So
 * the actual draft order is used when a draft exists, and the standings-based
 * guess only stands in for seasons that have no draft yet. Guessing when the
 * answer is knowable is how you get a confident wrong number.
 */
function pickLabel({ season, round, slot, teams }) {
  const bucket = bucketFor(slot, teams);
  const ord = ORDINAL[round];
  if (!bucket || !ord) return null;
  return `${season} ${bucket} ${ord}`;
}

/** Slot lookup from a Sleeper draft's slot_to_roster_id, inverted. */
function slotsFromDraft(slotToRoster) {
  const out = new Map();
  for (const [slot, roster] of Object.entries(slotToRoster || {})) {
    out.set(Number(roster), Number(slot));
  }
  return out;
}

/** Standings fallback: worst finish drafts first. Only for seasons with no draft. */
function slotsFromFinish(finishes, teams) {
  const out = new Map();
  for (const [rosterId, place] of finishes || []) {
    if (place) out.set(Number(rosterId), teams - Number(place) + 1);
  }
  return out;
}


/*
 * A letter grade, COMPUTED — never left to the model.
 *
 * Grading is a ranking, and every ranking in this codebase is computed here for
 * the same reason: a model handed two totals will produce a letter that sounds
 * right and cannot be checked. Two people arguing in a group chat will quote
 * the letter and nothing else, so it has to mean one fixed thing.
 *
 * The measure is the winner's surplus as a SHARE OF THE POT, not the raw
 * margin. A 3,000 gap between two second round picks is a fleecing; the same
 * 3,000 between two first round studs is a rounding error, and raw margin
 * cannot tell those apart.
 *
 * Bands are deliberately coarse. The inputs are market estimates with a few
 * percent of noise in them, so finer gradations would be false precision
 * wearing a letter.
 */

/*
 * Grade a trade against the trades this league actually makes.
 *
 * The fixed bands below were set on the assumption that deals cluster near even
 * and only the outliers are lopsided. They do not: measured over 48 real
 * trades, 27% cleared the top band. A+ described more than a quarter of all
 * trades, which at a few hundred trades is eighty of them and a letter that
 * says nothing.
 *
 * So the population is the yardstick, exactly as it already is for a trader's
 * grade: A+ is the most lopsided tenth, D the fairest tenth, and "one of the
 * worst trades in this league" means one of the worst trades in THIS league.
 *
 * Under twenty trades there is no distribution worth speaking of and this falls
 * back to the fixed bands — a percentile off six trades is a ranking of six
 * things wearing the authority of a grade.
 */
const MIN_POPULATION = 20;

function gradeAgainst(edge, population) {
  if (!Array.isArray(population) || population.length < MIN_POPULATION) return null;
  const sorted = [...population].sort((a, b) => a - b);
  const below = sorted.filter(e => e < Math.abs(edge)).length;
  const pct = below / sorted.length;

  /*
   * THE PAIR MIRRORS, because a trade is zero-sum: whatever one side gained the
   * other lost, and grading that A+ against a D says the loser did better out of
   * it than the winner did badly, which is not a thing that can happen.
   *
   * It is also MONOTONIC in both columns, which the first cut was not — the
   * fairest trades handed the winner a B+ while slightly more lopsided ones gave
   * a B, so a winner scored higher for winning less. There is no separate reward
   * here for making a fair deal: an even trade is B and B, and the scale only
   * ever measures how one-sided a deal was and in whose favour.
   */
  if (pct >= 0.90) return { won: 'A+', lost: 'F', say: 'one of the most lopsided this league has seen' };
  if (pct >= 0.75) return { won: 'A', lost: 'D', say: 'a clear win by this league\'s standards' };
  if (pct >= 0.55) return { won: 'A-', lost: 'C-', say: 'a bit more one-sided than usual' };
  if (pct >= 0.30) return { won: 'B+', lost: 'C+', say: 'an ordinary deal here' };
  if (pct >= 0.15) return { won: 'B', lost: 'B-', say: 'closer than most' };
  return { won: 'B', lost: 'B', say: 'one of the fairest this league has made' };
}

/*
 * The fallback, for a league with too few trades to have a distribution. Same
 * mirrored pairs as gradeAgainst, so a league does not see the scale change
 * shape the week it crosses twenty trades — only tighten.
 */
const BANDS = [
  { upTo: 0.05, won: 'B',  lost: 'B',  say: 'even' },
  { upTo: 0.12, won: 'B+', lost: 'C+', say: 'a slight edge' },
  { upTo: 0.25, won: 'A-', lost: 'C-', say: 'a clear win' },
  { upTo: 0.40, won: 'A',  lost: 'D',  say: 'a big win' },
  { upTo: Infinity, won: 'A+', lost: 'F', say: 'a fleecing' },
];

function gradeFor(margin, pot) {
  if (margin == null || !pot) return null;
  const edge = Math.abs(margin) / pot;
  const band = BANDS.find(b => edge < b.upTo);
  return { edge: Math.round(edge * 1000) / 10, won: band.won, lost: band.lost, say: band.say };
}


/**
 * Every price needed for a set of trades, in two queries instead of two hundred.
 *
 * priceTrade reads the database itself, which is fine for one trade and hopeless
 * for a ledger: fifty-six trades priced at their own date AND at today is 112
 * calls and 25 seconds, against a reply budget of seven or eight.
 *
 * So the caller can hand over a book. Resolving which capture a date lands on is
 * itself a query — captures are weekly, so "as at the 23rd" means the newest on
 * or before it — and doing that per trade is most of the cost.
 */
async function loadValueBook({ dates, superflex = false }) {
  const wanted = [...new Set(dates.filter(Boolean).map(d =>
    (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)))];

  // Which capture each requested date actually resolves to, all at once.
  const { rows: resolved } = await db.query(
    `select d::date as asked,
            (select max(captured_on) from player_values where captured_on <= d::date) as capture
       from unnest($1::date[]) as d`, [wanted.length ? wanted : [new Date().toISOString().slice(0, 10)]]);
  const { rows: [newest] } = await db.query('select max(captured_on) d from player_values');

  const asOfCapture = new Map(resolved
    .filter(r => r.capture)
    .map(r => [r.asked.toISOString().slice(0, 10), r.capture]));
  const captures = [...new Set([...asOfCapture.values(), newest?.d].filter(Boolean))];
  if (!captures.length) return null;

  const { rows } = await db.query(
    `select v.captured_on, v.sleeper_id, v.name, v.value, v.position, p.position as pos, p.team
       from player_values v left join players p on p.player_id = v.sleeper_id
      where v.superflex = $1 and v.captured_on = any($2::date[])`,
    [superflex, captures]);

  const book = new Map();
  const key = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  for (const r of rows) {
    const k = key(r.captured_on);
    if (!book.has(k)) book.set(k, { capturedOn: r.captured_on, byId: new Map(), byName: new Map() });
    const e = book.get(k);
    if (r.sleeper_id) e.byId.set(String(r.sleeper_id), { name: r.name, value: r.value, position: r.pos, team: r.team });
    e.byName.set(r.name, r.value);
    if (r.position === 'PICK') e.byName.set(r.name, r.value);
  }

  return {
    superflex,
    newest: newest?.d || null,
    // asOf -> the page of the book to read. Null asOf means today's.
    pageFor(asOf) {
      const k = asOf ? key(asOf) : null;
      const capture = k ? asOfCapture.get(k) : (newest?.d || null);
      return capture ? book.get(key(capture)) || null : null;
    },
  };
}

/**
 * Value every asset on both sides of a trade.
 *
 * @param trade  a row from `trades` — received, draft_picks, roster_ids
 * @param o.superflex   which value flavour to read
 * @param o.asOf        capture date; defaults to the newest available
 * @param o.slots       Map of rosterId -> draft slot, per season
 * @param o.teams       league size
 */
async function priceTrade(trade, o = {}) {
  const { superflex = false, teams = 12, slots = new Map(), asOf = null } = o;

  /*
   * A preloaded book skips every query below. Same answers, two orders of
   * magnitude fewer round trips — see loadValueBook.
   */
  const page = o.book ? o.book.pageFor(asOf) : null;
  let on;
  if (o.book) {
    if (!page) return null;
    on = page.capturedOn;
  } else {
    const { rows: [cap] } = await db.query(
      asOf
        ? `select max(captured_on) d from player_values where captured_on <= $1`
        : `select max(captured_on) d from player_values`,
      asOf ? [asOf] : []);
    on = cap?.d;
    if (!on) return null;
  }

  const received = trade.received || {};
  const rosterIds = trade.roster_ids || Object.keys(received).map(Number);

  const sides = new Map();
  const side = rid => {
    const k = Number(rid);
    if (!sides.has(k)) sides.set(k, { rosterId: k, players: [], picks: [], unpriced: [], value: 0 });
    return sides.get(k);
  };
  for (const rid of rosterIds) side(rid);

  // Players received.
  const ids = [...new Set(Object.values(received).flat())];
  const byId = new Map();
  if (page) {
    for (const pid of ids) {
      const hit = page.byId.get(String(pid));
      if (hit) byId.set(String(pid), { ...hit, sleeper_id: pid });
    }
  } else if (ids.length) {
    const { rows } = await db.query(
      `select v.sleeper_id, v.name, v.value, p.position, p.team
         from player_values v left join players p on p.player_id = v.sleeper_id
        where v.captured_on = $1 and v.superflex = $2 and v.sleeper_id = any($3::text[])`,
      [on, superflex, ids]);
    for (const r of rows) byId.set(String(r.sleeper_id), r);
  }
  for (const [rid, list] of Object.entries(received)) {
    for (const pid of list || []) {
      const v = byId.get(String(pid));
      if (v) { side(rid).players.push({ playerId: pid, name: v.name, value: v.value, position: v.position, team: v.team }); side(rid).value += v.value; }
      else side(rid).unpriced.push({ playerId: pid, what: 'player' });
    }
  }

  // Picks. owner_id is who holds it after the trade; roster_id is whose pick it is.
  const labels = new Map();
  /*
   * A slot map belongs to ONE draft.
   *
   * The map we can fetch is the current season's, and a pick for another year
   * will be drawn in an order nobody has generated yet — or one drawn years ago
   * that Sleeper no longer exposes. Using this year's slot for a 2028 pick
   * would price it against a draft position that has nothing to do with it,
   * confidently and invisibly.
   *
   * So the real slot is used only for its own season, and everything else is
   * priced at Mid, which is the honest middle of a round rather than a guess
   * dressed as knowledge. Callers are told, per pick, which one they got.
   */
  const slotFor = pk => (String(pk.season) === String(o.slotSeason) ? slots.get(Number(pk.roster_id)) : null);
  const labelFor = pk => {
    const slot = slotFor(pk);
    if (slot) return { label: pickLabel({ season: pk.season, round: pk.round, slot, teams }), midded: false };
    const ord = ORDINAL[pk.round];
    return ord ? { label: `${pk.season} Mid ${ord}`, midded: true } : { label: null, midded: false };
  };

  for (const pk of trade.draft_picks || []) {
    const { label } = labelFor(pk);
    if (label) labels.set(label, null);
  }
  if (labels.size && page) {
    for (const label of labels.keys()) {
      const v = page.byName.get(label);
      if (v != null) labels.set(label, v);
    }
  } else if (labels.size) {
    const { rows } = await db.query(
      `select name, value from player_values
        where captured_on = $1 and superflex = $2 and position = 'PICK' and name = any($3::text[])`,
      [on, superflex, [...labels.keys()]]);
    for (const r of rows) labels.set(r.name, r.value);
  }

  /*
   * A season the market has not started pricing yet, carried across from one it
   * has. The source lists 2026 picks and no 2027, so "my 2027 second" priced at
   * nothing and no margin could be given for a trade containing one.
   *
   * Sean's call, and it is defensible: a mid second is a mid second.
   *
   * The direction of its error is NOT known, which is the point of recording
   * it. The obvious reasoning says a future pick trades at a discount, since
   * its slot is undecided — and measured against a real 2027 price the moment
   * one became available, that reasoning was backwards: a 2027 Mid 2nd was
   * 4,146 against a 2026 Mid 2nd at 3,712. Mid-draft, this year's remaining
   * picks have already decayed while next year's still hold their option value.
   *
   * So every carried price is repeated back with the margin rather than quietly
   * folded into it, and no claim is made about which way it leans.
   */
  const assumptions = [];
  const missing = [...labels].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    const priced = page
      ? [...page.byName].filter(([n]) => /^\d{4} (Early|Mid|Late) (1st|2nd|3rd|4th)$/.test(n))
          .map(([name, value]) => ({ name, value }))
      : (await db.query(
          `select name, value from player_values
            where captured_on = $1 and superflex = $2 and position = 'PICK'`, [on, superflex])).rows;
    const byShape = new Map();
    for (const r of priced) {
      const m = /^(\d{4}) (Early|Mid|Late) (1st|2nd|3rd|4th)$/.exec(r.name);
      if (!m) continue;
      const shape = `${m[2]} ${m[3]}`;
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push({ year: Number(m[1]), value: r.value, name: r.name });
    }
    for (const label of missing) {
      const m = /^(\d{4}) (Early|Mid|Late) (1st|2nd|3rd|4th)$/.exec(label);
      if (!m) continue;
      const want = Number(m[1]);
      const options = byShape.get(`${m[2]} ${m[3]}`) || [];
      if (!options.length) continue;
      // Nearest priced year, so a 2027 leans on 2026 rather than something old.
      const best = options.sort((a, b) => Math.abs(a.year - want) - Math.abs(b.year - want))[0];
      labels.set(label, best.value);
      assumptions.push({ label, from: best.name, value: best.value });
    }
  }
  for (const pk of trade.draft_picks || []) {
    const { label, midded } = labelFor(pk);
    const value = label ? labels.get(label) : null;
    const assumed = assumptions.find(a => a.label === label) || null;
    const entry = { season: pk.season, round: pk.round, from: Number(pk.roster_id), label, value,
                    assumedFrom: assumed?.from || null, slotUnknown: midded };
    const s = side(pk.owner_id);
    s.picks.push(entry);
    if (value != null) s.value += value;
    else s.unpriced.push({ what: 'pick', season: pk.season, round: pk.round, label });
  }

  const list = [...sides.values()].sort((a, b) => b.value - a.value);
  const anyUnpriced = list.some(s => s.unpriced.length);
  return {
    capturedOn: on,
    superflex,
    sides: list,
    // A margin computed over assets that could not all be priced is not a
    // margin. Null, and the caller says why, rather than a number that quietly
    // treats an unpriceable 2027 second as nothing.
    margin: anyUnpriced ? null : Math.round(list[0].value - list[list.length - 1].value),
    unpricedReason: anyUnpriced
      ? 'at least one asset has no market value on file, so no margin is given'
      : null,
    // Never empty-by-omission: a margin that rests on a carried-over price has
    // to arrive with that fact attached, or it reads as a measurement.
    assumptions,
    /*
     * Graded on the pot, and only when every asset carried a price. A grade
     * computed over a side with an unpriceable pick would be a letter derived
     * from a number the caller was just told not to trust.
     */
    grade: anyUnpriced ? null
      : (() => {
          const margin = list[0].value - list[list.length - 1].value;
          const pot = list.reduce((a, sd) => a + sd.value, 0);
          // Against the league where there is a league to measure against.
          return gradeAgainst(pot ? margin / pot : 0, o.population) || gradeFor(margin, pot);
        })(),
  };
}

/**
 * What the price cannot see: where these players landed.
 *
 * Only the arriving side's own roster is consulted, and only for the same NFL
 * team and position, which is what a handcuff is. Injury status is the point —
 * "a backup" and "the backup to your starter who is carrying a knee injury" are
 * different assets, and only the second explains paying over the odds.
 */
async function rosterFlags(playerIds, rosterPlayerIds) {
  if (!playerIds?.length || !rosterPlayerIds?.length) return [];
  const { rows } = await db.query(
    `select player_id, full_name, position, team, injury_status, injury_body_part,
            injury_notes, depth_chart_order
       from players where player_id = any($1::text[])`,
    [[...new Set([...playerIds, ...rosterPlayerIds])]]);
  const by = new Map(rows.map(r => [String(r.player_id), r]));

  const flags = [];
  for (const pid of playerIds) {
    const got = by.get(String(pid));
    if (!got?.team || !got?.position) continue;

    /*
     * THE STARTER, not merely a teammate.
     *
     * This matched on team and position alone, which is true of four Raiders
     * running backs at once — so it reported "a handcuff" where the honest
     * claim was "one of several men who share a backfield", and a trade got
     * argued down on that vagueness. Depth chart order settles it: the arriving
     * player is a handcuff to the man AHEAD of him, and the nearest one ahead
     * is the one worth naming.
     *
     * Where Sleeper has no order — 1,812 players have one out of 12,000 — the
     * old behaviour stands and the flag says the rank is unknown rather than
     * implying a depth it cannot see.
     */
    const mates = rosterPlayerIds
      .filter(h => String(h) !== String(pid))
      .map(h => by.get(String(h)))
      .filter(o => o && o.team === got.team && o.position === got.position);
    if (!mates.length) continue;

    const ahead = mates
      .filter(o => o.depth_chart_order != null && got.depth_chart_order != null
                   && o.depth_chart_order < got.depth_chart_order)
      .sort((a, b) => b.depth_chart_order - a.depth_chart_order)[0];
    const other = ahead || mates[0];

    flags.push({
      playerId: pid,
      name: got.full_name,
      handcuffOf: other.full_name,
      team: got.team,
      position: got.position,
      starterInjury: other.injury_status || null,
      starterBodyPart: other.injury_body_part || null,
      starterNotes: other.injury_notes || null,
      // Named so a caller can say "the RB2 behind him" instead of "a backup",
      // and so an unknown rank is visible rather than assumed.
      depth: got.depth_chart_order ?? null,
      starterDepth: other.depth_chart_order ?? null,
      // Directly behind him, as opposed to somewhere further down the chart.
      immediate: Boolean(ahead && got.depth_chart_order - ahead.depth_chart_order === 1),
    });
  }
  return flags;
}


/**
 * Who has gained and lost value in trades — at the time, and in hindsight.
 *
 * TWO NUMBERS, because they answer different questions and disagree. "At the
 * time" is whether the market agreed with you the day you made the deal.
 * "Today" is whether it worked out. A manager who systematically buys players
 * the market later re-rates looks bad on the first and good on the second, and
 * that gap is the whole story: this league's most active trader is 13,259 down
 * at the time and 7,666 down today, having clawed back 5,593 without ever
 * getting to level.
 *
 * NO FROZEN VERDICT. A dynasty trade is not over for years, which is why
 * nothing here is stored — the answer is a function of when you ask, and a
 * grade written down once would be a stale opinion presented as a result.
 *
 * Coverage is reported rather than assumed. Older trades fall out entirely when
 * a player leaves the value source's few-hundred-asset universe, and a ledger
 * that quietly skipped them would rank managers on who traded recently.
 */
async function tradeLedger({ trades, book, slots, teams = 12, slotSeason = null, nameOf }) {
  const per = new Map();
  let bothPriced = 0;
  let thenOnly = 0;
  let neither = 0;

  const bump = (rid, field, delta) => {
    const k = nameOf ? nameOf(rid) : `roster ${rid}`;
    const e = per.get(k) || { name: k, then: 0, thenMatched: 0, now: 0, trades: 0, wonThen: 0, lostThen: 0 };
    e[field] += delta;
    per.set(k, e);
    return e;
  };

  for (const t of trades || []) {
    const at = await priceTrade(t, { book, slots, teams, slotSeason, asOf: t.status_updated_at });
    const today = await priceTrade(t, { book, slots, teams, slotSeason, asOf: null });
    if (!at || at.margin == null) { neither++; continue; }

    const winner = at.sides[0].rosterId;
    const loser = at.sides[at.sides.length - 1].rosterId;

    const w = bump(winner, 'then', at.margin);
    const l = bump(loser, 'then', -at.margin);
    w.trades++; l.trades++;
    w.wonThen++; l.lostThen++;

    /*
     * Today's margin is keyed to the SAME side that won at the time, so a
     * negative number means the deal has since turned against them. Re-sorting
     * by today's winner would silently compare two different things.
     */
    if (today && today.margin != null) {
      const a = today.sides.find(s => s.rosterId === winner);
      const b = today.sides.find(s => s.rosterId === loser);
      if (a && b) {
        bump(winner, 'now', a.value - b.value);
        bump(loser, 'now', b.value - a.value);
        /*
         * The SAME trade's then-value, banked separately.
         *
         * A swing is only a swing if both ends cover the same deals. Summing
         * "then" over every priced trade and "now" over the subset that still
         * prices made the league's most active trader look 18,295 recovered
         * when most of that was trades simply missing from the second total.
         */
        bump(winner, 'thenMatched', at.margin);
        bump(loser, 'thenMatched', -at.margin);
        bothPriced++;
      } else thenOnly++;
    } else thenOnly++;
  }

  const rows = [...per.values()].map(r => ({
    ...r,
    then: Math.round(r.then),
    thenMatched: Math.round(r.thenMatched),
    now: Math.round(r.now),
    // Only over deals that price at both ends. Anything else is comparing two
    // different sets of trades and calling the difference a result.
    swing: Math.round(r.now - r.thenMatched),
  })).sort((a, b) => b.now - a.now);

  return { rows, coverage: { bothPriced, thenOnly, unpriced: neither, total: (trades || []).length } };
}


/*
 * Raw market value means nothing to a person.
 *
 * "+7,492 as things stand" is a number off a value sheet and nobody in a group
 * chat has any feel for it. The currency dynasty players actually think in is
 * PICKS: everybody knows roughly what a first is worth and what a third is not.
 *
 * So the ladder of pick prices doubles as a translation table. The year is
 * dropped and the same rung averaged across seasons, because "a mid 1st" is the
 * unit people speak in and "a 2028 Mid 1st" is a different, more precise thing
 * than anybody means.
 */
function pickLadder(rows) {
  const buckets = new Map();
  for (const r of rows || []) {
    const m = /^(\d{4}) (Early|Mid|Late) (1st|2nd|3rd|4th)$/.exec(r.name);
    if (!m) continue;
    const label = `${m[2].toLowerCase()} ${m[3]}`;
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(r.value);
  }
  return [...buckets].map(([label, vals]) => ({
    label, value: Math.round(vals.reduce((a, v) => a + v, 0) / vals.length),
  })).sort((a, b) => b.value - a.value);
}

/**
 * Say a value in picks: "about a mid 1st", "roughly two firsts".
 *
 * Deliberately vague at the edges. Below the cheapest rung there is no pick
 * worth saying, and past the top one the honest phrasing is multiples rather
 * than a rung nobody would recognise.
 */
function inPicks(value, ladder) {
  if (!ladder?.length || value == null) return null;
  const v = Math.abs(value);
  const top = ladder[0];
  const bottom = ladder[ladder.length - 1];
  // "a early 1st" is how a machine talks.
  const a = label => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;

  // Phrased to follow "up" or "down" without reading like a form letter.
  if (v < bottom.value * 0.6) return 'barely anything, less than a late fourth';
  if (v >= top.value * 1.5) {
    const n = Math.round(v / top.value);
    return n <= 1 ? `a bit more than ${a(top.label)}` : `about ${n} first round picks`;
  }

  const nearest = ladder.reduce((best, r) =>
    Math.abs(r.value - v) < Math.abs(best.value - v) ? r : best, ladder[0]);

  /*
   * "About" has to mean about. Snapping 8,822 to a 6,378 rung and calling it
   * "about an early 1st" is a 38% error stated as a comparison — the whole
   * point of the translation is to be roughly right in a unit people feel, and
   * being confidently wrong in that unit is worse than the raw number was.
   */
  if (Math.abs(nearest.value - v) / nearest.value <= 0.15) return `about ${a(nearest.label)}`;

  if (v > top.value) return `more than ${a(top.label)}`;
  const above = [...ladder].reverse().find(r => r.value >= v);
  const below = ladder.find(r => r.value <= v);
  if (above && below && above.label !== below.label) {
    return `between ${a(below.label)} and ${a(above.label)}`;
  }
  return `about ${a(nearest.label)}`;
}

/*
 * A trader's grade, from where they sit in their own league.
 *
 * Rank-based rather than absolute, because raw totals depend on how much a
 * league trades: +3,000 is a fortune in a quiet league and noise in a busy one.
 * Being second of twelve means the same thing everywhere.
 */
function traderGrade(rank, of) {
  if (!rank || !of) return null;
  const pct = (rank - 1) / Math.max(1, of - 1);
  // A+ is first place, not "near the top" — two of them in a twelve team league
  // is a grade nobody believes.
  if (rank === 1) return { grade: 'A+', say: 'the best in the league at it' };
  if (pct <= 0.25) return { grade: 'A', say: 'one of the best' };
  if (pct <= 0.40) return { grade: 'B+', say: 'ahead of most' };
  if (pct <= 0.60) return { grade: 'B', say: 'about average' };
  if (pct <= 0.75) return { grade: 'C+', say: 'behind most' };
  if (pct < 1) return { grade: 'C', say: 'one of the worst' };
  return { grade: 'D', say: 'dead last in the league at it' };
}

module.exports = { priceTrade, loadValueBook, tradeLedger, pickLadder, inPicks, traderGrade,
  gradeAgainst, MIN_POPULATION, rosterFlags, gradeFor, pickLabel, bucketFor, slotsFromDraft, slotsFromFinish };

/**
 * Every season this league has ever played.
 *
 * The reply context carried ONE snapshot of the current season plus ONE
 * archived season, both `limit 1`. That is enough to answer "who is winning"
 * and nothing else — and "who is winning" is the least interesting thing a
 * league group chat asks. The material that lands is the long memory: who has
 * never won, who folds in November every single year, who has finished last
 * twice.
 *
 * Sleeper keeps it all. Each league row carries previous_league_id, so the
 * chain walks back season by season — this one goes to 2020.
 *
 * WHY A SUMMARY AND NOT MORE CONTEXT. The obvious move is to raise the limit
 * and hand the model six seasons of tables. That does not fit, and it would not
 * help if it did: a model given 1,200 rows of weekly scores writes worse jokes
 * than one given "Marcus: 6 seasons, 41-61, never made a final". Facts per
 * MANAGER, computed once, is both smaller and better material.
 *
 * The join across seasons is sleeper_user_id. Team names change every year and
 * half of them are jokes; the account does not.
 */

const db = require('./db');
const sleeper = require('./sleeper');

/** Walk previous_league_id back to the beginning. Newest first. */
async function chain(sleeperLeagueId, { max = 20 } = {}) {
  const out = [];
  let id = sleeperLeagueId;
  while (id && out.length < max) {
    const lg = await sleeper.league(id).catch(() => null);
    if (!lg) break;
    out.push(lg);
    id = lg.previous_league_id;
  }
  return out;
}

/**
 * The archive row for one past season.
 *
 * provider='archive', no chat_id, active=false — the same shape
 * scripts/backfill.js uses, so a historical season can never become a target
 * for outbound messages. That is not tidiness: leagues are iterated by the
 * worker, and a season from 2021 receiving a recap would be memorable for the
 * wrong reasons.
 */
async function archiveLeague(lg) {
  const { rows: existing } = await db.query(
    'select * from leagues where sleeper_league_id = $1 and chat_id is null limit 1',
    [lg.league_id]
  );
  if (existing[0]) return existing[0];
  const { rows } = await db.query(
    `insert into leagues (name, sleeper_league_id, provider, chat_id, active, season)
     values ($1, $2, 'archive', null, false, $3) returning *`,
    [`${lg.name} ${lg.season}`, lg.league_id, lg.season]
  );
  return rows[0];
}

/**
 * How busy each roster was, for one season.
 *
 * Activity is not in the roster settings. total_moves exists there and is zero
 * for every roster in all six of this league's seasons, so it cannot be used;
 * the only real source is the transaction log, a call per week.
 *
 * That is 18 calls a season and 108 across the archive, which is far too much
 * to do while somebody waits for a reply. So it is computed ONCE and stored on
 * the snapshot, the same way champion_roster_id and toilet_roster_id are. A
 * finished season never changes.
 *
 * Counted per ROSTER rather than per creator: a trade is activity for both
 * sides, and a waiver claim processed by the league still belongs to whoever
 * asked for it. Only completed transactions count, since a failed waiver claim
 * is an intention, not a move.
 */
async function movesByRoster(sleeperLeagueId, { weeks = 18 } = {}) {
  const out = {};
  const all = await Promise.all(
    Array.from({ length: weeks }, (_, i) =>
      sleeper.get(`/league/${sleeperLeagueId}/transactions/${i + 1}`).catch(() => []))
  );
  for (const week of all) {
    for (const t of week || []) {
      if (t.status !== 'complete') continue;
      for (const rid of t.roster_ids || []) out[rid] = (out[rid] || 0) + 1;
    }
  }
  return out;
}

/**
 * Every game the league has ever played, for one season.
 *
 * A final snapshot holds week 17 and nothing else, which answers "what was the
 * record" and none of the questions a group chat actually asks: the closest
 * game ever, the biggest hiding, the highest score anybody has posted. Asked
 * for the closest game in league history the bot correctly said it had no game
 * logs, and it was right, because a season was one row deep.
 *
 * A matchup row is per ROSTER, so the two sides are paired on matchup_id. A
 * pair that is not exactly two is skipped rather than guessed at: that is a bye
 * or a broken week, not a game.
 *
 * 17 calls a season, 102 across the archive, which is the same reason as
 * movesByRoster for computing it once and storing it. 582 games came to 23KB,
 * so this rides on the snapshot rather than earning a table.
 */
async function gamesFor(sleeperLeagueId, { weeks = 17, playoffWeekStart = 15 } = {}) {
  const all = await Promise.all(
    Array.from({ length: weeks }, (_, i) =>
      sleeper.get(`/league/${sleeperLeagueId}/matchups/${i + 1}`).catch(() => []))
  );

  const games = [];
  all.forEach((rows, i) => {
    const byMatchup = new Map();
    for (const r of rows || []) {
      if (r.matchup_id == null || r.points == null) continue;
      const pair = byMatchup.get(r.matchup_id) || [];
      pair.push(r);
      byMatchup.set(r.matchup_id, pair);
    }
    for (const [, pair] of byMatchup) {
      if (pair.length !== 2) continue;
      /*
       * The LINEUP rides along, because the call that returns the score already
       * returns it and the first cut threw it away.
       *
       * Asked what management mistakes were made in a specific matchup, the bot
       * had nothing, and that class of question cannot be pre-computed at all:
       * the game being asked about is chosen after the prompt is built. Keeping
       * starters and the points every rostered player scored turns it into a
       * lookup. 486 bytes a row, roughly 600KB across the whole archive.
       *
       * Stored as ids, not names. Player names change, get traded and retire;
       * the id does not, and src/sleeper.js already has allPlayers to resolve
       * them at read time.
       */
      const side = m => ({
        r: Number(m.roster_id),
        p: Math.round(m.points * 100) / 100,
        s: m.starters || [],
        pp: m.players_points || {},
      });
      const one = side(pair[0]), two = side(pair[1]);
      games.push({
        w: i + 1,
        po: i + 1 >= playoffWeekStart ? 1 : 0,
        a: one.r, ap: one.p, b: two.r, bp: two.p,
        lineups: { [one.r]: { s: one.s, pp: one.pp }, [two.r]: { s: two.s, pp: two.pp } },
      });
    }
  });
  return games;
}

/**
 * Where everyone ACTUALLY finished, from the playoff bracket.
 *
 * Not the same thing as the regular season table, and 2025 is the argument:
 * the top four in the table came out exactly reversed in the bracket. Whitlock
 * topped the standings and finished fourth; Kellan was fourth and won it. A
 * league cares about both and they answer different questions.
 *
 * Places 1 to 6 come from the winners bracket, where Sleeper marks the final
 * round with p: p=1 decides first and second, p=3 third and fourth, p=5 fifth
 * and sixth. Verified against champion_roster_id, which is derived separately.
 *
 * LAST comes from the losers bracket and NOTHING ELSE DOES. In this league the
 * winner of that bracket's p=1 is the team that takes the punishment, confirmed
 * against four seasons of the commissioner's own recollection. Whether the rest
 * of that bracket runs 7-to-12 or 12-to-7 is not something the API states, so
 * places 7 through 11 are left absent rather than guessed. An absent place is
 * honest; a wrong one is an argument in the group chat.
 */
async function finalPlacements(sleeperLeagueId) {
  const [win, lose] = await Promise.all([
    sleeper.get(`/league/${sleeperLeagueId}/winners_bracket`).catch(() => null),
    sleeper.get(`/league/${sleeperLeagueId}/losers_bracket`).catch(() => null),
  ]);
  const places = {};

  for (const [p, first, second] of [[1, 1, 2], [3, 3, 4], [5, 5, 6]]) {
    const m = (win || []).filter(x => x.p === p && x.w).sort((a, b) => (b.r || 0) - (a.r || 0))[0];
    if (!m) continue;
    places[first] = Number(m.w);
    if (m.l != null) places[second] = Number(m.l);
  }

  const bottom = (lose || []).filter(x => x.p === 1 && x.w).sort((a, b) => (b.r || 0) - (a.r || 0))[0];
  if (bottom?.w != null) places.last = Number(bottom.w);

  return Object.keys(places).length ? places : null;
}

/**
 * Who took the toilet bowl.
 *
 * NOT the same thing as finishing bottom of the regular season table, and in
 * this league they were different people in 2020, 2022 and 2024 — half the
 * seasons on record. Reporting one as the other is how the bot gets corrected
 * by twelve people at once.
 *
 * The field is the WINNER of the p=1 match in the losers bracket, which reads
 * backwards and is worth stating plainly so nobody "fixes" it later: in this
 * league that team is the one who takes the punishment. Confirmed against four
 * seasons of the commissioner's own recollection - tdermott96 in 2025, smeadows in
 * 2024, bvosberg7 in 2022 and oldwreckers (now gowreckers42) in 2023 - which
 * is the only reason to trust it over the reading the name suggests.
 *
 * Null when a season exposes no losers bracket, which is a real state and not
 * a zero: it means unknown, never "nobody lost".
 */
async function toiletLoser(sleeperLeagueId) {
  try {
    const bracket = await sleeper.get(`/league/${sleeperLeagueId}/losers_bracket`);
    const final = (bracket || [])
      .filter(m => m.p === 1 && m.w)
      .sort((a, b) => (b.r || 0) - (a.r || 0))[0];
    return final?.w ?? null;                     // roster_id
  } catch {
    return null;
  }
}

/**
 * Capture one completed season.
 *
 * The FINAL week only. Every week would be 17 times the calls and rows to
 * answer questions nobody asks — a roster's cumulative wins and points already
 * sit in its settings at the end of the year, so the last week carries the
 * whole season's record. Weekly detail is a separate feature if head-to-head
 * ever becomes worth it.
 */
async function captureSeason(lg, { week = 17 } = {}) {
  const league = await archiveLeague(lg);
  const payload = await sleeper.weekSnapshot(lg.league_id, week);

  // Who actually won it. Sleeper knows, and "you have never won this" is worth
  // more than any number in a standings table.
  let champion = null;
  try {
    const bracket = await sleeper.get(`/league/${lg.league_id}/winners_bracket`);
    const final = (bracket || []).filter(m => m.w).sort((a, b) => (b.r || 0) - (a.r || 0))[0];
    if (final?.w) champion = final.w;            // roster_id
  } catch { /* older seasons may not expose one */ }

  const toilet = await toiletLoser(lg.league_id);
  const finalPlaces = await finalPlacements(lg.league_id).catch(() => null);
  const moves = await movesByRoster(lg.league_id).catch(() => ({}));
  const games = await gamesFor(lg.league_id,
    { playoffWeekStart: payload.league?.settings?.playoff_week_start ?? 15 }).catch(() => []);

  await db.recordSnapshot({
    leagueId: league.id,
    season: lg.season,
    week,
    kind: 'final',
    payload: { ...payload, champion_roster_id: champion },
  });
  return { league, season: lg.season, champion, toilet };
}

/**
 * The game records: closest, biggest hiding, highest and lowest score.
 *
 * 582 games cannot go in a prompt, and they do not need to. The questions a
 * chat asks about game logs are superlatives, so the superlatives are computed
 * here and the log stays in the snapshot.
 *
 * The winner is worked out from the SCORES, not from field order. The first
 * pass of this labelled side a as the winner and reported the closest game
 * backwards, which is the kind of mistake that is invisible until somebody who
 * was there reads it.
 */
async function gameRecords(sleeperLeagueId) {
  const seasons = await chain(sleeperLeagueId);
  const ids = seasons.map(s => s.league_id);
  if (!ids.length) return null;

  const { rows } = await db.query(
    `select s.season, s.payload from snapshots s
       join leagues l on l.id = s.league_id
      where l.sleeper_league_id = any($1::text[]) and s.kind = 'final'
      order by s.season asc`, [ids]);

  const games = [];
  for (const { season, payload } of rows) {
    const users = new Map((payload.users || []).map(u => [u.user_id, u.display_name]));
    const owner = new Map((payload.rosters || []).map(r => [Number(r.roster_id), r.owner_id]));
    for (const g of payload.games || []) {
      const side = (rid, pts) => ({ userId: owner.get(rid), name: users.get(owner.get(rid)) || null, points: pts });
      const one = side(g.a, g.ap), two = side(g.b, g.bp);
      const [winner, loser] = g.ap >= g.bp ? [one, two] : [two, one];
      games.push({
        season, week: g.w, playoff: Boolean(g.po),
        winner, loser, margin: Math.round(Math.abs(g.ap - g.bp) * 100) / 100,
      });
    }
  }
  if (!games.length) return null;

  const byMargin = [...games].sort((a, b) => a.margin - b.margin);
  /*
   * COMBINED totals, which is a different question from the lowest single
   * score and was asked within an hour of the single-score version shipping.
   * Noted rather than hidden: this is the block approach growing one line per
   * question, which is the argument for a query layer, not against this line.
   */
  const byTotal = [...games].sort((a, b) =>
    (a.winner.points + a.loser.points) - (b.winner.points + b.loser.points));
  const total = g => Math.round((g.winner.points + g.loser.points) * 100) / 100;
  const byScore = [...games].flatMap(g => [
    { ...g, who: g.winner, points: g.winner.points },
    { ...g, who: g.loser, points: g.loser.points },
  ]).sort((a, b) => b.points - a.points);

  const spanSeasons = [...new Set(games.map(g => String(g.season)))].sort();
  return {
    total: games.length,
    from: spanSeasons[0], to: spanSeasons.at(-1),
    closest: byMargin.slice(0, 3),
    blowout: byMargin.at(-1),
    lowestCombined: byTotal.slice(0, 2).map(g => ({ ...g, combined: total(g) })),
    highestCombined: { ...byTotal.at(-1), combined: total(byTotal.at(-1)) },
    highest: byScore[0],
    lowest: byScore.at(-1),
  };
}

/**
 * The records, for the prompt. Four lines out of 582 games.
 */
function gameRecordsBlock(records, names = new Map()) {
  if (!records) return '';
  const who = p => {
    const known = names.get(p.userId);
    return known && p.name && known !== p.name ? `${known} (${p.name})` : known || p.name || 'unknown';
  };
  const when = g => `${g.season} week ${g.week}${g.playoff ? ' (playoff)' : ''}`;
  const line = g => `${when(g)}: ${who(g.winner)} ${g.winner.points} beat ${who(g.loser)} ${g.loser.points}, `
                  + `by ${g.margin}`;

  const L = [`GAME RECORDS (every one of the ${records.total} games this league has played, `
           + `${records.from} to ${records.to}. These are exact, quote them as they are):`];
  L.push(`  closest game ever: ${line(records.closest[0])}`);
  for (const g of records.closest.slice(1)) L.push(`  next closest: ${line(g)}`);
  L.push(`  biggest hiding: ${line(records.blowout)}`);
  for (const g of records.lowestCombined || []) {
    L.push(`  lowest COMBINED total in one matchup (both teams added together, not the same `
         + `as the lowest single score below): ${when(g)}, ${who(g.winner)} ${g.winner.points} `
         + `and ${who(g.loser)} ${g.loser.points}, ${g.combined} between them`);
  }
  if (records.highestCombined) {
    const g = records.highestCombined;
    L.push(`  highest COMBINED total: ${when(g)}, ${who(g.winner)} ${g.winner.points} and `
         + `${who(g.loser)} ${g.loser.points}, ${g.combined} between them`);
  }
  L.push(`  highest score by anyone: ${who(records.highest.who)} ${records.highest.points}, ${when(records.highest)}`);
  L.push(`  lowest score by anyone: ${who(records.lowest.who)} ${records.lowest.points}, ${when(records.lowest)}`);
  return L.join('\n');
}

/*
 * What a flex slot will accept. Anything not listed takes its own position.
 */
const FLEX_SLOTS = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'] };

/**
 * Points left on the bench, per roster-week, across the whole archive.
 *
 * POSITION ELIGIBILITY IS THE WHOLE JOB. Comparing the best bench score to the
 * worst starter is one line and produces claims like "you should have started
 * your backup QB at running back", which is worse than saying nothing: it is
 * confidently wrong in front of the person who made the decision. So a swap
 * only counts when the benched player could legally have filled the slot the
 * starter occupied, which needs roster_positions and a position per player.
 *
 * Positions come from the local players table, not sleeper.allPlayers(). That
 * endpoint is 15MB and Sleeper's own docs say once a day at most; the table is
 * already synced and is a join instead of a download.
 *
 * Only the single best swap per roster-week is kept. A full optimal-lineup
 * solve would find more points, but "you left 39 on the bench" invites an
 * argument about the solver, while "you started Montgomery for zero over Taylor
 * for 39.8" is a thing that happened and nobody can dispute.
 */
const benchCache = new Map();

async function benchMistakes(sleeperLeagueId, { limit = 3 } = {}) {
  /*
   * Cached for the life of the process. Every season this reads is finished, so
   * the answer cannot change, and the alternative is 12,000 player rows and a
   * pass over 582 games on every single reply.
   */
  const cacheKey = `${sleeperLeagueId}:${limit}`;
  if (benchCache.has(cacheKey)) return benchCache.get(cacheKey);

  const seasons = await chain(sleeperLeagueId);
  const ids = seasons.map(s => s.league_id);
  if (!ids.length) return [];

  const { rows } = await db.query(
    `select s.season, s.payload from snapshots s
       join leagues l on l.id = s.league_id
      where l.sleeper_league_id = any($1::text[]) and s.kind = 'final'
      order by s.season asc`, [ids]);
  if (!rows.length) return [];

  const { rows: players } = await db.query(
    'select player_id, full_name, position from players where position is not null');
  const byId = new Map(players.map(p => [p.player_id, p]));

  const out = [];
  for (const { season, payload } of rows) {
    const slots = (payload.league?.roster_positions || []).filter(s => s !== 'BN');
    const users = new Map((payload.users || []).map(u => [u.user_id, u.display_name]));
    const owner = new Map((payload.rosters || []).map(r => [Number(r.roster_id), r.owner_id]));

    for (const g of payload.games || []) {
      for (const [rosterId, lineup] of Object.entries(g.lineups || {})) {
        const started = new Set(lineup.s || []);
        const points = lineup.pp || {};
        const bench = Object.keys(points).filter(id => !started.has(id));

        let best = null;
        (lineup.s || []).forEach((starterId, i) => {
          const slot = slots[i];
          if (!slot) return;
          const eligible = FLEX_SLOTS[slot] || [slot];
          const starterPts = points[starterId] ?? 0;

          for (const benchId of bench) {
            const p = byId.get(benchId);
            if (!p || !eligible.includes(p.position)) continue;
            const gain = Math.round(((points[benchId] ?? 0) - starterPts) * 100) / 100;
            if (gain > 0 && (!best || gain > best.cost)) {
              best = {
                cost: gain, slot,
                benched: p.full_name, benchedPoints: points[benchId] ?? 0,
                started: byId.get(starterId)?.full_name || starterId, startedPoints: starterPts,
              };
            }
          }
        });

        if (best) {
          const userId = owner.get(Number(rosterId));
          out.push({ season, week: g.w, playoff: Boolean(g.po),
            userId, name: users.get(userId) || null, ...best });
        }
      }
    }
  }

  out.sort((a, b) => b.cost - a.cost);
  const top = out.slice(0, limit);
  benchCache.set(cacheKey, top);
  return top;
}

/** The worst lineup calls, for the prompt. */
function benchBlock(rows, names = new Map()) {
  if (!rows?.length) return '';
  const who = r => {
    const known = names.get(r.userId);
    return known && r.name && known !== r.name ? `${known} (${r.name})` : known || r.name || 'unknown';
  };
  const L = ['WORST LINEUP CALLS EVER (a benched player who could legally have filled the slot,'
           + ' and outscored the starter. Position eligibility is already checked, so these are'
           + ' real. Points, not hindsight about matchups):'];
  for (const r of rows) {
    L.push(`  ${r.season} week ${r.week}${r.playoff ? ' (playoff)' : ''} ${who(r)}: started `
         + `${r.started} for ${r.startedPoints} over ${r.benched} for ${r.benchedPoints} `
         + `at ${r.slot}, ${r.cost} points left on the bench`);
  }
  return L.join('\n');
}

/**
 * Career facts per manager, across every archived season of this league line.
 *
 * Returns one compact row per Sleeper account. Deliberately small: this goes
 * into a prompt on every reply, so it has to earn its tokens.
 */
async function career(sleeperLeagueId) {
  const seasons = await chain(sleeperLeagueId);
  const ids = seasons.map(s => s.league_id);
  if (!ids.length) return [];

  const { rows } = await db.query(
    `select s.season, s.payload
       from snapshots s
       join leagues l on l.id = s.league_id
      where l.sleeper_league_id = any($1::text[]) and s.kind = 'final'
      order by s.season asc`,
    [ids]
  );
  if (!rows.length) return [];

  const byUser = new Map();
  for (const { season, payload } of rows) {
    const users = new Map((payload.users || []).map(u => [u.user_id, u]));
    const standings = (payload.rosters || [])
      .map(r => ({
        userId: r.owner_id,
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        points: Number(r.settings?.fpts ?? 0) + Number(r.settings?.fpts_decimal ?? 0) / 100,
        against: Number(r.settings?.fpts_against ?? 0) + Number(r.settings?.fpts_against_decimal ?? 0) / 100,
        rosterId: r.roster_id,
      }))
      // Sleeper's own tiebreak: record first, then points scored.
      .sort((a, b) => (b.wins - a.wins) || (b.points - a.points));

    /*
     * A ROSTER WITHOUT AN OWNER IS A REAL STATE, not corrupt data.
     *
     * Sleeper's users list and rosters list do not have to line up, and both
     * mismatches occur in leagues already in this system:
     *
     *   a manager with no roster  — a co-owner sharing somebody else's team, or
     *     somebody who left and is still listed. The Danger Zone! has one of
     *     these, and it is a co-owner: their handle is the other manager's team
     *     name.
     *
     *   a roster with no owner    — an unassigned team. Halcyon Kings 2026
     *     has one, which is why Ivers's member row carries a phone and a roster
     *     and no sleeper_user_id: the binding had nothing to resolve against.
     *
     * So an incomplete binding is expected and must degrade rather than throw.
     * The skip below is that, and it has a cost worth knowing: if a season ENDS
     * with a roster unowned, that team's record is absent from career entirely.
     * Fine today, since every completed season here is fully owned, and wrong
     * the first time somebody finishes a year without claiming their team.
     */
    standings.forEach((s, i) => {
      if (!s.userId) return;
      const u = byUser.get(s.userId) || {
        userId: s.userId,
        name: users.get(s.userId)?.display_name || null,
        seasons: 0, wins: 0, losses: 0, ties: 0, points: 0, against: 0,
        best: null, worst: null, titles: 0, lasts: 0, toilets: 0, toiletSeasons: [],
        moves: 0, movesBySeason: [], finishes: [], finalFinishes: [],
        titleSeasons: [], lastSeasons: [],
      };
      u.name = users.get(s.userId)?.display_name || u.name;
      u.seasons += 1;
      u.wins += s.wins; u.losses += s.losses; u.ties += s.ties;
      u.points += s.points;
      u.against += s.against;
      const mv = (payload.moves_by_roster || {})[s.rosterId] ?? null;
      if (mv !== null) { u.moves += mv; u.movesBySeason.push({ season, moves: mv }); }
      const place = i + 1;
      u.finishes.push({ season, place });

      /*
       * Where they ACTUALLY finished, which is a different fact from where they
       * finished the regular season. In 2025 the top four of the table came out
       * exactly reversed in the bracket. Only recorded where the bracket states
       * it: places 1-6 and last. An absent place is honest, a guessed one is an
       * argument in the group chat.
       */
      const fp = payload.final_places || {};
      for (const key of Object.keys(fp)) {
        if (Number(fp[key]) !== s.rosterId) continue;
        u.finalFinishes.push({ season, place: key === 'last' ? 'last' : Number(key) });
      }
      if (u.best === null || place < u.best) u.best = place;
      if (u.worst === null || place > u.worst) u.worst = place;
      if (place === standings.length) { u.lasts += 1; u.lastSeasons.push(season); }
      if (payload.champion_roster_id && payload.champion_roster_id === s.rosterId) {
        u.titles += 1; u.titleSeasons.push(season);
      }
      if (payload.toilet_roster_id && payload.toilet_roster_id === s.rosterId) {
        u.toilets += 1; u.toiletSeasons.push(season);
      }
      byUser.set(s.userId, u);
    });
  }

  return [...byUser.values()]
    .map(u => ({
      ...u,
      points: Math.round(u.points),
      against: Math.round(u.against),
      /*
       * Average REGULAR SEASON finish, computed here because the model is told
       * not to compute. Asked for the best average finishes it correctly
       * refused — "not a stat I've got printed" — and it was right to:
       * answer.js forbids arithmetic that nobody verified, which is the rule
       * that keeps it from inventing numbers under pressure. The gap was mine.
       * The places were already recorded; nothing added them up.
       */
      avgFinish: u.finishes.length
        ? Math.round((u.finishes.reduce((n, f) => n + f.place, 0) / u.finishes.length) * 10) / 10
        : null,
      /*
       * Seasons finishing in the top three. "Top 3 average finishes" is
       * genuinely ambiguous — the three best averages, or how often somebody
       * made the podium — and both readings come out of the same array, so
       * printing both costs a few characters and removes the guess.
       */
      podiums: u.finishes.filter(f => f.place <= 3).length,
      // The bracket version of the same question. Kept separate on purpose:
      // a top-three table finish and a top-three actual finish are different
      // achievements and this league's members care about both.
      finalPodiums: u.finalFinishes.filter(f => typeof f.place === 'number' && f.place <= 3).length,
    }))
    .sort((a, b) => (b.wins / Math.max(1, b.wins + b.losses)) - (a.wins / Math.max(1, a.wins + a.losses)));
}

/**
 * Activity, and whether it is going up or down.
 *
 * Sean's point, and the nuance is the whole value: Brennan made 390 moves over
 * six seasons against 276 for the next busiest, and he also has the best record
 * in the league, so it looks like effort paying off. It does not always. Whitlock
 * is 11th in activity and 4th by record, which is the same schedule luck the
 * luck block already flags, and Marek is 11th in activity while sitting 2nd in
 * scoring.
 *
 * So this reports the counts and the DIRECTION, and leaves the causation alone.
 * The direction is the part nobody can see from a single season: Danner has gone
 * 36, 34, 43, 22, 9, 2. That is not a manager having a quiet year, that is a
 * manager leaving, and it is the exact thing this product exists to notice.
 */
function activityBlock(rows, names = new Map()) {
  const withMoves = rows.filter(r => r.movesBySeason?.length);
  if (withMoves.length < 2) return '';
  const who = r => {
    const known = names.get(r.userId);
    return known && r.name && known !== r.name ? `${known} (${r.name})` : known || r.name || r.userId;
  };
  const byMoves = [...withMoves].sort((a, b) => b.moves - a.moves);

  const L = ['ACTIVITY (completed adds, drops, waivers and trades. Busier is not the same as'
           + ' better, and you must not claim it is. Say what the counts are and let it lie):'];
  for (const r of byMoves) {
    const seasons = r.movesBySeason.map(m => m.moves);
    // First half against second half, so a drift shows up without a regression.
    const half = Math.floor(seasons.length / 2);
    const early = seasons.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
    const late = seasons.slice(-half).reduce((a, b) => a + b, 0) / Math.max(1, half);
    const trend = half && early >= 5 && late <= early * 0.5 ? ', and falling away sharply'
                : half && late >= early * 1.75 ? ', and climbing' : '';
    L.push(`  ${who(r)}: ${r.moves} moves over ${r.movesBySeason.length} seasons `
         + `(${r.movesBySeason.map(m => m.season + ':' + m.moves).join(' ')})${trend}`);
  }
  return L.join('\n');
}

/**
 * Champions by season.
 *
 * Same reason as the toilet bowl roll: the count says a title exists and cannot
 * say which year, and "when did Marlow win" is how the question gets asked. Six
 * lines, and they are the six the league argues about most.
 */
function championBlock(rows, names = new Map()) {
  const bySeason = [];
  for (const r of rows) {
    const known = names.get(r.userId);
    const who = known && r.name && known !== r.name ? `${known} (${r.name})` : known || r.name || r.userId;
    for (const season of r.titleSeasons || []) bySeason.push({ season, who });
  }
  if (!bySeason.length) return '';
  bySeason.sort((a, b) => String(b.season).localeCompare(String(a.season)));
  return ['CHAMPIONS by season (the playoff bracket, which is what "won it" means. Not the same'
        + ' as topping the regular season table):']
    .concat(bySeason.map(t => `  ${t.season}: ${t.who}`)).join('\n');
}

/**
 * The roll of shame, by season.
 *
 * The count alone cannot answer "who lost it in 2022", which is the form the
 * question actually takes in a chat. Six lines, and they are the six lines this
 * league will quote most.
 */
function toiletBlock(rows, names = new Map()) {
  const bySeason = [];
  for (const r of rows) {
    const known = names.get(r.userId);
    const who = known && r.name && known !== r.name ? `${known} (${r.name})` : known || r.name || r.userId;
    for (const season of r.toiletSeasons || []) bySeason.push({ season, who });
  }
  if (!bySeason.length) return '';
  bySeason.sort((a, b) => String(b.season).localeCompare(String(a.season)));
  return ['TOILET BOWL, the punishment bracket, by season. This is what the chat means by'
        + ' "last", and it is NOT the same as finishing bottom of the regular season table:']
    .concat(bySeason.map(t => `  ${t.season}: ${t.who}`)).join('\n');
}

/**
 * Luck, as the gap between how much you scored and how much you won.
 *
 * Sean's framing and it is the right one: a good record built on low points for
 * AND low points against is a schedule, not a team. Season totals are all this
 * has - there are no weekly scores in a final snapshot - so this cannot do a
 * true all play record. Ranking scoring against ranking record over six seasons
 * is the honest approximation, and it is a COMPUTED comparison for the same
 * reason the extremes are: asked who got lucky, a model handed twelve rows of
 * points will rank them itself and state the result as fact.
 *
 * Positive luck means they won more than their scoring paid for.
 */
function luck(rows) {
  if (rows.length < 2) return [];
  const pct = r => r.wins / Math.max(1, r.wins + r.losses);
  const byPoints = [...rows].sort((a, b) => b.points - a.points);
  const byRecord = [...rows].sort((a, b) => pct(b) - pct(a));
  const pfRank = new Map(byPoints.map((r, i) => [r.userId, i + 1]));
  const wRank = new Map(byRecord.map((r, i) => [r.userId, i + 1]));
  return rows.map(r => ({
    userId: r.userId, name: r.name,
    pointsFor: r.points, pointsAgainst: r.against,
    scoringRank: pfRank.get(r.userId), recordRank: wRank.get(r.userId),
    luck: pfRank.get(r.userId) - wRank.get(r.userId),
  })).sort((a, b) => b.luck - a.luck);
}

/**
 * The luck block, printed only for the managers where the gap is real.
 *
 * A gap of one or two places over six seasons is noise, and printing twelve
 * rows of it invites the model to call somebody lucky on a rounding error.
 * Three places is the floor for saying it out loud.
 */
function luckBlock(rows, names = new Map()) {
  const notable = luck(rows).filter(l => Math.abs(l.luck) >= 3);
  if (!notable.length) return '';
  const who = l => {
    const known = names.get(l.userId);
    return known && l.name && known !== l.name ? `${known} (${l.name})` : known || l.name || l.userId;
  };
  const L = ['LUCK (scoring rank against record rank, six seasons. A record that outruns the'
           + ' scoring is a schedule, not a team. Only these managers have a gap worth'
           + ' mentioning, everyone else finished about where they scored):'];
  for (const l of notable) {
    L.push(`  ${who(l)}: ${l.pointsFor} points for, ${l.pointsAgainst} against, `
         + `${ordinal(l.scoringRank)} in scoring but ${ordinal(l.recordRank)} by record `
         + `(${l.luck > 0 ? 'won more than they scored for' : 'scored more than they won for'})`);
  }
  return L.join('\n');
}

/**
 * One line per manager, for the prompt. Short on purpose.
 *
 * `names` maps sleeper_user_id to the person's real name, and passing it is not
 * optional in practice. KNOWN PEOPLE is keyed on display names and this block
 * is keyed on Sleeper usernames, so without the join the model cannot tell that
 * Sean is smeadows — and it does not guess, because PERSONA forbids it. Asked "is
 * Sean any good" it correctly answered that it had nothing to judge, while the
 * answer sat four lines below in a block it could not connect.
 *
 * Both labels are printed. Somebody may ask about "Sean" or about "smeadows", and
 * the model should not have to pick.
 */
function careerBlock(rows, names = new Map()) {
  if (!rows.length) return '';
  const span = rows.reduce((n, r) => Math.max(n, r.seasons), 0);
  const L = [`CAREER (${span} season${span === 1 ? '' : 's'} of league history — use for colour, not for current standings):`];
  for (const r of rows) {
    const bits = [`${r.wins}-${r.losses}${r.ties ? '-' + r.ties : ''} over ${r.seasons} seasons`];
    /*
     * The YEAR, not just the count. "Marlow has a title" cannot answer "when did
     * Marlow win", which is the form the question actually takes, and a bot that
     * knows somebody won but not when sounds like it is making it up.
     */
    bits.push(r.titles
      ? `${r.titles} title${r.titles === 1 ? '' : 's'} (${r.titleSeasons.join(', ')})`
      : 'no titles');
    /*
     * "no titles, best finish 1st" reads as a contradiction and is not one:
     * the finish is REGULAR SEASON rank, the title is the playoff bracket.
     * Topping the table for a year and still never winning the thing is one of
     * the better facts in here — but only if it is unmistakable which is which.
     */
    bits.push(`best regular season ${ordinal(r.best)}`);
    /*
     * Two different things, deliberately worded so they cannot be confused.
     * "Last" here is the bottom of the REGULAR SEASON table; the toilet bowl is
     * the punishment bracket, and in this league they were different people in
     * half the seasons on record. A chat that runs a punishment means the
     * second one when it says "last", so the first has to say which it is.
     */
    if (r.lasts) bits.push(`bottom of the regular season table in ${r.lastSeasons.join(', ')}`);
    if (r.toilets) bits.push(`took the toilet bowl in ${r.toiletSeasons.join(', ')}`);
    const known = names.get(r.userId);
    const who = known && r.name && known !== r.name ? `${known} (${r.name})`
              : known || r.name || r.userId;
    L.push(`  ${who} = ${bits.join(', ')}`);
  }
  return L.join('\n');
}

/**
 * Average finish, in order, best first.
 *
 * Ordered rather than left as twelve numbers on twelve lines, for the same
 * reason the extremes exist: handed the raw values and asked for the top three,
 * a model ranks them itself, and ranking is the operation nothing can check.
 * Printing the order makes "who are the top 3" a lookup.
 */
function averageFinishBlock(rows, names = new Map()) {
  const ranked = rows.filter(r => r.avgFinish != null)
    .sort((a, b) => a.avgFinish - b.avgFinish);
  if (ranked.length < 2) return '';
  const label = r => {
    const known = names.get(r.userId);
    return known && r.name && known !== r.name ? `${known} (${r.name})` : known || r.name || r.userId;
  };
  return 'AVERAGE FINISH (mean REGULAR SEASON place across every season played, best first.'
       + ' This order is computed, so it is safe to quote. "Highest" average finish means the'
       + ' LOWEST number, closest to 1.\n  Two different top-three counts follow and they'
       + ' disagree on purpose: the table one is the regular season, the playoff one is where'
       + ' they actually ended up. In 2025 the top four of the table came out exactly reversed'
       + ' in the bracket. Places are only listed where the bracket states them, 1-6 and last):\n'
       + ranked.map((r, i) => `  ${i + 1}. ${label(r)} ${r.avgFinish} over ${r.seasons} seasons`
           + `, ${r.podiums} top-three in the table, ${r.finalPodiums} top-three after the playoffs`
           + (r.finalFinishes?.length
               ? ` (finished ${r.finalFinishes.map(f => f.season + ': ' + f.place).join(', ')})`
               : '')).join('\n');
}

/**
 * The four superlatives, computed rather than left to be inferred.
 *
 * A model handed twelve individual lines and asked who is worst will rank them
 * itself, and ranking is exactly the operation the verifier cannot check: a
 * real answer here called Marlow's floor "lower than everyone else in this
 * convo" while five managers had finished last and one had done it twice.
 * Every figure in that sentence was correct and the claim was false.
 *
 * So the comparisons that can be made are made here, from the same rows, and
 * the ones that cannot are absent on purpose. TIES ARE LISTED, never collapsed
 * to a single name, because a coin flip between two people is the most likely
 * way this reintroduces the bug it exists to remove.
 */
function careerExtremes(rows, names = new Map()) {
  if (rows.length < 2) return '';
  const label = r => names.get(r.userId) || r.name || r.userId;
  const pct = r => r.wins / Math.max(1, r.wins + r.losses);
  const rec = r => `${r.wins}-${r.losses}`;

  /*
   * All holders of the extreme, so a tie reads as a tie.
   *
   * Past two holders the names stop being the fact. Six managers with one
   * title each is not "most titles", it is "nobody has two" — and printing six
   * names next to a superlative is an invitation to quote one of them as the
   * leader, which is the exact failure this function exists to prevent.
   */
  const top = (score, fmt, lead) => {
    const best = Math.max(...rows.map(score));
    const who = rows.filter(r => score(r) === best);
    if (!who.length) return null;
    if (who.length > 2) {
      return `  ${lead}: nobody leads, ${who.length} are tied on ${fmt(who[0])}. Do not name one of them as the leader`;
    }
    return `  ${lead}: ${who.map(label).join(' and ')} (${fmt(who[0])})`;
  };

  const L = ['LEAGUE EXTREMES (computed, safe to state as fact. Any OTHER ranking is not'
           + ' in this context and must not be claimed):'];
  const titles = top(r => r.titles, r => `${r.titles}`, 'most titles');
  if (titles && Math.max(...rows.map(r => r.titles)) > 0) L.push(titles);
  const lasts = top(r => r.lasts, r => `${r.lasts}`, 'most bottom of the table finishes (REGULAR SEASON, not the toilet bowl)');
  if (lasts && Math.max(...rows.map(r => r.lasts)) > 0) L.push(lasts);
  const toilets = top(r => r.toilets, r => `${r.toilets}`, 'most toilet bowls taken (the punishment bracket)');
  if (toilets && Math.max(...rows.map(r => r.toilets)) > 0) L.push(toilets);
  /*
   * Podiums and average finish, as computed extremes.
   *
   * Printing the twelve numbers was not enough. Asked who had the most
   * top-three finishes, the model scanned the list and answered "Marek and
   * Dermott, 3 each"; asked the same thing differently a moment later it said
   * "Dermott and Tobias, 2 each". The truth is Marek and Whitlock at 3. Two wrong
   * answers, disagreeing with each other, from a list sitting in front of it.
   *
   * Ranking twelve rows is exactly the operation nothing can verify after the
   * fact, which is why every other superlative here is computed. This one was
   * left out and immediately proved the rule.
   */
  const podium = top(r => r.podiums, r => `${r.podiums}`, 'most top-three REGULAR SEASON finishes');
  if (podium && Math.max(...rows.map(r => r.podiums || 0)) > 0) L.push(podium);
  const realPodium = top(r => r.finalPodiums || 0, r => `${r.finalPodiums}`,
    'most top-three ACTUAL finishes (after the playoffs)');
  if (realPodium && Math.max(...rows.map(r => r.finalPodiums || 0)) > 0) L.push(realPodium);
  const withAvg = rows.filter(r => r.avgFinish != null);
  if (withAvg.length > 1) {
    // Negated, because for a finish lower is better and top() takes a maximum.
    L.push(top(r => -(r.avgFinish ?? 99), r => `${r.avgFinish}`, 'best average finish'));
  }

  L.push(top(r => pct(r), rec, 'best career record'));
  L.push(top(r => -pct(r), rec, 'worst career record'));
  return L.filter(Boolean).join('\n');
}

const ordinal = n => {
  if (n == null) return 'unknown';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

module.exports = { chain, archiveLeague, captureSeason, career, careerBlock, careerExtremes,
  championBlock, averageFinishBlock, finalPlacements, toiletLoser, movesByRoster, gamesFor, gameRecords, gameRecordsBlock,
  benchMistakes, benchBlock, luck, luckBlock, toiletBlock, activityBlock, ordinal };

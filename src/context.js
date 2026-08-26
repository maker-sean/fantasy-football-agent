/**
 * Assemble what the bot knows about a league, for answering questions.
 *
 * Same discipline as the recap: everything here is computed, and the model is
 * only allowed to phrase it. A bot that invents a standing or a record in a
 * league chat is worse than a bot that says "I don't know" — the people reading
 * it can check, and they will.
 *
 * The hard part is not the numbers, it's identity. Chat identity is a phone
 * number; league identity is a Sleeper user. Nothing joins them except the
 * members table, so an unlinked league can compute perfect standings and still
 * not know which team is Marcus's. When that link is missing this says so
 * explicitly rather than guessing from name similarity.
 */

const db = require('./db');
const { selfFacts } = require('./selfknowledge');
const sleeper = require('./sleeper');

const round = n => Math.round(Number(n || 0) * 100) / 100;

/** Standings from a snapshot's roster settings (wins/losses/points). */
function standingsFrom(payload) {
  const byUser = new Map((payload.users || []).map(u => [u.user_id, u]));
  const rows = (payload.rosters || []).map(r => {
    const u = byUser.get(r.owner_id);
    const s = r.settings || {};
    return {
      team: u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`,
      manager: u?.display_name || u?.username || null,
      sleeperUserId: r.owner_id,
      rosterId: r.roster_id,
      wins: s.wins ?? 0,
      losses: s.losses ?? 0,
      ties: s.ties ?? 0,
      pointsFor: round((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100),
      pointsAgainst: round((s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100),
    };
  });
  rows.sort((a, b) => (b.wins - a.wins) || (b.pointsFor - a.pointsFor));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

/**
 * @param leagueId  our uuid
 * @param opts.includeArchive  pull last season too, so the bot has something to
 *                             say before the new season has any games
 */
/**
 * What one roster is short of, by season projection.
 *
 * Live from Sleeper because a draft changes rosters by the hour and there is no
 * current-season snapshot to read. Only ever called while a draft is running.
 *
 * STARTING POSITIONS ONLY. Kickers and defences are not what anybody agonises
 * over in round two, and including them would let "thinnest position" come back
 * as K, which is true and useless.
 */
const DRAFT_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/*
 * What each lineup slot will accept.
 *
 * THE FLEX IS THE WHOLE POINT. Counting only dedicated slots says a league
 * starting QB/RB/RB/WR/WR/TE needs two receivers, and it does not — it needs
 * enough bodies to fill two more slots that RB, WR and TE all compete for. A
 * roster with WR3 and WR6 and nothing behind them looks finished at receiver by
 * that reading and starts a replacement-level player every Sunday.
 */
const SLOT_ELIGIBILITY = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

/**
 * Fill the lineup this league actually starts, best players first.
 *
 * Dedicated slots are filled before flex ones, because a quarterback cannot
 * cover a running back slot and taking him first would strand it. Within that,
 * greedy on projected points: it is not a perfect optimiser and does not need
 * to be — the question is which slot is being filled by somebody who should not
 * be starting, and that answer survives a slightly imperfect ordering.
 */
function fillLineup(owned, rosterPositions) {
  const slots = (rosterPositions || []).filter(p => SLOT_ELIGIBILITY[p]);
  const pool = [...owned].sort((a, b) => b.points - a.points);
  const used = new Set();
  const lineup = [];

  const order = [...slots.entries()]
    .sort((a, b) => SLOT_ELIGIBILITY[a[1]].length - SLOT_ELIGIBILITY[b[1]].length);

  for (const [, slot] of order) {
    const ok = SLOT_ELIGIBILITY[slot];
    const pick = pool.find(p => !used.has(p.playerId) && ok.includes(p.position));
    if (pick) used.add(pick.playerId);
    lineup.push({ slot, player: pick || null });
  }
  return lineup;
}

async function draftNeedsFrom(rows, proj, rosterId, rosterPositions, { without = null } = {}) {
  return draftNeeds(rows, proj, rosterId, { without, rosterPositions });
}

function draftNeeds(rows, proj, rosterId, { without = null, rosterPositions = null } = {}) {
  const roster = (rows || []).find(r => Number(r.roster_id) === Number(rosterId));
  if (!roster?.players?.length) return null;

  /*
   * `without` rewinds one pick.
   *
   * The roster already contains the player just taken, so asking what they were
   * short of BEFORE the pick means removing him. That is the only honest way to
   * ask whether a pick addressed a need: judging it against a roster that
   * already includes it always says yes.
   */
  const owned = roster.players
    .filter(id => without == null || String(id) !== String(without))
    .map(id => proj.get(String(id)))
    .filter(Boolean);

  const byPos = {};
  for (const pos of DRAFT_POSITIONS) {
    const list = owned.filter(p => p.position === pos).sort((a, b) => a.posRank - b.posRank);
    byPos[pos] = { count: list.length, best: list[0] || null, second: list[1] || null };
  }

  /*
   * The real need is the WEAKEST STARTER, measured against replacement.
   *
   * Position ranks are NOT comparable across positions and treating them as
   * such is how "QB16" and "RB22" get ranked the wrong way round. In a twelve
   * team league starting one quarterback, only twelve QBs start at all — QB16
   * is four men below replacement and should not be in a lineup. RB22 with two
   * flex slots is comfortably a starter, because up to forty-eight running
   * backs start every week.
   *
   * So replacement level is computed per position from the league's own
   * lineup: teams x dedicated slots, plus the flex slots every eligible
   * position competes for. Generous to the flex on purpose — counting it in
   * full for RB, WR and TE overstates each slightly and understates none,
   * which keeps the comparison honest in the direction that matters.
   */
  const teams = (rows || []).length || 12;
  const slots = (rosterPositions || []).filter(p => SLOT_ELIGIBILITY[p]);
  const dedicated = pos => slots.filter(sl => sl === pos).length;
  const flexFor = pos => slots.filter(sl => sl !== pos && SLOT_ELIGIBILITY[sl].includes(pos)).length;
  const replacement = {};
  for (const pos of DRAFT_POSITIONS) {
    replacement[pos] = teams * (dedicated(pos) + flexFor(pos));
  }

  const lineup = fillLineup(owned, rosterPositions).map(s2 => ({
    ...s2,
    // Negative means below replacement: a player who should not be starting.
    overReplacement: s2.player
      ? (replacement[s2.player.position] || 0) - s2.player.posRank
      : null,
  }));

  const empty = lineup.find(s2 => !s2.player);
  const filled = lineup.filter(s2 => s2.player);
  const weakest = filled.length
    ? filled.reduce((w, s2) => (s2.overReplacement < w.overReplacement ? s2 : w))
    : null;

  return {
    rosterId: Number(rosterId),
    counted: owned.length,
    total: roster.players.length - (without == null ? 0 : 1),
    byPos,
    lineup,
    replacement,
    need: empty
      ? { slot: empty.slot, empty: true }
      : weakest && { slot: weakest.slot, pos: weakest.player.position,
                     name: weakest.player.name, rank: weakest.player.posRank,
                     replacement: replacement[weakest.player.position],
                     overReplacement: weakest.overReplacement },
  };
}

async function leagueContext(leagueId, opts = {}) {
  const { rows: lrows } = await db.query('select * from leagues where id = $1', [leagueId]);
  const league = lrows[0];
  if (!league) return null;

  const { rows: snaps } = await db.query(
    `select season, week, kind, payload, captured_at from snapshots
     where league_id = $1 order by season desc, week desc, captured_at desc limit 1`,
    [leagueId]
  );
  const latest = snaps[0] || null;

  const { rows: members } = await db.query(
    `select phone, sleeper_user_id, sleeper_roster_id, display_name
     from members where league_id = $1`,
    [leagueId]
  );

  const ctx = {
    // Built from the league row so the trigger word matches what is actually
    // configured. A bot that tells you to say "Commish" when the gate is
    // listening for "ref" is worse than one that says nothing.
    self: selfFacts(league, { autoPost: Boolean(league.config?.autoPost) }),
    leagueName: league.name,
    identityLinked: members.length,
    members: members.map(m => ({
      name: m.display_name,
      phone: m.phone,
      sleeperUserId: m.sleeper_user_id,
      rosterId: m.sleeper_roster_id,
    })),
    season: null,
    status: null,
    week: null,
    standings: [],
    // Explicitly stated so the model can decline instead of guessing.
    unknowns: [],
  };

  /*
   * A league with no snapshot of its OWN is not a league with no history.
   *
   * This returned early, which was wrong in the one window where it matters
   * most. A league that links its chat before the season starts has zero
   * snapshots on the live row — six years of them hang off the archive rows —
   * and ctx.lastSeason and ctx.career below are the only things that reach
   * those. Returning here handed the model "No league data has been captured
   * yet" during August, when every question a group chat asks is historical.
   *
   * Asked whether Marlow was any good, it correctly declined to guess while a
   * 38-45 record over six seasons and a title sat two code paths below.
   */
  if (!latest) {
    ctx.unknowns.push(
      'Nothing has been captured for the CURRENT season yet, so there are no standings, '
      + 'records or results for it. Past seasons are still known and are fair game.'
    );
    // The archive lookup compares against this, so it needs a season even when
    // no snapshot supplied one.
    ctx.season = league.season || null;
  }

  if (latest) {
    const p = latest.payload;
    ctx.season = p.league?.season || latest.season;
    ctx.status = p.league?.status || null;
    ctx.week = latest.week;
    ctx.teamCount = p.league?.total_rosters ?? null;

    const played = (p.rosters || []).some(r => (r.settings?.wins ?? 0) + (r.settings?.losses ?? 0) > 0);
    ctx.gamesPlayed = played;

    if (played) {
      ctx.standings = standingsFrom(p);
    } else {
      ctx.unknowns.push(
        `The ${ctx.season} season has not started — league status is "${ctx.status}" and no games have been played, so there are no standings, records, or results for ${ctx.season}.`
      );
    }

    // Attach team names to linked members so the bot can answer "whose team".
    const byUserId = new Map((ctx.standings.length ? ctx.standings : standingsFrom(p))
      .map(s => [s.sleeperUserId, s]));
    for (const m of ctx.members) {
      const s = byUserId.get(m.sleeperUserId);
      if (s) { m.team = s.team; m.record = `${s.wins}-${s.losses}`; }
    }

    const unlinked = (p.users || []).length - ctx.members.filter(m => m.team).length;
    if (unlinked > 0) {
      ctx.unknowns.push(
        `${unlinked} of ${(p.users || []).length} managers are not linked to a phone number, so the bot does not know which chat participant owns which team unless they are listed under KNOWN PEOPLE.`
      );
    }
  }

  // Last completed season, so the bot has real material before the new one
  // starts. This is what makes a pre-draft league answerable at all.
  // ctx.season guards the comparison below, which is a string compare and
  // would match every archived season if it were null.
  if (opts.includeArchive !== false && league.sleeper_league_id && ctx.season) {
    /*
     * THIS LEAGUE'S OWN PAST, and nobody else's.
     *
     * The query below used to filter on provider = 'archive' and a season, with
     * nothing tying the rows to the league doing the asking. With one league in
     * the database that is invisibly correct. With two it returns whichever
     * 2025 week 17 snapshot the planner reaches first — so a league can be
     * handed a stranger's standings as its own last season, stated to the model
     * as fact, with no error raised anywhere.
     *
     * It was found while building the onboarding pre-flight, which ingests a
     * second league's history and would have been the thing that triggered it.
     *
     * One chain walk, shared with career() below. chain() is up to twenty
     * sequential HTTP calls and both callers want the same list.
     */
    const chainIds = await require('./history').chain(league.sleeper_league_id)
      .then(seasons => seasons.map(s => s.league_id))
      .catch(err => {
        console.error('[context] chain walk failed:', err.message);
        return [];
      });

    // No chain means no way to scope. Prefer no last season over somebody
    // else's: missing colour reads as a quiet bot, wrong colour reads as a
    // confident one.
    const { rows: arch } = chainIds.length ? await db.query(
      `select s.season, s.week, s.payload from snapshots s
       join leagues l on l.id = s.league_id
       where l.provider = 'archive' and s.season < $1
         and l.sleeper_league_id = any($2::text[])
       order by s.season desc, s.week desc limit 1`,
      [String(ctx.season), chainIds]
    ) : { rows: [] };
    if (arch.length) {
      const a = arch[0];
      ctx.lastSeason = {
        season: a.season,
        throughWeek: a.week,
        standings: standingsFrom(a.payload).slice(0, 12),
      };
    }

    /*
     * Every season, summarised per manager.
     *
     * Cheap enough to do on every reply: one query over the final-week
     * snapshots, twelve rows out. Raising the limit above and handing the model
     * six seasons of tables would cost far more and read worse — a model given
     * 1,200 weekly scores writes worse jokes than one given "Marcus: 41-61,
     * never made a final".
     *
     * A failure here loses the colour and nothing else, so it must not take the
     * rest of the context down with it.
     */
    /*
     * Trades that have already settled, with the arithmetic done once.
     *
     * REDRAFT ONLY by construction — nothing writes a verdict for a dynasty
     * league, because a 2021 trade there is still resolving and a frozen grade
     * would be a stale opinion presented as a result.
     */
    // Kept on ctx so a retriever can run its own query over the same chain
    // rather than re-walking it. See src/retrievers.js.
    ctx.chainIds = chainIds;

    ctx.gradedTrades = await db.query(
      `select t.season, t.week, t.verdict
         from trades t join leagues l on l.id = t.league_id
        where l.sleeper_league_id = any($1::text[]) and t.verdict is not null
        order by (t.verdict->>'margin')::numeric desc limit 5`, [chainIds])
      .then(r => r.rows)
      .catch(err => { console.error('[context] graded trades failed:', err.message); return []; });

    /*
     * HOW MANY THERE ACTUALLY ARE, because the list above is the top five.
     *
     * Without this the model reports its list as the whole record and is
     * correct to: asked to review 2022 it answered "no 2022 deal on record"
     * when there were two, neither lopsided enough to make the cut. A truncated
     * list presented as complete is an absence rendered as a fact — the same
     * shape as a stale draft date announced as upcoming.
     */
    /*
     * EVERY trade, one line each, alongside the five told in full.
     *
     * Five itemised out of sixteen makes "who loses most" answerable only as
     * "two of the five worst", which is a much weaker claim than the record
     * supports — and it made the bot deny two real 2022 trades existed. The
     * detail is what costs tokens: four or five lines a trade, paid on every
     * reply whether anyone asks about trades or not. A single line each is
     * cheap enough to carry all of them.
     */
    ctx.tradeIndex = await db.query(
      `select t.season, t.week, t.verdict
         from trades t join leagues l on l.id = t.league_id
        where l.sleeper_league_id = any($1::text[]) and t.verdict is not null
        order by t.season, t.week`, [chainIds])
      .then(r => r.rows)
      .catch(() => []);

    ctx.tradeCounts = await db.query(
      `select t.season, count(*)::int n
         from trades t join leagues l on l.id = t.league_id
        where l.sleeper_league_id = any($1::text[]) and t.verdict is not null
        group by 1 order by 1`, [chainIds])
      .then(r => r.rows)
      .catch(() => []);

    ctx.career = await require('./history').career(league.sleeper_league_id, { ids: chainIds }).catch(err => {
      console.error('[context] career lookup failed:', err.message);
      return [];
    });

    // Draft accuracy over the same chain. Network plus six seasons of stats,
    // so it degrades to nothing rather than taking the reply down with it.
    ctx.draft = await require('./draftiq').analyze(league.sleeper_league_id).catch(err => {
      console.error('[context] draft lookup failed:', err.message);
      return null;
    });

    // Closest game, biggest hiding, highest and lowest score. Four lines out of
    // 582 games, which is the only way that log fits in a prompt.
    ctx.gameRecords = await require('./history').gameRecords(league.sleeper_league_id).catch(err => {
      console.error('[context] game records failed:', err.message);
      return null;
    });

    // Points left on the bench. Cached per process, since every season it reads
    // is finished and the answer cannot change.
    ctx.benchMistakes = await require('./history').benchMistakes(league.sleeper_league_id).catch(err => {
      console.error('[context] bench mistakes failed:', err.message);
      return [];
    });

    /*
     * When the draft is. The most common question a league asks in August, and
     * the one thing in here about the CURRENT season rather than the archive.
     */
    ctx.draftSchedule = await sleeper.draftSchedule(league.sleeper_league_id).catch(err => {
      console.error('[context] draft schedule failed:', err.message);
      return null;
    });

    /*
     * Whose turn it is, while a draft is actually running.
     *
     * A 24-hour pick timer turns "draft night" into three weeks: Sigma Chi
     * Dynasty started on 19 August and was on pick 20 of 48 six days later. For
     * that whole stretch the start date is the least interesting fact available
     * and the bot was quoting it as though the draft had not happened yet.
     *
     * Costs two extra calls and only while status is 'drafting'.
     */
    if (ctx.draftSchedule?.status === 'drafting') {
      ctx.draftClock = await sleeper.draftClock(ctx.draftSchedule).catch(err => {
        console.error('[context] draft clock failed:', err.message);
        return null;
      });

      /*
       * WHAT THE PERSON ON THE CLOCK IS SHORT OF.
       *
       * The bot has been able to recite what a manager did in 2023 and unable
       * to say anything useful about the pick they are making right now. This
       * is the input that lets it have an opinion — "no running back projected
       * inside the top fifty, I would start there" — rather than another
       * record.
       *
       * The gap is COMPUTED, not derived. Handed a roster and three thousand
       * projections and asked which position is thinnest, a model produces a
       * number that reads right and is not; that failure has cost this codebase
       * more than any other. The thin position is arithmetic and is worked out
       * here.
       */
      if (ctx.draftClock) {
        try {
          // One fetch, two analyses. The rosters and the projections are the
          // same for both and neither is small.
          const [rows, proj, settings] = await Promise.all([
            sleeper.rosters(league.sleeper_league_id),
            sleeper.seasonProjections(new Date().getFullYear()),
            sleeper.league(league.sleeper_league_id).catch(() => null),
          ]);

          /*
           * WHICH PRICE LIST THIS LEAGUE IS ENTITLED TO, read from its own
           * settings rather than assumed.
           *
           * Dynasty values price a 21-year-old above a 30-year-old star. In a
           * redraft league that is not slightly off, it is inverted — and one
           * of these two leagues IS redraft, so without this check it would
           * have been handed dynasty prices and no one in the chat could have
           * told from the answer.
           */
          const pvalues = require('./playervalues');
          const variant = pvalues.leagueVariant(settings || {});
          ctx.valueVariant = variant;

          if (variant.dynasty) {
            const have = await pvalues.haveValuesFor(variant).catch(() => ({ held: false }));
            ctx.bestAvailable = have.held
              ? await pvalues.bestAvailable(rows, { superflex: variant.superflex, limit: 8 })
                  .catch(err => {
                    console.error('[context] best available failed:', err.message);
                    return null;
                  })
              : null;
            // Held nothing for this exact combination — say so rather than
            // reaching for the nearest list, which is how a TE-premium league
            // gets base prices and never finds out.
            if (!have.held) ctx.valuesMissing = variant;
          }

          const rosterPositions = settings?.roster_positions || null;
          if (ctx.draftClock.rosterId != null) {
            ctx.onClockRoster = draftNeeds(rows, proj, ctx.draftClock.rosterId, { rosterPositions });
          }

          /*
           * The last pick, judged against the roster as it was BEFORE it.
           *
           * "Did that make sense" is the question a draft chat actually asks,
           * and it is answerable from what we already have: what the player
           * projects at, and what that manager was thin at a minute ago.
           */
          const lp = ctx.draftClock.lastPick;
          if (lp?.rosterId != null) {
            ctx.lastPickAnalysis = {
              ...lp,
              projected: lp.playerId ? proj.get(String(lp.playerId)) || null : null,
              before: draftNeeds(rows, proj, lp.rosterId, { without: lp.playerId, rosterPositions }),
            };
          }
        } catch (err) {
          console.error('[context] draft roster analysis failed:', err.message);
        }
      }
    }
  }

  /*
   * Sleeper's projections for the person who asked.
   *
   * THEIRS, not the league's. The full slate is 3,297 rows and two megabytes,
   * and the archetypal question — "who should I start" — is about one roster.
   * Fifteen players is a few hundred characters; everybody's is a prompt nobody
   * can afford and a model nobody can steer.
   *
   * The consequence is worth stating in the block itself: asked about somebody
   * else's player the bot has no number, and must say so rather than reach for
   * one.
   */
  if (opts.forPhone && latest?.payload?.rosters) {
    try {
      const me = members.find(m => m.phone === db.normalizePhone(opts.forPhone));
      const roster = me && (latest.payload.rosters || [])
        .find(r => r.roster_id === me.sleeper_roster_id);

      if (roster?.players?.length) {
        const state = await sleeper.state();
        const proj = await sleeper.projections(state.season, state.week);
        const starters = new Set(roster.starters || []);
        ctx.projections = {
          season: state.season,
          week: state.week,
          rows: roster.players
            .map(id => {
              const p = proj.get(String(id));
              return p ? { ...p, starting: starters.has(id) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.points - a.points),
        };
      }
    } catch (err) {
      // Projections are a bonus. Losing them must not cost the answer.
      console.error('[context] projections failed:', err.message);
    }
  }

  return ctx;
}

/** Render context as the fact sheet handed to the model. */
/**
 * @param opts.only  section names to include besides the always-on core. Null
 *                   (the default) means everything, which is what every caller
 *                   did before sections existed and what recaps still want.
 */
function contextBlock(ctx, opts = {}) {
  /*
   * L is not an array any more, and every L.push below is untouched.
   *
   * The whole block used to ship on every reply — all of it, whether someone
   * asked about the draft or about the weather. That is fine at sixteen trades
   * and impossible at a hundred and seventy-seven, so sections became something
   * a caller can ask for by name.
   *
   * Rewriting six hundred push calls to target the right bucket would have been
   * the obvious way and the wrong one: it touches every line that builds the
   * context in order to change WHICH lines get sent. So L keeps its interface,
   * pushes land in whichever section is currently open, and the only new lines
   * in this function are the boundaries themselves.
   */
  const only = opts.only || null;
  const buckets = [];
  let cur = null;
  const open = name => { cur = { name, lines: [] }; buckets.push(cur); };
  const wanted = name => name === 'core' || !only || only.includes(name);
  open('core');

  const L = {
    push: line => cur.lines.push(line),
    section: open,
    join(sep) {
      const out = [];
      const skipped = new Set();
      for (const b of buckets) {
        if (wanted(b.name)) { out.push(...b.lines); continue; }
        /*
         * A dropped section leaves a pointer, never silence.
         *
         * Silence reads to the model as "no such data", and it will say the
         * league has no trades on record when it has a hundred. Saying the
         * facts exist but are not loaded costs one line and is true.
         */
        if (b.lines.length) skipped.add(b.name);
      }
      if (skipped.size) {
        out.push('');
        out.push(`NOT LOADED for this question: ${[...skipped].join(', ')}. These facts EXIST`
               + ' and are known. If the question turns out to need them, say you need to look'
               + ' that up rather than saying there is nothing on record.');
      }
      return out.join(sep);
    },
  };
  L.push(`League: ${ctx.leagueName}. Season ${ctx.season || 'unknown'}, status ${ctx.status || 'unknown'}${ctx.teamCount ? `, ${ctx.teamCount} teams` : ''}.`);

  /*
   * FIRST, before any league fact.
   *
   * A question about the product is the one kind the model would otherwise
   * answer with "I don't know", correctly, because src/answer.js forbids
   * filling gaps. Putting this above the standings means how-do-I questions
   * resolve from grounded text rather than from invention, which matters most
   * for the one subject where a plausible guess is genuinely harmful: how to
   * stop receiving messages.
   */
  if (ctx.self?.length) {
    L.push('');
    L.push('ABOUT YOU. True, and the only place to answer questions about how you work:');
    for (const f of ctx.self) L.push(`  - ${f}`);
  }

  if (ctx.members.length) {
    L.push('');
    L.push('KNOWN PEOPLE (chat participant -> their team):');
    for (const m of ctx.members) {
      L.push(`  ${m.name || m.phone} = ${m.team || '(team unknown)'}${m.record ? `, ${m.record}` : ''}`);
    }
  }

  if (ctx.standings.length) {
    L.push('');
    L.push(`STANDINGS (${ctx.season}, through week ${ctx.week}):`);
    for (const s of ctx.standings) {
      L.push(`  ${String(s.rank).padStart(2)}. ${s.team} — ${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}, ${s.pointsFor} points for`);
    }
  }

  if (ctx.lastSeason?.standings?.length) {
    L.push('');
    L.push(`LAST SEASON (${ctx.lastSeason.season} final, through week ${ctx.lastSeason.throughWeek}):`);
    for (const s of ctx.lastSeason.standings) {
      L.push(`  ${String(s.rank).padStart(2)}. ${s.team} — ${s.wins}-${s.losses}, ${s.pointsFor} points for`);
    }
  }

  /*
   * Career facts, after the current standings and clearly subordinate to them.
   *
   * Order is the weighting. "What is happening now" comes first because that is
   * what most questions are about; six years of history sits underneath as
   * colour, and the block says so in its own header so the model does not
   * answer "who is winning" with somebody's 2021 record.
   */
  /*
   * History starts HERE, at the careers, not at last season's final table.
   *
   * Those two used to sit in one section, and dropping it took the last table
   * with it — so with no current season captured, "what are the standings"
   * answered "check back once games start" while the 2025 result sat right
   * there unloaded. The table is twelve lines. The careers and extremes below
   * it are 3,700 tokens. Only the second one is worth deciding about.
   */
  L.section('history');
  if (ctx.career?.length) {
    // The join. Without it the model cannot connect "Sean" in KNOWN PEOPLE to
    // "smeadows" in here, and it will correctly refuse to guess.
    const names = new Map(
      (ctx.members || [])
        .filter(m => m.sleeperUserId && m.name)
        .map(m => [m.sleeperUserId, m.name])
    );
    L.push('');
    L.push(require('./history').careerBlock(ctx.career, names));
    // The comparisons, computed. Without these the model derives its own from
    // the twelve lines above, which is the one operation the verifier cannot
    // check. See careerExtremes.
    const extremes = require('./history').careerExtremes(ctx.career, names);
    if (extremes) { L.push(''); L.push(extremes); }

    /*
     * Who scores. Absent entirely until now — career() had summed the points
     * per manager since it was written and nothing ever printed them, so asked
     * who scores most per season the bot said the maths was not in front of it,
     * which was true.
     *
     * Ranked here rather than in the prompt, for the same reason as luck below:
     * a model handed twelve rows and asked which is biggest answered the same
     * question two different wrong ways minutes apart.
     */
    const scoring = require('./history').scoringBlock(ctx.career, names);
    if (scoring) { L.push(''); L.push(scoring); }

    // Whether a record was earned or scheduled. Computed, because a model given
    // twelve rows of points will rank them itself and state the result as fact.
    const luck = require('./history').luckBlock(ctx.career, names);
    if (luck) { L.push(''); L.push(luck); }

    // Ordered, because "top 3 average finishes" is a ranking and a ranking is
    // the one thing nothing can check after the fact.
    const avg = require('./history').averageFinishBlock(ctx.career, names);
    if (avg) { L.push(''); L.push(avg); }

    // Who took the punishment, by year. The counts above cannot answer "who
    // lost it in 2022", which is the shape the question actually takes.
    /*
     * Who is new and who has gone.
     *
     * Both are derivable and neither was being said. Asked how Ivers drafts, the
     * bot answered "nothing on record for that name", which is true and reads
     * like it failed to look him up: Ivers is new this season, replacing mrenshaw7,
     * and "he is new" is a better answer than "I have nothing". The other
     * direction matters more — mrenshaw7 has six seasons in the archive and no
     * seat at the table, so quoting that record as though he is still here
     * would be wrong in front of the person who replaced him.
     *
     * Matched on sleeper_user_id where there is one, and on name otherwise,
     * because a manager who has not been assigned a roster in Sleeper has no id
     * to match on. That is exactly Ivers's situation.
     */
    const careerIds = new Set((ctx.career || []).map(c => c.userId));
    /*
     * Career rows are keyed on SLEEPER HANDLES and members on real names, so
     * comparing the two directly finds nothing: Sean is "smeadows" in the archive.
     * The resolved name is what makes them the same person, so match on both.
     */
    const careerNames = new Set((ctx.career || []).flatMap(c => [
      (c.name || '').toLowerCase(),
      (names.get(c.userId) || '').toLowerCase(),
    ]).filter(Boolean));
    const memberIds = new Set((ctx.members || []).filter(m => m.sleeperUserId).map(m => m.sleeperUserId));
    const memberNames = new Set((ctx.members || []).filter(m => m.name).map(m => m.name.toLowerCase()));

    const arrivals = (ctx.members || [])
      .filter(m => m.name)
      // A row with no Sleeper id AND no roster identifies nobody. Those are
      // merge leftovers, and counting them called Sean and Danner new to a league
      // they have played six seasons in.
      .filter(m => m.sleeperUserId || m.rosterId)
      .filter(m => !(m.sleeperUserId && careerIds.has(m.sleeperUserId)))
      .filter(m => !careerNames.has(m.name.toLowerCase()))
      .map(m => m.name);

    const departures = (ctx.career || [])
      .filter(c => !memberIds.has(c.userId))
      .filter(c => !(c.name && memberNames.has(c.name.toLowerCase())))
      .map(c => c.name || c.userId);

    if (arrivals.length || departures.length) {
      L.push('');
      L.push('WHO IS ACTUALLY IN THE LEAGUE RIGHT NOW:');
      if (arrivals.length) {
        L.push(`  new this season, with NO history at all: ${arrivals.join(', ')}. `
             + `Say they are new rather than saying you have nothing on them.`);
      }
      if (departures.length) {
        L.push(`  in the history but NOT in the league any more: ${departures.join(', ')}. `
             + `Their record is real and they are gone, so do not talk about them as current.`);
      }
    }

    const champs = require('./history').championBlock(ctx.career, names);
    if (champs) { L.push(''); L.push(champs); }

    const toilets = require('./history').toiletBlock(ctx.career, names);
    if (toilets) { L.push(''); L.push(toilets); }

    // How busy each manager is, and which way it is heading. Direction is the
    // part no single season shows.
    const activity = require('./history').activityBlock(ctx.career, names);
    if (activity) { L.push(''); L.push(activity); }

    if (ctx.gameRecords) {
      L.push('');
      L.push(require('./history').gameRecordsBlock(ctx.gameRecords, names));
    }

    if (ctx.benchMistakes?.length) {
      L.push('');
      L.push(require('./history').benchBlock(ctx.benchMistakes, names));
    }

    /*
     * Draft history, last. It is the deepest material and the most expensive
     * to be wrong about, so it sits below the career lines it depends on.
     *
     * A failure here costs the colour and nothing else, same as career.
     */
    if (ctx.draft) { L.push(''); L.push(require('./draftiq').draftBlock(ctx.draft, names)); }
  }

  L.section('roster');
  if (ctx.projections?.rows?.length) {
    L.push('');
    L.push(`SLEEPER PROJECTIONS for the person asking, week ${ctx.projections.week} ` +
           `(${ctx.projections.season}). These are SLEEPER'S numbers — quote them as Sleeper's, ` +
           `never as your own, and never adjust them:`);
    for (const p of ctx.projections.rows) {
      L.push(`  ${p.starting ? '*' : ' '} ${p.name} (${p.position}, ${p.team}` +
             `${p.opponent ? ' vs ' + p.opponent : ''}) ${p.points}`);
    }
    L.push('  * = currently in their starting lineup. You have projections for NOBODY ELSE\'S roster.');
  }

  /*
   * The most lopsided trades on record, computed.
   *
   * Started points only — what those players actually did IN THIS MANAGER'S
   * LINEUP after the trade, not what they scored on a bench. Draft picks are
   * disclosed and excluded, because pricing them needs projections we do not
   * have for a season that has already happened.
   *
   * Ordered here, not by the model. "Worst trade" is a ranking, and a ranking
   * derived in the prompt is the one thing nothing downstream can check.
   */
  L.section('trades');
  if (ctx.gradedTrades?.length) {
    const nameOf = rid => {
      const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
      return m?.name || `roster ${rid}`;
    };
    L.push('');
    const total = (ctx.tradeCounts || []).reduce((a, r) => a + r.n, 0);
    L.push('TRADES, SETTLED (rest-of-season points scored IN THE LINEUP by what each side'
         + ' received. Most lopsided first — this order is computed, do not re-rank it):');
    if (total > ctx.gradedTrades.length) {
      /*
       * The truncation, said out loud. Listing five of sixteen without saying
       * so is what made the bot deny two real 2022 trades existed.
       */
      L.push(`  THESE ARE THE ${ctx.gradedTrades.length} MOST LOPSIDED OF ${total} on record.`
           + ' Others exist and are NOT listed here — if asked about a season or a trade you'
           + ' cannot see, say it is not in your top five, never that it did not happen.');
      L.push('  How many settled trades each season actually had: '
           + (ctx.tradeCounts || []).map(r => `${r.season} ${r.n}`).join(', '));
    }

    /*
     * The full record, one line each. Enough to count them, to say who loses
     * most, and to answer about a season none of the top five touched — none of
     * which the itemised five could support.
     */
    if (ctx.tradeIndex?.length) {
      L.push('  EVERY settled trade: who got whom, then margin and value over replacement.');
      L.push('  NEVER name a trade without saying which players changed hands. A trade given as'
           + ' a scoreline between two managers is the shape that had you describing a deal and'
           + ' then inventing the players in it. The names are on every line below, so use them.');
      for (const t of ctx.tradeIndex) {
        const v = t.verdict;
        if (!v?.sides || v.sides.length !== 2) continue;
        const [w2, l2] = v.sides;
        /*
         * "Winner" here means by RAW POINTS, because that is how the sides are
         * sorted. A NEGATIVE vorp margin means value says the opposite — the
         * side that scored more got the worse asset — and printing the two
         * numbers side by side without saying so invites reading them as
         * agreeing when they contradict.
         */
        const flipped = v.vorpMargin != null && v.vorpMargin < 0;
        // What each side actually received, so the line can be quoted whole and
        // never needs a player fetched from a neighbouring entry.
        const got = s2 => `${nameOf(s2.rosterId)} got `
          + ((s2.players || []).map(pl => pl.name).join(', ') || 'no players');
        L.push(`    ${t.season} wk${String(t.week).padStart(2)}  ${got(w2)}; ${got(l2)}`);
        L.push(`        ${nameOf(w2.rosterId)}`
             + ` outscored ${nameOf(l2.rosterId)} by ${v.margin}`
             + (v.vorpMargin != null
                ? flipped
                  ? `, but by VALUE ${nameOf(l2.rosterId)} won it, ${Math.abs(v.vorpMargin)}`
                  : `, VORP ${v.vorpMargin}`
                : ''));
      }
      L.push('  Counting across THIS list is safe — it is every one on record. But count by the'
           + ' measure you name: outscoring and winning on value are different, and a few of'
           + ' these split.');

      /*
       * The tally, COMPUTED.
       *
       * Asked who loses most, the bot refused — "I don't have a loss count" —
       * with sixteen lines in front of it that plainly contain one. That is the
       * over-refusal this codebase keeps correcting: it declined to have an
       * opinion when what was actually needed was arithmetic.
       *
       * So the arithmetic is done here, both ways, because a manager who
       * outscores and loses on value is a different story from one who just
       * loses — and asking the model to tally sixteen rows is asking for the
       * one mistake it reliably makes.
       */
      const tally = new Map();
      const bump = (rid, key) => {
        const k = nameOf(rid);
        const e = tally.get(k) || { won: 0, lost: 0, valueWon: 0, valueLost: 0 };
        e[key]++; tally.set(k, e);
      };
      for (const t of ctx.tradeIndex) {
        const v = t.verdict;
        if (!v?.sides || v.sides.length !== 2) continue;
        const [w2, l2] = v.sides;
        bump(w2.rosterId, 'won');
        bump(l2.rosterId, 'lost');
        if (v.vorpMargin == null) continue;
        bump(v.vorpMargin < 0 ? l2.rosterId : w2.rosterId, 'valueWon');
        bump(v.vorpMargin < 0 ? w2.rosterId : l2.rosterId, 'valueLost');
      }
      const ranked = [...tally].sort((a, b) => b[1].lost - a[1].lost);
      L.push('  TRADE RECORD per manager (won-lost by points, then by value):');
      for (const [who, r] of ranked) {
        L.push(`    ${who}: ${r.won}-${r.lost} on points, ${r.valueWon}-${r.valueLost} on value`);
      }

      /*
       * The superlatives off this table, computed, because reading nine rows
       * and picking one is a ranking.
       *
       * Asked who loses most, the reply came back "Whitlock and Sorenson are both 0-3
       * on value" off a table that says Whitlock 0-3 and Sorenson 0-2. Both numbers
       * were printed correctly and one got carried onto the neighbouring name,
       * which is the failure that keeps recurring whenever the answer needs two
       * lines welded rather than one quoted.
       *
       * "Loses the most" is also genuinely two questions — most losses, or
       * worst record — and the two give different names here, so both are
       * stated rather than picked between.
       */
      const most = (key) => {
        const top = Math.max(...[...tally.values()].map(r => r[key]));
        const who = [...tally].filter(([, r]) => r[key] === top).map(([n]) => n);
        return { top, who };
      };
      const winless = [...tally].filter(([, r]) => r.won === 0 && r.lost > 0)
        .sort((a, b) => b[1].lost - a[1].lost);
      const ml = most('lost');
      L.push(`  MOST LOSSES BY POINTS: ${ml.who.join(' and ')} at ${ml.top}`
           + `${ml.who.length > 1 ? ' — that is a tie, say so' : ''}.`);
      const mvl = most('valueLost');
      L.push(`  MOST LOSSES BY VALUE: ${mvl.who.join(' and ')} at ${mvl.top}`
           + `${mvl.who.length > 1 ? ' — that is a tie, say so' : ''}.`);
      if (winless.length) {
        L.push('  WINLESS (never won one on points): '
             + winless.map(([n, r]) => `${n} at 0-${r.lost}`).join(', ')
             + '. Most losses and worst record are different questions and can name different'
             + ' people. Answer the one asked, and do not merge two managers into one record.');
      }
    }
    for (const t of ctx.gradedTrades) {
      const v = t.verdict;
      if (!v?.sides || v.sides.length !== 2) continue;
      const [win, lose] = v.sides;
      /*
       * GOT and GAVE UP, both stated.
       *
       * Listing only what a side received leaves the other half of every trade
       * sentence unwritten, and the model completes it by inference. It put
       * Michael Thomas on the wrong side of the 2021 week 5 deal because he
       * scored 0.0 — a zero looks like the throwaway you trade away rather than
       * the dud you accept — then named a bundle "including" him that did not
       * contain him. Printing both halves removes the slot being filled.
       */
      const side = s2 => {
        const got = s2.players.map(p => `${p.name} (${p.startedPoints.toFixed(1)})`).join(', ');
        const gave = (s2.gaveUp || []).map(p => p.name).join(', ');
        return `${nameOf(s2.rosterId)} GOT ${got}`
          + (gave ? `, and GAVE UP ${gave}` : '');
      };
      L.push(`  ${t.season} week ${t.week}, margin ${v.margin}:`);
      L.push(`    won  — ${side(win)} = ${win.startedPoints}`);
      L.push(`    lost — ${side(lose)} = ${lose.startedPoints}`);
      if (v.hasPicks) L.push('    draft picks were also involved and are NOT counted here');
      /*
       * An uneven trade is measured loosely and must say so.
       *
       * The margin sums every player a side received, so three-for-one favours
       * the side getting three bodies. Started points blunt it — a player who
       * could not crack the lineup contributes nothing — but a manager with
       * holes everywhere starts all three, and the arithmetic then rewards
       * volume rather than value. Stating the counts is the minimum; quoting
       * the margin as if it settled the matter is overclaiming.
       */
      /*
       * BOTH measures, because neither settles it alone. The total says what
       * the trade did for the roster; best-against-best says who got the better
       * player, with volume removed. On an even trade they agree, and that
       * agreement is itself worth the model seeing.
       */
      /*
       * VORP is the fairest of the three and is stated as such.
       *
       * Points above what a freely available player produced over the same
       * weeks, floored at zero — a player who did worse than the waiver wire
       * added nothing, because his equivalent was there for free. That floor is
       * what stops a three-for-one being flattered by two bodies nobody would
       * have rostered.
       *
       * It is not merely a smaller number: on an even trade for a genuine star
       * it goes UP, because everything the other side got sat near replacement.
       */
      if (v.vorpMargin != null) {
        const [w2, l2] = v.sides;
        L.push(`    VALUE OVER REPLACEMENT: ${v.vorpMargin}`
             + ` (${nameOf(w2.rosterId)} ${w2.vorp} against ${nameOf(l2.rosterId)} ${l2.vorp}).`
             + ' Points above a freely available player at the same position, floored at zero.'
             + ' THIS IS THE FAIREST OF THE THREE — prefer it when they disagree.');
        for (const s2 of v.sides) {
          const dead = s2.players.filter(pl => pl.vorp === 0);
          if (dead.length) {
            L.push(`      ${dead.map(pl => pl.name).join(', ')} scored BELOW replacement,`
                 + ' so worth nothing — that side could have had their equal off waivers.');
          }
        }
      }
      if (v.bestMargin != null && v.bestMargin !== v.margin) {
        L.push(`    best player against best player: ${v.bestMargin}`
             + ` (the ${v.margin} above counts every player received;`
             + ' this compares only the best of each side, so volume cannot flatter it)');
      }
      if (v.uneven) {
        L.push(`    UNEVEN: ${win.players.length} players against ${lose.players.length}.`
             + ' Quote both numbers, or say the counts.');
      }
      /*
       * A handcuff is a hedge, not a loss. Only ever flagged for the current
       * season — players.team is today's team and free agency moves half the
       * league every spring, so a historical claim would be a guess.
       */
      for (const s2 of v.sides) {
        for (const pl of s2.players) {
          if (!pl.handcuffOf) continue;
          L.push(`    ${pl.name} was the handcuff to ${pl.handcuffOf} — same team, same`
               + ' position, bought as insurance. Scoring nothing is the hedge NOT paying'
               + ' out, which is a neutral result and not a fleecing.');
        }
      }
    }
  }

  L.section('draft');
  if (ctx.draftSchedule && ctx.draftSchedule.status !== 'complete') {
    const d = ctx.draftSchedule;
    L.push('');
    /*
     * Spelled out with the timezone attached, because "8pm" to twelve people in
     * three timezones is not an answer. The raw timestamp is deliberately not
     * printed: a model handed epoch milliseconds will try to do arithmetic on
     * them.
     */
    /*
     * THE ZONE IS PINNED, not inherited.
     *
     * This passed no timeZone and took whatever the process had. render.yaml
     * sets CRON_TZ and never TZ, so the worker resolves to UTC and this would
     * have rendered "Monday, August 31 at 12:00 AM UTC" for a draft that starts
     * Sunday at 8pm. Wrong day, wrong hour, and plausible enough on the page
     * that nobody would question it. It only looked right locally because this
     * laptop is already Eastern.
     *
     * shortGeneric prints "ET" rather than "EDT", which is what a person writes
     * and stays correct either side of a daylight saving change.
     */
    /*
     * CRON_TZ or Eastern, and deliberately NOT process.env.TZ. Falling back to
     * TZ reintroduces the bug: TZ is the host's zone, which on Render is UTC,
     * and inheriting it is precisely what printed the wrong day. NFL slates are
     * Eastern, which is the same reasoning render.yaml gives for CRON_TZ.
     */
    const zone = process.env.CRON_TZ || 'America/New_York';
    const when = d.startsAt
      ? new Date(d.startsAt).toLocaleString('en-US', {
          timeZone: zone,
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric',
        })
      : null;
    /*
     * STATE FIRST, date second.
     *
     * This said "scheduled for {date}" whatever the draft was actually doing,
     * so a draft that had started six days ago was announced to the league as
     * upcoming — twice. Sleeper has told us the status all along and this block
     * threw it away. A fixed date asserted as the future is wrong the moment it
     * passes, and a commissioner can move it at any time.
     */
    const clock = ctx.draftClock;
    /*
     * Keyed on ROSTER id, not sleeper user id. The draft names a slot, the slot
     * maps to a roster, and members carries both — naming the wrong manager in
     * a chat that can see the draft board is the one mistake worth guarding.
     */
    const byRoster = new Map(
      (ctx.members || [])
        .filter(m => m.rosterId != null && m.name)
        .map(m => [Number(m.rosterId), m.name])
    );
    L.push('THE DRAFT (this season, live from Sleeper — state first, and it is authoritative):');

    if (d.status === 'drafting') {
      L.push('  IT IS HAPPENING RIGHT NOW. Do not describe it as upcoming or scheduled.');
      if (clock?.done) {
        L.push(`  every pick is in (${clock.made} of ${clock.total}), Sleeper has not closed it yet`);
      } else if (clock) {
        const who = byRoster.get(Number(clock.rosterId));
        const from = clock.wasTraded ? byRoster.get(Number(clock.originalRosterId)) : null;
        L.push(`  pick ${clock.overall} of ${clock.total} — round ${clock.round}, slot ${clock.slot}`);
        L.push(who
          ? `  ON THE CLOCK: ${who}`
          : `  on the clock: roster ${clock.rosterId ?? 'unknown'}, and you cannot say whose that is`);
        /*
         * Say whose it was. In a dynasty league picks are currency and the
         * slot still carries the old owner's name on the board — leaving this
         * out is how "why is Renshaw picking in Sean's spot" becomes a
         * question the bot cannot answer about a fact it already used.
         */
        if (clock.wasTraded) {
          L.push(from
            ? `  this pick was traded: it was originally ${from}'s`
            : '  this pick was traded to them, from a roster you cannot name');
        }
        /*
         * The last pick, and the material to judge it.
         *
         * Everything here is a fact — who picked, what he projects at, what
         * they were thin at before it. Whether it was a GOOD pick is a take,
         * and taking it is the point; the numbers are what stop the take being
         * made up.
         */
        const lp = ctx.lastPickAnalysis;
        if (lp) {
          const picker = byRoster.get(Number(lp.rosterId)) || `roster ${lp.rosterId}`;
          const proj = lp.projected;
          L.push(`  LAST PICK: ${picker} took ${lp.name || 'someone'}`
               + (proj ? ` — ${proj.position}${proj.posRank}, ${proj.points} projected` : '')
               + (lp.pickNo ? ` (pick ${lp.pickNo})` : ''));
          const before = lp.before;
          if (before) {
            const t = before.need;
            L.push('    before that pick their weakest starting slot was '
                 + (t?.empty ? `an empty ${t.slot}`
                    : t ? `${t.slot}, filled by ${t.name} at ${t.pos}${t.rank}`
                    : 'not computable'));
            const at = proj && before.byPos[proj.position];
            if (at) {
              L.push(at.best
                ? `    at ${proj.position} they already had ${at.best.name} at`
                  + ` ${proj.position}${at.best.posRank}`
                : `    they had no ${proj.position} at all before this`);
            }
            L.push('    Whether that was the right pick is yours to say. Base it on these numbers.');
          }
        } else if (clock.lastPlayer) {
          L.push(`  last pick was ${clock.lastPlayer}`);
        }
        if (clock.onClockSinceMs != null) {
          const hours = Math.floor(clock.onClockSinceMs / 3600000);
          const limit = d.pickSeconds ? Math.round(d.pickSeconds / 3600) : null;
          L.push(`  they have had it ${hours} hour${hours === 1 ? '' : 's'}`
               + (limit ? ` of ${limit}` : ''));
        }
      }
      if (when) L.push(`  it started ${when}`);

      /*
       * The roster behind the pick, so the bot can say something about the pick
       * being made rather than about 2023.
       *
       * Every number here is computed. The thin position is stated outright
       * because it is a ranking, and a ranking the model works out for itself
       * is the one thing nothing downstream can check.
       *
       * HAVING A VIEW IS THE POINT. The facts are what must be right; what to
       * do about them cannot be wrong, only disagreed with, and disagreement is
       * the product. Recommending a position off these numbers is allowed and
       * wanted; inventing a number to justify one is not.
       */
      const needs = ctx.onClockRoster;
      if (needs) {
        const owner = byRoster.get(needs.rosterId) || 'they';
        L.push('');
        L.push(`  WHAT ${owner.toUpperCase()} HAS, by season projection`
             + ` (${needs.counted} of ${needs.total} rostered players are projected):`);
        for (const pos of ['QB', 'RB', 'WR', 'TE']) {
          const p = needs.byPos[pos];
          if (!p) continue;
          if (!p.best) { L.push(`    ${pos}: none at all`); continue; }
          L.push(`    ${pos}: ${p.count} rostered, best is ${p.best.name} at ${pos}${p.best.posRank}`
               + ` (${p.best.points} projected)`
               + (p.second ? `, then ${p.second.name} at ${pos}${p.second.posRank}` : ', nothing behind him'));
        }
        /*
         * The lineup they would actually start, flex included.
         *
         * Position counts alone say a two-receiver league is finished at
         * receiver once it has two, which is wrong wherever a FLEX exists —
         * RB, WR and TE all compete for those slots, so depth at any of them
         * is starting depth.
         */
        if (needs.lineup?.length) {
          L.push(`    STARTING LINEUP they would field (${needs.lineup.length} slots):`);
          for (const s2 of needs.lineup) {
            L.push(`      ${s2.slot.padEnd(10)} ${s2.player
              ? `${s2.player.name} (${s2.player.position}${s2.player.posRank})`
                + (s2.overReplacement < 0
                  ? `  BELOW REPLACEMENT by ${Math.abs(s2.overReplacement)}`
                  : '')
              : 'EMPTY — nobody to start here'}`);
          }
          L.push('      How many of each start across the whole league: '
               + Object.entries(needs.replacement).map(([p, n]) => `${p} ${n}`).join(', ')
               + '. A rank worse than that number is a bench player in a starting slot.');
        }
        L.push(needs.need?.empty
          ? `    BIGGEST NEED: an empty ${needs.need.slot} slot, which is a zero every week`
          : needs.need
            ? `    BIGGEST NEED: ${needs.need.slot}, started by ${needs.need.name} at`
              + ` ${needs.need.pos}${needs.need.rank} when only ${needs.need.replacement}`
              + ` ${needs.need.pos}s start league-wide`
              + (needs.need.overReplacement < 0
                ? ` — ${Math.abs(needs.need.overReplacement)} BELOW replacement`
                : ' — the thinnest margin in their lineup')
            : '    BIGGEST NEED: not computable, say so');
        L.push('    A FLEX takes RB, WR or TE, so depth at any of those is STARTING depth.'
             + ' Do not call a position finished because the dedicated slots are filled.');
        L.push('    You may recommend a position from this. Say what it is based on.');
      }

      /*
       * The board, priced. Ordered HERE so the model never ranks it itself —
       * "best available" is a ranking, and a ranking it derives is the one
       * thing nothing downstream can check.
       */
      const avail = ctx.bestAvailable;
      if (ctx.valueVariant && !ctx.valueVariant.dynasty) {
        L.push('');
        L.push(`  This is a ${ctx.valueVariant.format} league, so you have NO trade values for it.`
             + ' Dynasty prices would be wrong here — they rate a young player above a better'
             + ' older one — and you must not quote them. Say you do not have values if asked.');
      } else if (ctx.valuesMissing) {
        L.push('');
        L.push('  No trade values are held for this league\'s exact settings'
             + ` (${ctx.valuesMissing.superflex ? 'superflex' : '1QB'}, TE premium`
             + ` ${ctx.valuesMissing.tep}). Say so rather than quoting a different setting\'s.`);
      } else if (avail?.players?.length) {
        L.push('');
        L.push('  BEST AVAILABLE, by community trade value'
             + `${ctx.valueVariant?.superflex ? ' (superflex)' : ''} — nobody in this league rosters`
             + ` these, and ${avail.open} valued players are still on the board:`);
        for (const p of avail.players) {
          const where = [p.position, p.team].filter(Boolean).join(', ');
          L.push(`    ${p.name}${where ? ` (${where})` : ''} — ${p.value}`);
        }
        L.push('    This is a dynasty MARKET PRICE, not a projection for this season.'
             + ' A young player can be worth more than a better one who is older,'
             + ' and that is the point of it.');
      }
    } else if (d.status === 'complete') {
      L.push(when ? `  it is DONE. It was held ${when}` : '  it is DONE.');
    } else if (when && Number(d.startsAt) < Date.now()) {
      // pre_draft with a date in the past: the commissioner set a time and it
      // came and went. Saying "scheduled for" here is the original bug.
      L.push(`  it has NOT started, and the date set for it (${when}) has already passed.`
           + ' Say that plainly rather than announcing it as upcoming.');
    } else {
      L.push(when
        ? `  scheduled for ${when}`
        : '  no date has been set yet, the commissioner picks it in Sleeper');
    }

    L.push(`  ${d.type || 'unknown'} draft, ${d.rounds ?? '?'} rounds` +
           (d.pickSeconds ? `, ${d.pickSeconds} seconds a pick` : ''));
    L.push(d.orderSet
      ? '  the draft order is set, but you have NOT been given it and must say so'
      : '  the draft order has NOT been set yet. Nobody knows where they are picking,'
        + ' and the commissioner sets it in Sleeper. You do not set it.');
  }

  L.section('core');
  if (ctx.unknowns.length) {
    L.push('');
    L.push('WHAT YOU DO NOT KNOW — say so plainly if asked about any of this:');
    for (const u of ctx.unknowns) L.push(`  - ${u}`);
  }

  return L.join('\n');
}

module.exports = { leagueContext, contextBlock, standingsFrom, draftNeeds };

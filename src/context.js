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
    const { rows: arch } = await db.query(
      `select s.season, s.week, s.payload from snapshots s
       join leagues l on l.id = s.league_id
       where l.provider = 'archive' and s.season < $1
       order by s.season desc, s.week desc limit 1`,
      [String(ctx.season)]
    );
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
    ctx.career = await require('./history').career(league.sleeper_league_id).catch(err => {
      console.error('[context] career lookup failed:', err.message);
      return [];
    });
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
function contextBlock(ctx) {
  const L = [];
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
  }

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

  if (ctx.unknowns.length) {
    L.push('');
    L.push('WHAT YOU DO NOT KNOW — say so plainly if asked about any of this:');
    for (const u of ctx.unknowns) L.push(`  - ${u}`);
  }

  return L.join('\n');
}

module.exports = { leagueContext, contextBlock, standingsFrom };

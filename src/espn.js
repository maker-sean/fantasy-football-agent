/**
 * NFL schedule from ESPN's public scoreboard.
 *
 * Sleeper does not publish a schedule (404 on every documented path), and the
 * bot needs real kickoff times for anything that must happen BEFORE a game.
 *
 * A hardcoded slate is not good enough. Week 10 of 2025 kicked off at 09:30 ET
 * in Berlin — three and a half hours before the "early" Sunday window. London,
 * Germany, Thanksgiving, Black Friday, Christmas and late-season Saturdays all
 * break a fixed grid, and the failure is silent: an alert that fires after
 * kickoff is worthless and nothing reports it.
 *
 * No API key. Undocumented but long-stable and widely used; treat a schema
 * change as possible and fail soft rather than crash the worker.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

/**
 * ESPN and Sleeper disagree on exactly one live team abbreviation. Getting this
 * wrong means a player's game is never found, so they are silently never
 * checked — the worst kind of bug for an alerting feature.
 */
const ESPN_TO_SLEEPER = { WSH: 'WAS' };
const SLEEPER_TO_ESPN = { WAS: 'WSH', OAK: 'LV' };   // OAK is legacy Sleeper data

const toSleeperTeam = t => ESPN_TO_SLEEPER[String(t).toUpperCase()] || String(t).toUpperCase();
const toEspnTeam = t => SLEEPER_TO_ESPN[String(t).toUpperCase()] || String(t).toUpperCase();

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`ESPN GET ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Normalize one ESPN event into a game row. */
function toGame(event, season, week) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const state = comp.status?.type?.state;  // pre | in | post
  return {
    espnId: String(event.id),
    season: String(season),
    week: Number(week),
    kickoffAt: new Date(event.date),
    homeTeam: toSleeperTeam(home.team.abbreviation),
    awayTeam: toSleeperTeam(away.team.abbreviation),
    shortName: event.shortName || `${away.team.abbreviation} @ ${home.team.abbreviation}`,
    state: state || 'pre',
    // Neutral-site games are the ones that break a fixed schedule.
    neutralSite: Boolean(comp.neutralSite),
    venue: comp.venue?.fullName || null,
  };
}

/**
 * All games for a week.
 * @param seasonType 2 = regular season, 1 = preseason, 3 = postseason
 */
async function weekGames(season, week, seasonType = 2) {
  const d = await get(`/scoreboard?dates=${season}&seasontype=${seasonType}&week=${week}`);
  const wk = d.week?.number ?? week;
  return (d.events || []).map(e => toGame(e, season, wk)).filter(Boolean);
}

/** team -> game, for the teams playing in a given week. */
function gamesByTeam(games) {
  const m = new Map();
  for (const g of games) {
    m.set(g.homeTeam, g);
    m.set(g.awayTeam, g);
  }
  return m;
}

module.exports = {
  BASE, get, weekGames, gamesByTeam, toGame,
  toSleeperTeam, toEspnTeam, ESPN_TO_SLEEPER, SLEEPER_TO_ESPN,
};

/**
 * Multi-tenant league registry — the scale seam.
 *
 * One running service, many leagues. Inbound routing resolves a league by the
 * chat it arrived on. Phone numbers are NOT the identity anchor: a league keeps
 * its identity across a number rotation or a ban, so recovery is a re-notify
 * rather than a lost customer.
 *
 * In-memory for the prototype. Milestone 4 swaps this for a real store; keep
 * the function signatures stable so nothing upstream cares.
 */

const leagues = new Map(); // leagueId -> { chatId, name, roster, ... }

function registerLeague(leagueId, chatId, meta = {}) {
  leagues.set(leagueId, { chatId, roster: [], ...meta });
  return { id: leagueId, ...leagues.get(leagueId) };
}

function leagueByChat(chatId) {
  if (chatId == null) return null;
  for (const [id, l] of leagues) {
    if (l.chatId === chatId) return { id, ...l };
  }
  return null;
}

/** Bind a league to whatever chat id we actually observed (Milestone 0 discovery). */
function bindChat(leagueId, chatId) {
  const l = leagues.get(leagueId);
  if (!l) return null;
  l.chatId = chatId;
  return { id: leagueId, ...l };
}

function allLeagues() {
  return [...leagues].map(([id, l]) => ({ id, ...l }));
}

module.exports = { registerLeague, leagueByChat, bindChat, allLeagues };

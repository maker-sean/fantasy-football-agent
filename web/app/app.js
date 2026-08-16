/*
 * Commissioner app.
 *
 * No framework and no CDN — same reasoning as the marketing site. This is a
 * linear form over an API that already enforces every rule that matters, so a
 * build step would buy nothing and cost a toolchain.
 *
 * Auth talks to Supabase's REST endpoints directly rather than loading their
 * JS client from a CDN. Magic link is two calls: ask for the email, then read
 * the tokens Supabase puts in the URL fragment when the link is clicked.
 */

const $ = id => document.getElementById(id);
const TOKEN_KEY = 'commish.token';

let CONFIG = {};
let ME = null;
let CURRENT = null;      // league being onboarded or configured
let pollTimer = null;

document.getElementById('yr').textContent = new Date().getFullYear();

// ------------------------------------------------------------------ util ----

function view(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = true;
  $(id).hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // Leaving the waiting screen must stop the poll, or it keeps running for the
  // rest of the session and quietly flips the view back under the user.
  if (id !== 'v-chat' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function say(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg-line' + (kind ? ' ' + kind : '');
}

const token = () => localStorage.getItem(TOKEN_KEY);

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const t = token();
  if (t) headers.authorization = 'Bearer ' + t;

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });

  // An expired session should return you to sign-in, not to a broken screen.
  if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); view('v-signin'); throw new Error('signed out'); }

  let json = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  if (!res.ok) throw Object.assign(new Error(json?.error || 'request_failed'), { status: res.status, body: json });
  return json;
}

// ------------------------------------------------------------------ auth ----

async function sendMagicLink() {
  const email = $('email').value.trim();
  if (!email || !email.includes('@')) return say($('signin-msg'), 'Enter a valid email.', 'err');
  if (!CONFIG.supabaseUrl) return say($('signin-msg'), 'Sign-in is not configured on this server yet.', 'err');

  $('send-link').disabled = true;
  say($('signin-msg'), 'Sending…');
  try {
    const res = await fetch(`${CONFIG.supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: CONFIG.supabaseAnonKey },
      body: JSON.stringify({ email, create_user: true, options: { email_redirect_to: location.origin + '/app/' } }),
    });
    if (!res.ok) throw new Error(await res.text());
    say($('signin-msg'), `Sent. Check ${email} and click the link — you can close this tab.`, 'ok');
  } catch (err) {
    say($('signin-msg'), 'Could not send the link. Try again in a moment.', 'err');
    console.error(err);
  } finally {
    $('send-link').disabled = false;
  }
}

/** Supabase returns tokens in the URL fragment when the emailed link is opened. */
function captureTokenFromHash() {
  if (!location.hash.includes('access_token')) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const t = params.get('access_token');
  if (!t) return false;
  localStorage.setItem(TOKEN_KEY, t);
  // Strip it immediately: an access token sitting in the address bar gets
  // pasted into bug reports and copied into chat messages.
  history.replaceState(null, '', location.pathname);
  return true;
}

// -------------------------------------------------------------- routing ----

async function boot() {
  CONFIG = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  captureTokenFromHash();

  // With dev auth on, the server ignores tokens entirely.
  if (!token() && !CONFIG.devAuth) return view('v-signin');

  try {
    ME = await api('GET', '/api/me');
  } catch {
    return view('v-signin');
  }

  $('nav-who').textContent = ME.account.email;
  $('signout').hidden = false;

  if (ME.account.needsTerms) return view('v-terms');
  return route();
}

/**
 * Send the commissioner to wherever they actually are.
 *
 * Onboarding state lives in the database, not in this page, so closing the tab
 * after paying and coming back tomorrow lands on the right screen instead of
 * starting over.
 */
function route() {
  const leagues = ME.leagues || [];
  const unfinished = leagues.find(l => l.onboarding_state !== 'live');

  if (!leagues.length) { $('have-leagues').hidden = true; return view('v-league'); }
  $('have-leagues').hidden = false;

  if (unfinished) {
    CURRENT = unfinished;
    if (unfinished.onboarding_state === 'awaiting_chat') return showChat();
    return showRoster();
  }
  return showDashboard();
}

async function refreshMe() { ME = await api('GET', '/api/me'); }

// ------------------------------------------------- step 4: pick a league ----

async function findLeagues() {
  const username = $('sleeper-user').value.trim().replace(/^@/, '');
  if (!username) return say($('league-msg'), 'Type your Sleeper username.', 'err');

  $('find-leagues').disabled = true;
  say($('league-msg'), 'Looking…');
  $('league-list').innerHTML = '';
  try {
    const data = await api('GET', '/api/sleeper/leagues?username=' + encodeURIComponent(username));
    if (!data.leagues.length) return say($('league-msg'), `Found ${data.user.name}, but no NFL leagues on that account.`, 'err');
    say($('league-msg'), `${data.leagues.length} found for ${data.user.name}.`);
    for (const lg of data.leagues) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'league-card';
      b.innerHTML = '<span class="lg-name"></span><span class="lg-meta"></span>';
      b.querySelector('.lg-name').textContent = lg.name;
      b.querySelector('.lg-meta').textContent = `${lg.total_rosters} teams · ${lg.season}`;
      b.onclick = () => linkLeague(lg.league_id, b);
      $('league-list').appendChild(b);
    }
  } catch (err) {
    say($('league-msg'), err.message === 'no_such_user'
      ? `No Sleeper user called "${username}".`
      : 'Could not reach Sleeper. Try again.', 'err');
  } finally {
    $('find-leagues').disabled = false;
  }
}

async function linkLeague(sleeperLeagueId, btn) {
  btn.disabled = true;
  say($('league-msg'), 'Linking…');
  try {
    const { league } = await api('POST', '/api/leagues', { sleeperLeagueId });
    CURRENT = league;
    await refreshMe();
    showRoster();
  } catch (err) {
    say($('league-msg'), 'Could not link that league.', 'err');
    btn.disabled = false;
  }
}

// ------------------------------------------------ step 5: roster binding ----

async function showRoster() {
  view('v-roster');
  const rows = $('roster-rows');
  rows.innerHTML = '<p class="muted small">Loading rosters…</p>';
  try {
    const data = await api('GET', `/api/leagues/${CURRENT.id}/roster`);
    rows.innerHTML = '';
    for (const r of data.rosters) {
      const row = document.createElement('div');
      row.className = 'roster-row';
      row.innerHTML =
        `<div class="rr-team"><strong></strong><span class="lg-meta"></span></div>` +
        `<input class="rr-name" type="text" placeholder="Their name">` +
        `<input class="rr-phone" type="tel" inputmode="tel" placeholder="Mobile number">`;
      row.querySelector('strong').textContent = r.teamName || `Roster ${r.sleeperRosterId}`;
      row.querySelector('.lg-meta').textContent = r.hasPhone ? 'number on file' : '';
      row.querySelector('.rr-name').value = r.humanName || '';
      if (r.hasPhone) row.querySelector('.rr-phone').placeholder = '•••• on file — type to replace';
      row.dataset.userId = r.sleeperUserId;
      row.dataset.rosterId = r.sleeperRosterId;
      rows.appendChild(row);
    }
  } catch {
    rows.innerHTML = '<p class="msg-line err">Could not load rosters.</p>';
  }
}

async function saveRoster(skip) {
  const members = [];
  if (!skip) {
    for (const row of document.querySelectorAll('.roster-row')) {
      const name = row.querySelector('.rr-name').value.trim();
      const phone = row.querySelector('.rr-phone').value.trim();
      if (!name && !phone) continue;   // untouched rows stay untouched
      members.push({
        sleeperUserId: row.dataset.userId,
        sleeperRosterId: Number(row.dataset.rosterId),
        humanName: name || null,
        phone: phone || null,
      });
    }
  }

  $('save-roster').disabled = true;
  say($('roster-msg'), 'Saving…');
  try {
    if (members.length) {
      const { results } = await api('POST', `/api/leagues/${CURRENT.id}/members`, { members });
      const bad = results.filter(r => r.outcome === 'bad_phone').length;
      if (bad) {
        say($('roster-msg'), `${bad} number${bad === 1 ? " wasn't" : "s weren't"} a valid mobile number — check and try again.`, 'err');
        $('save-roster').disabled = false;
        return;
      }
    }
    await api('POST', `/api/leagues/${CURRENT.id}/await-chat`);
    await refreshMe();
    CURRENT = ME.leagues.find(l => l.id === CURRENT.id) || CURRENT;
    showChat();
  } catch {
    say($('roster-msg'), 'Could not save. Try again.', 'err');
  } finally {
    $('save-roster').disabled = false;
  }
}

// -------------------------------------------- step 6: confirm the chat ----

async function showChat() {
  view('v-chat');
  say($('copy-msg'), '');
  try {
    const info = await api('POST', `/api/leagues/${CURRENT.id}/await-chat`);
    $('bot-number').textContent = info.number || '(number not configured)';
  } catch {
    $('bot-number').textContent = '(unavailable)';
  }

  // The screen holds here on purpose. Nothing the commissioner can click marks
  // this done — only a real message arriving from the group does.
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checkChat, 5000);
  checkChat();
}

async function checkChat() {
  try {
    const s = await api('GET', `/api/leagues/${CURRENT.id}/chat-status`);
    if (!s.live) return;
    clearInterval(pollTimer); pollTimer = null;
    $('waiting').classList.add('done');
    $('wait-title').textContent = 'Heard you. Your league is live.';
    $('wait-note').textContent = 'The agent is in your chat and will start with this week.';
    await refreshMe();
    setTimeout(showDashboard, 1600);
  } catch { /* transient; the next tick retries */ }
}

// ----------------------------------------------------------- dashboard ----

async function showDashboard() {
  view('v-dashboard');
  const box = $('dash-leagues');
  box.innerHTML = '';
  for (const lg of ME.leagues) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'league-card';
    b.innerHTML = '<span class="lg-name"></span><span class="lg-meta"></span>';
    b.querySelector('.lg-name').textContent = lg.name;
    const live = lg.onboarding_state === 'live';
    b.querySelector('.lg-meta').textContent =
      (live ? 'Live' : 'Setup unfinished — ' + lg.onboarding_state.replace(/_/g, ' ')) +
      (lg.subscription_status && lg.subscription_status !== 'none' ? ' · ' + lg.subscription_status : '');
    b.onclick = () => {
      CURRENT = lg;
      if (!live) return lg.onboarding_state === 'awaiting_chat' ? showChat() : showRoster();
      openConfig(lg);
    };
    box.appendChild(b);
  }
  $('league-config').hidden = true;
}

function openConfig(lg) {
  const cfg = lg.config || {};
  $('cfg-title').textContent = lg.name + ' — settings';
  $('cfg-names').value = (cfg.botNames || ['bot']).join(', ');
  $('cfg-spice').value = cfg.spice ?? 1;
  $('cfg-tz').value = cfg.timezone || 'America/New_York';
  $('league-config').hidden = false;
  say($('config-msg'), '');
  $('league-config').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveConfig() {
  const botNames = $('cfg-names').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  $('save-config').disabled = true;
  say($('config-msg'), 'Saving…');
  try {
    await api('PATCH', `/api/leagues/${CURRENT.id}/config`, {
      config: { botNames, spice: Number($('cfg-spice').value), timezone: $('cfg-tz').value.trim() },
    });
    await refreshMe();
    CURRENT = ME.leagues.find(l => l.id === CURRENT.id) || CURRENT;
    say($('config-msg'), 'Saved.', 'ok');
  } catch {
    say($('config-msg'), 'Could not save.', 'err');
  } finally {
    $('save-config').disabled = false;
  }
}

// -------------------------------------------------------------- wiring ----

$('send-link').onclick = sendMagicLink;
$('email').onkeydown = e => { if (e.key === 'Enter') sendMagicLink(); };

$('accept-terms').onclick = async () => {
  $('accept-terms').disabled = true;
  try { await api('POST', '/api/me/terms'); await refreshMe(); route(); }
  catch { say($('terms-msg'), 'Could not save that. Try again.', 'err'); $('accept-terms').disabled = false; }
};

$('find-leagues').onclick = findLeagues;
$('sleeper-user').onkeydown = e => { if (e.key === 'Enter') findLeagues(); };
$('save-roster').onclick = () => saveRoster(false);
$('skip-roster').onclick = () => saveRoster(true);
$('to-dashboard-1').onclick = showDashboard;
$('to-dashboard-2').onclick = showDashboard;
$('add-league').onclick = () => { $('have-leagues').hidden = false; view('v-league'); };
$('save-config').onclick = saveConfig;

$('copy-number').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('bot-number').textContent);
    say($('copy-msg'), 'Copied.', 'ok');
  } catch {
    say($('copy-msg'), 'Copy failed — select the number and copy it manually.', 'err');
  }
};

$('signout').onclick = e => {
  e.preventDefault();
  localStorage.removeItem(TOKEN_KEY);
  location.href = '/app/';
};

boot();

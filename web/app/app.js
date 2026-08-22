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
  //
  // The REASON survives the throw. This used to raise a bare 'signed out',
  // which was fine while every 401 meant the same thing — but a texted setup
  // link can expire, and "that link has expired, text for a new one" is only
  // sayable if the code the server sent is still in hand here.
  if (res.status === 401) {
    let why = null;
    try { why = (await res.json())?.error; } catch { /* empty body is fine */ }
    localStorage.removeItem(TOKEN_KEY);
    view('v-signin');
    throw Object.assign(new Error(why || 'signed out'), { status: 401, code: why });
  }

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
    // redirect_to is a QUERY parameter. It was in the body as
    // options.email_redirect_to, which is the supabase-js client shape and is
    // ignored by the REST endpoint, so every link went to the project's Site
    // URL instead. Nothing errored; the email just arrived pointing elsewhere.
    const res = await fetch(otpUrl(CONFIG.supabaseUrl, location.origin + '/app/'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: CONFIG.supabaseAnonKey },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!res.ok) { const t = await res.text(); throw Object.assign(new Error(t), { status: res.status, raw: t }); }
    say($('signin-msg'), `Sent. Check ${email} and click the link — you can close this tab.`, 'ok');
  } catch (err) {
    say($('signin-msg'), otpError(err.status, err.raw), 'err');
    console.error(err);
  } finally {
    $('send-link').disabled = false;
  }
}

/**
 * Two kinds of credential arrive the same way, in the URL fragment.
 *
 *   access_token=…   Supabase, from an emailed magic link.
 *   setup=…          ours, from a link texted to a verified phone.
 *
 * Both are bearer tokens and both go in the fragment rather than the query
 * string, because a fragment is never sent to a server — it cannot land in an
 * access log, a proxy, or a Referer header on the way to a third party.
 *
 * Downstream nothing changes: api() sends whatever is in storage as a Bearer
 * header and the server decides which kind it is. That is deliberate. A second
 * parallel auth path in the client is how the two drift apart and one of them
 * quietly stops carrying the header on some routes.
 */
function captureTokenFromHash() {
  if (!location.hash) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const t = params.get('access_token') || params.get('setup');
  if (!t) return false;
  localStorage.setItem(TOKEN_KEY, t);
  // Strip it immediately: a token sitting in the address bar gets pasted into
  // bug reports and copied into chat messages. A texted one is worse than an
  // emailed one for this — people screenshot texts.
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
  } catch (err) {
    // An expired invite has to SAY so. Bouncing to the sign-in screen would ask
    // for an email address the person never gave us and cannot use, and the
    // failure would read as "the link is broken" rather than "ask for another".
    if (/link_expired/.test(String(err && err.message))) {
      view('v-signin');
      say($('signin-msg'), 'That setup link has expired. Text the number again and we will send a fresh one.', 'err');
      return;
    }
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

  if (!leagues.length) {
    $('have-leagues').hidden = true;
    /*
     * Somebody who arrived by texted invite already picked their league — that
     * is precisely what the code they texted MEANT. Asking them for a Sleeper
     * username to find it again is asking a question we are holding the answer
     * to, and it is the likeliest step to lose them: the field wants the name
     * they LOG IN with, not their team name, and people do not reliably know
     * the difference.
     */
    if (ME.invite && ME.invite.sleeperLeagueId) return linkInvitedLeague();
    return view('v-league');
  }
  $('have-leagues').hidden = false;

  if (unfinished) {
    CURRENT = unfinished;
    if (unfinished.onboarding_state === 'awaiting_chat') return showChat();
    // members_bound sits between the roster and the chat, which is exactly
    // where choosing a name belongs — so the new step needed no new state and
    // no migration. Quitting midway still resumes in the right place.
    if (unfinished.onboarding_state === 'members_bound') return showNames();
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

/**
 * Link a league and move on.
 *
 * Returns whether it worked rather than throwing, and takes an OPTIONAL button:
 * the invite path has no button to disable, and rethrowing would leave the
 * existing click handler with an unhandled rejection.
 */
async function linkLeague(sleeperLeagueId, btn) {
  if (btn) btn.disabled = true;
  say($('league-msg'), 'Linking…');
  try {
    const { league } = await api('POST', '/api/leagues', { sleeperLeagueId });
    CURRENT = league;
    await refreshMe();
    showRoster();
    return true;
  } catch (err) {
    say($('league-msg'), 'Could not link that league.', 'err');
    if (btn) btn.disabled = false;
    return false;
  }
}

/**
 * Open the league the invite already named, skipping the picker.
 *
 * Falls back to the manual search rather than stranding them — a league that
 * has since been deleted on Sleeper, or an id that no longer resolves, should
 * cost one extra step and not the whole session.
 */
async function linkInvitedLeague() {
  view('v-league');
  $('have-leagues').hidden = true;
  say($('league-msg'), `Opening ${ME.invite.leagueName || 'your league'}…`);
  if (!await linkLeague(ME.invite.sleeperLeagueId)) {
    say($('league-msg'), 'Could not open that league automatically — find it below.', 'err');
  }
}


// ------------------------------------------------ step 3: what it answers to ----

/*
 * A league's bot only speaks when spoken to, and until now nothing in
 * onboarding said so or asked what to call it. The name lived in a
 * comma-separated text box on the settings screen, behind the dashboard, which
 * a commissioner reaches after the group chat is already live.
 *
 * That is not a cosmetic gap. The default was 'bot' while the introduction the
 * group receives advertised "Commish", so the first person to type "Hi Commish"
 * in a real league was ignored — no error, no reply, nothing to explain it.
 * Asking here, before the bot is ever in the chat, is what makes the
 * introduction and the reply gate agree by construction.
 */
const SUGGESTED_NAMES = ['commish', 'bot', 'jarvis'];

/*
 * 'commish' is offered but never pre-ticked.
 *
 * In most leagues that word is a HUMAN — "commish can you fix the waiver
 * order", "commish is asleep at the wheel again" — and a bot that answers to it
 * interrupts both. The commissioner knows whether their league talks that way
 * and is entitled to choose; they are just told first. src/decide.js keeps it
 * out of the default for the same reason.
 */
const NAME_CAUTION = {
  commish: 'Heads up: most leagues use "commish" for you, the actual person. Tick this and the bot answers when someone means you.',
};
let CHOSEN_NAMES = [];

const prettyName = n => n.charAt(0).toUpperCase() + n.slice(1);

function renderNameChips() {
  const box = $('name-chips');
  box.innerHTML = '';

  // Suggestions first, in a stable order, then anything typed — so the chips
  // do not reshuffle under a thumb as they are tapped.
  const all = [...SUGGESTED_NAMES, ...CHOSEN_NAMES.filter(n => !SUGGESTED_NAMES.includes(n))];

  for (const name of all) {
    const on = CHOSEN_NAMES.includes(name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (on ? ' on' : '');
    chip.setAttribute('aria-pressed', String(on));
    chip.textContent = prettyName(name);
    chip.onclick = () => {
      CHOSEN_NAMES = on ? CHOSEN_NAMES.filter(n => n !== name) : [...CHOSEN_NAMES, name];
      renderNameChips();
    };
    box.appendChild(chip);
  }

  // Say the awkward thing at the moment it becomes true, not in advance.
  const caution = CHOSEN_NAMES.map(n => NAME_CAUTION[n]).filter(Boolean);
  $('name-caution').textContent = caution.join(' ');
  $('name-caution').hidden = !caution.length;

  const preview = $('name-preview');
  if (!CHOSEN_NAMES.length) {
    preview.textContent = 'Pick at least one, or it will never answer anybody.';
  } else {
    const pretty = CHOSEN_NAMES.map(prettyName);
    const list = pretty.length === 1 ? pretty[0]
      : pretty.slice(0, -1).join(', ') + ' or ' + pretty[pretty.length - 1];
    // "Commish or Bot all work" reads as a typo. One works, two both work,
    // three or more all work.
    const verb = pretty.length === 1 ? 'works' : pretty.length === 2 ? 'both work' : 'all work';
    preview.textContent = `Your league says "Hey ${pretty[0]}, who should I start?" — ${list} ${verb}.`;
  }
}

function addCustomName() {
  const raw = $('name-custom').value.trim().toLowerCase();
  $('name-custom').value = '';
  if (!raw) return;

  // A trigger is matched on a word boundary, so a name with spaces or
  // punctuation in it can never fire. Better to say that than to store
  // something that silently never works.
  if (!/^[a-z0-9]{2,24}$/.test(raw)) {
    return say($('names-msg'), 'One word, letters and numbers only — that is what it can match on.', 'err');
  }
  say($('names-msg'), '');
  if (!CHOSEN_NAMES.includes(raw)) CHOSEN_NAMES.push(raw);
  renderNameChips();
}

async function showNames() {
  view('v-names');
  say($('names-msg'), '');
  const configured = (CURRENT && CURRENT.config && CURRENT.config.botNames) || [];
  CHOSEN_NAMES = configured.length
    ? configured.map(n => String(n).toLowerCase())
    : ['bot'];
  renderNameChips();
}

async function saveNames() {
  if (!CHOSEN_NAMES.length) {
    return say($('names-msg'), 'Pick at least one name, or nobody can get its attention.', 'err');
  }
  $('save-names').disabled = true;
  say($('names-msg'), 'Saving…');
  try {
    await api('PATCH', `/api/leagues/${CURRENT.id}/config`, { config: { botNames: CHOSEN_NAMES } });
    await refreshMe();
    CURRENT = ME.leagues.find(l => l.id === CURRENT.id) || CURRENT;
    showChat();
  } catch {
    say($('names-msg'), 'Could not save. Try again.', 'err');
  } finally {
    $('save-names').disabled = false;
  }
}

// ------------------------------------------------ step 5: roster binding ----

/**
 * One card per TEAM, one row per person on it.
 *
 * Two changes from the flat list this replaces.
 *
 * The heading leads with the Sleeper USERNAME, not the team name. Team names
 * are jokes, they change mid-season, and in this league they are things like
 * "Punt Intended" and "Ruiz's Onside Bandits" — which tell a commissioner
 * nothing about who they belong to. The username is stable and is what people
 * actually recognise each other by. The team name stays underneath, because it
 * is the thing they will see in the Sleeper app while filling this in.
 *
 * And a roster can hold more than one person. Co-managed teams are ordinary,
 * and a co-owner whose number is not here is invisible to the bot: their texts
 * fall outside the reply gate and go unanswered, with nothing to explain why.
 */
async function showRoster() {
  view('v-roster');
  const rows = $('roster-rows');
  rows.innerHTML = '<p class="muted small">Loading rosters…</p>';
  REMOVED_MEMBER_IDS = [];
  try {
    const data = await api('GET', `/api/leagues/${CURRENT.id}/roster`);
    rows.innerHTML = '';
    for (const r of data.rosters) rows.appendChild(teamCard(r));
  } catch {
    rows.innerHTML = '<p class="msg-line err">Could not load rosters.</p>';
  }
}

/** Ids of co-owner rows the commissioner removed, sent on save. */
let REMOVED_MEMBER_IDS = [];

function ownerRow({ id, humanName, hasPhone, isPrimary }) {
  const el = document.createElement('div');
  el.className = 'rr-owner';
  el.innerHTML =
    `<input class="rr-name" type="text" placeholder="Their name">` +
    `<input class="rr-phone" type="tel" inputmode="tel" placeholder="Mobile number">` +
    `<button class="rr-remove" type="button" title="Remove this owner" aria-label="Remove this owner">×</button>`;

  el.querySelector('.rr-name').value = humanName || '';
  if (hasPhone) el.querySelector('.rr-phone').placeholder = '•••• on file — type to replace';
  if (id) el.dataset.memberId = id;

  // The primary is Sleeper's own owner of the roster. Removing it here would
  // mean nothing — the next members:sync puts it straight back — so the control
  // is not offered rather than offered and quietly ignored.
  el.dataset.primary = isPrimary ? 'true' : 'false';
  const remove = el.querySelector('.rr-remove');
  if (isPrimary) remove.remove();
  else remove.onclick = () => {
    if (el.dataset.memberId) REMOVED_MEMBER_IDS.push(el.dataset.memberId);
    el.remove();
  };
  return el;
}

function teamCard(r) {
  const card = document.createElement('div');
  card.className = 'roster-team';
  card.dataset.userId = r.sleeperUserId || '';
  card.dataset.rosterId = r.sleeperRosterId;
  card.innerHTML =
    `<div class="rt-head"><strong></strong><span class="lg-meta"></span></div>` +
    `<div class="rt-owners"></div>` +
    `<button class="rt-add" type="button">+ Add another owner</button>`;

  // An unclaimed roster has neither label — roster 5 in this league has no
  // owner on Sleeper at all. "Roster 5" is at least true.
  card.querySelector('strong').textContent =
    r.username || r.teamName || `Roster ${r.sleeperRosterId}`;
  card.querySelector('.lg-meta').textContent =
    r.username && r.teamName ? r.teamName : '';

  const owners = card.querySelector('.rt-owners');
  const existing = (r.owners && r.owners.length)
    ? r.owners
    : [{ isPrimary: Boolean(r.sleeperUserId), humanName: null, hasPhone: false }];
  for (const o of existing) owners.appendChild(ownerRow(o));

  card.querySelector('.rt-add').onclick = () => {
    owners.appendChild(ownerRow({ isPrimary: false }));
    owners.lastChild.querySelector('.rr-name').focus();
  };
  return card;
}

async function saveRoster(skip) {
  const members = [];
  if (!skip) {
    for (const card of document.querySelectorAll('.roster-team')) {
      const rosterId = Number(card.dataset.rosterId);
      for (const row of card.querySelectorAll('.rr-owner')) {
        const name = row.querySelector('.rr-name').value.trim();
        const phone = row.querySelector('.rr-phone').value.trim();
        if (!name && !phone) continue;   // untouched rows stay untouched

        const isPrimary = row.dataset.primary === 'true';
        members.push({
          // Only the primary carries a Sleeper account. A co-owner has none,
          // which is exactly why the server keys this on the roster.
          sleeperUserId: isPrimary ? (card.dataset.userId || null) : null,
          sleeperRosterId: rosterId,
          humanName: name || null,
          phone: phone || null,
        });
      }
    }
  }

  $('save-roster').disabled = true;
  say($('roster-msg'), 'Saving…');
  try {
    if (members.length) {
      const { results } = await api('POST', `/api/leagues/${CURRENT.id}/members`,
        { members, removedMemberIds: REMOVED_MEMBER_IDS });
      const bad = results.filter(r => r.outcome === 'bad_phone').length;
      if (bad) {
        say($('roster-msg'), `${bad} number${bad === 1 ? " wasn't" : "s weren't"} a valid mobile number — check and try again.`, 'err');
        $('save-roster').disabled = false;
        return;
      }
      // A co-owner with a name and no number cannot be stored, and saying so
      // beats dropping them silently — which is what the old code did to every
      // co-owner, since it skipped anything without a Sleeper account.
      const needPhone = results.filter(r => r.outcome === 'phone_required').length;
      if (needPhone) {
        say($('roster-msg'), `${needPhone} extra owner${needPhone === 1 ? ' needs a' : 's need'} mobile number — the bot recognises people by their number.`, 'err');
        $('save-roster').disabled = false;
        return;
      }
      REMOVED_MEMBER_IDS = [];
    }
    await refreshMe();
    CURRENT = ME.leagues.find(l => l.id === CURRENT.id) || CURRENT;
    showNames();
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

  /*
   * Say what it will and will not do once it is in there.
   *
   * "Send any message" is literally true for LINKING — the chat is matched on
   * the sender's number, not on anything they type. But the next thing anybody
   * does is try to talk to it, and it answers only when addressed. Leaving that
   * to be discovered is how a working bot reads as a broken one.
   */
  const names = ((CURRENT && CURRENT.config && CURRENT.config.botNames) || CHOSEN_NAMES || [])
    .map(prettyName);
  $('chat-names-note').textContent = names.length
    ? `After that it stays quiet until someone says its name — ${names.join(', ')}. It introduces itself and explains that on arrival.`
    : '';
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
$('save-names').onclick = saveNames;
$('name-add').onclick = addCustomName;
$('name-custom').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCustomName(); } };
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

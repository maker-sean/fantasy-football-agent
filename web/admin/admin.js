/*
 * Operator board.
 *
 * Same token the commissioner app stores, same magic link, because a second
 * auth path is a second thing to get wrong. Operator access is decided on the
 * server by an allowlist; this file cannot grant itself anything, and a 404
 * from /api/admin is the expected answer for a signed-in non-operator.
 */
const TOKEN_KEY = 'commish.token';
const $ = id => document.getElementById(id);
const token = () => localStorage.getItem(TOKEN_KEY);
const show = (id, on) => { $(id).hidden = !on; };

let LEAGUES = [];

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const t = token();
  if (t) headers.authorization = 'Bearer ' + t;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); boot(); throw new Error('signed out'); }
  let json = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  if (!res.ok) throw Object.assign(new Error(json?.error || 'request_failed'), { status: res.status });
  return json;
}

const fmtTime = ts => new Date(ts).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// --- sign in ----------------------------------------------------------------
async function sendLink() {
  const email = $('email').value.trim();
  if (!email) return;
  const msg = $('signin-msg');
  msg.textContent = 'Sending…';
  try {
    /*
     * Through our own server, not straight to Supabase.
     *
     * The allowlist is checked there, before any email is sent. Doing it here
     * would be theatre: the anon key is public, so anyone can call Supabase
     * directly. And the built-in SMTP allows two emails per hour across the
     * whole project, so an unchecked form is not a nuisance, it is a way to
     * lock the operator out of their own dashboard.
     *
     * The reply is the same whether or not the address is an operator.
     */
    const r = await fetch('/api/admin/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const j = await r.json().catch(() => ({}));
    msg.textContent = j.message || 'If that address can sign in here, a link is on its way.';
  } catch {
    msg.textContent = 'Could not reach the server.';
  }
}

function captureTokenFromHash() {
  if (!location.hash.includes('access_token')) return false;
  const t = new URLSearchParams(location.hash.slice(1)).get('access_token');
  if (!t) return false;
  localStorage.setItem(TOKEN_KEY, t);
  history.replaceState(null, '', location.pathname);
  return true;
}

// --- rendering --------------------------------------------------------------
function renderOverview(o) {
  const r = o.replies;
  $('reply-rate').textContent = r.rate === null ? '—' : Math.round(r.rate * 100) + '%';
  $('reply-sub').textContent = `${r.answered} of ${r.bot_messages} answered`;
  $('bot-msgs').textContent = r.bot_messages;
  $('window-sub').textContent = `last ${o.days}d, ${r.windowMinutes}m window`;

  const rows = [`<tr class="head"><td>Layer</td><td>Verdict</td><td>Reason</td><td class="num">Count</td><td class="num">Latency</td></tr>`];
  if (!o.decisions.length) {
    rows.push('<tr><td colspan="5" class="dim">Nothing decided in this window.</td></tr>');
  }
  for (const d of o.decisions) {
    rows.push(`<tr>
      <td class="mono">${esc(d.layer)}</td>
      <td class="${d.decision === 'reply' ? 'tag-reply' : 'tag-silent'}">${esc(d.decision)}</td>
      <td class="mono dim">${esc(d.reason)}</td>
      <td class="num">${d.n}</td>
      <td class="num dim">${d.avg_latency_ms == null ? '—' : d.avg_latency_ms + 'ms'}</td>
    </tr>`);
  }
  $('decisions').querySelector('tbody').innerHTML = rows.join('');

  const paused = o.flags.find(f => f.key === 'replies_paused')?.value === true;
  const envDry = o.dryRunEnv;
  const state = $('kill-state');
  state.textContent = envDry ? 'dry run (env)' : paused ? 'paused' : 'live';
  state.className = 'pill ' + (envDry || paused ? 'paused' : 'live');
  const btn = $('kill');
  btn.disabled = envDry;                       // env wins; do not pretend otherwise
  btn.textContent = envDry ? 'REPLY_DRY_RUN is on' : paused ? 'Resume replies' : 'Pause replies';
  btn.onclick = async () => {
    btn.disabled = true;
    await api('POST', '/api/admin/flags/replies-paused', { paused: !paused });
    await load();
  };
}

/*
 * Every league, sortable and filterable, in a pane that scrolls on its own.
 *
 * The table used to be a short unsorted list, which was fine at one league and
 * useless at fifty: the ones worth looking at are the quiet ones and the
 * half-bound ones, and neither floats to the top on its own.
 *
 * Sorting and filtering happen HERE, not on the server. The whole list is
 * already in hand — it arrived with the page — so a round trip per click would
 * add latency to answer a question the browser can already answer.
 */
let LG_SORT = { key: 'last_message_at', dir: -1 };

const LG_COLS = [
  { key: 'name',               label: 'League',        sort: 'name' },
  { key: 'onboarding_state',   label: 'State',         sort: 'onboarding_state' },
  { key: 'bound',              label: 'Bound',         sort: 'bound_members',      num: true },
  { key: 'messages',           label: 'Msgs',          sort: 'messages',           num: true },
  { key: 'responses_per_send', label: 'Resp/send',     sort: 'responses_per_send', num: true },
  { key: 'days_active',        label: 'Days',          sort: 'days_active',        num: true },
  { key: 'pending_drafts',     label: 'Pending',       sort: 'pending_drafts',     num: true },
  { key: 'last_message_at',    label: 'Last activity', sort: 'last_message_at' },
];

function renderLeagues(list) {
  if (list) LEAGUES = list;
  const live = LEAGUES.filter(l => l.onboarding_state === 'live').length;
  $('live-count').textContent = live;
  $('live-sub').textContent = `${LEAGUES.length} onboarded`;

  const q = ($('lg-filter').value || '').trim().toLowerCase();
  const state = $('lg-state').value;
  let rows = LEAGUES.filter(l =>
    (!q || String(l.name || '').toLowerCase().includes(q)) &&
    (!state || l.onboarding_state === state));

  const { key, dir } = LG_SORT;
  rows = rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    // Nulls always sink, whichever way the sort is pointing. A league with no
    // messages is not the "best" performer just because you clicked descending.
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  $('lg-count').textContent = rows.length === LEAGUES.length
    ? `${rows.length} league${rows.length === 1 ? '' : 's'}`
    : `${rows.length} of ${LEAGUES.length}`;

  const head = LG_COLS.map(c => {
    const on = LG_SORT.key === c.sort;
    const arrow = on ? (LG_SORT.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<td class="${c.num ? 'num ' : ''}sortable${on ? ' sorted' : ''}" data-sort="${c.sort}">${c.label}${arrow}</td>`;
  }).join('');

  const html = [`<tr class="head">${head}</tr>`];
  for (const l of rows) {
    // Partial binding is the failure that degrades everything quietly: the
    // recap says "Roster 7" and the gate refuses to answer strangers.
    const partial = l.total_members > 0 && l.bound_members < l.total_members;
    // No chat id means there is no conversation to open yet, so the row must
    // not pretend to be clickable.
    const openable = Boolean(l.chat_id);
    html.push(`<tr class="${openable ? 'click' : ''}" data-chat="${esc(l.chat_id || '')}" data-league="${esc(l.id)}">
      <td>${esc(l.name)}<div class="dim mono" style="font-size:.72rem">${esc(l.provider)} · ${esc(l.season || '')}</div></td>
      <td class="mono ${l.onboarding_state === 'live' ? 'tag-reply' : 'warn'}">${esc(l.onboarding_state)}</td>
      <td class="num ${partial ? 'warn' : ''}">${l.bound_members}/${l.total_members}</td>
      <td class="num">${l.messages}</td>
      <td class="num ${l.responses_per_send === null ? 'dim' : ''}">${l.responses_per_send ?? '—'}</td>
      <td class="num dim">${l.days_active ?? '—'}</td>
      <td class="num ${l.pending_drafts ? 'warn' : 'dim'}">${l.pending_drafts || '—'}</td>
      <td class="dim">${l.last_message_at ? fmtTime(l.last_message_at) : '—'}</td>
    </tr>`);
  }

  const tbody = $('leagues').querySelector('tbody');
  tbody.innerHTML = html.join('');

  tbody.querySelectorAll('td.sortable').forEach(td => td.onclick = () => {
    const k = td.dataset.sort;
    // Same column flips direction; a new column starts descending, because for
    // every numeric column here "most" is the interesting end.
    LG_SORT = LG_SORT.key === k ? { key: k, dir: -LG_SORT.dir } : { key: k, dir: -1 };
    renderLeagues();
  });

  tbody.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => {
    // Straight into the conversation rather than the inline thread panel. The
    // question behind clicking a league is almost always "what did it say", and
    // the Messages tab answers it better than a table ever did.
    selectTab('messages');
    openConvo(tr.dataset.chat);
  });
}


/*
 * The thread, with silent decisions interleaved.
 *
 * Messages and decisions are merged on time rather than joined in SQL, because
 * a decision that produced no message has nothing to join to, and those are
 * exactly the rows worth seeing.
 */
async function openThread(leagueId) {
  const league = LEAGUES.find(l => l.id === leagueId);
  show('thread-h', true); show('thread', true);
  $('thread-h').textContent = 'Thread — ' + (league ? league.name : leagueId);
  const box = $('thread');
  box.innerHTML = '<p class="dim">Loading…</p>';

  const { messages, decisions } = await api('GET', `/api/admin/leagues/${leagueId}/thread?limit=300`);

  const events = [
    ...messages.map(m => ({ at: m.occurred_at, kind: 'msg', m })),
    ...decisions.filter(d => d.decision === 'silent').map(d => ({ at: d.created_at, kind: 'silent', d })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  if (!events.length) { box.innerHTML = '<p class="dim">No messages recorded for this league.</p>'; return; }

  const byTrigger = new Map(decisions.map(d => [String(d.trigger_message_id), d]));

  box.innerHTML = events.map(e => {
    if (e.kind === 'silent') {
      const d = e.d;
      return `<div class="ev silent"><div class="ev-body">stayed quiet · ${esc(d.layer)} · ${esc(d.reason)}${d.message_count > 1 ? ' · ' + d.message_count + ' msgs' : ''}</div></div>`;
    }
    const m = e.m;
    const out = m.direction === 'outbound';
    const trace = !out ? byTrigger.get(String(m.id)) : null;
    return `<div class="ev ${out ? 'out' : ''}">
      <span class="ev-who">${out ? 'Commish' : esc(m.sender_phone || 'member')} · ${fmtTime(m.occurred_at)}${m.protocol ? ' · ' + esc(m.protocol) : ''}</span>
      <div class="ev-body">${esc(m.body)}</div>
      ${trace ? `<div class="trace">${esc(trace.layer)} → ${esc(trace.decision)} (${esc(trace.reason)})${trace.latency_ms != null ? ' · ' + trace.latency_ms + 'ms' : ''}</div>` : ''}
    </div>`;
  }).join('');
}

function renderDrafts(list) {
  const rows = [`<tr class="head"><td>League</td><td class="num">Wk</td><td>Status</td><td>Verifier</td><td class="num">Tokens</td><td>Commit</td><td>Created</td></tr>`];
  if (!list.length) rows.push('<tr><td colspan="7" class="dim">No recaps generated yet.</td></tr>');
  for (const d of list) {
    const issues = (d.verification?.issues || []);
    const errs = issues.filter(i => i.severity === 'error').length;
    const u = d.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0);
    rows.push(`<tr>
      <td>${esc(d.league_name)}</td>
      <td class="num">${d.week}</td>
      <td class="mono ${d.status === 'sent' ? 'tag-reply' : d.status === 'pending' ? 'warn' : 'dim'}">${esc(d.status)}</td>
      <td class="${errs ? 'warn' : 'dim'}">${errs ? errs + ' error' : issues.length ? issues.length + ' review' : 'clean'}</td>
      <td class="num dim">${tok || '—'}</td>
      <td class="mono dim">${d.prompt_sha ? esc(d.prompt_sha.slice(0, 7)) : '—'}</td>
      <td class="dim">${fmtTime(d.created_at)}</td>
    </tr>`);
  }
  $('drafts').querySelector('tbody').innerHTML = rows.join('');
}

// --- boot -------------------------------------------------------------------
// --------------------------------------------------------------- spark ----

/**
 * An hourly bar chart with a readable scale and an instant tooltip.
 *
 * Both charts had bars and nothing else: no axis, so you could not tell what
 * span they covered, and no y scale, so a tall bar could equally have been
 * three views or three hundred. The values were on the native title attribute,
 * which is the worst of both worlds — a second of delay before it appears, no
 * indication that hovering does anything, and invisible on a touch screen.
 *
 * The tooltip is a div positioned on mouseover. It follows the bar rather than
 * the cursor so it cannot cover the thing being read, and it is clamped inside
 * the chart so the first and last hours are not cut off by the edge.
 */
function renderSpark(host, points, { label, bad = false, fmtLabel } = {}) {
  host.classList.add('spark-wrap');
  host.innerHTML = '';
  const peak = Math.max(1, ...points.map(p => p.count));

  const peakTag = el2('div', 'spark-peak', String(peak));
  const chart = el2('div', 'spark');
  const tip = el2('div', 'spark-tip');
  tip.hidden = true;

  for (const p of points) {
    const bar = el2('div', 'bar' + (p.count === 0 ? ' empty' : (bad ? ' bad' : '')));
    bar.style.height = Math.max(3, Math.round((p.count / peak) * 100)) + '%';

    const at = new Date(p.hour);
    /*
     * Weekday AND hour, always.
     *
     * The hour alone is ambiguous over any window longer than a day, and both
     * of these are: 25 hours and 48 hours. The first and last bars of the
     * traffic chart both read "11 AM", which is precisely the question a
     * tooltip exists to answer. Matches the axis labels underneath, so the two
     * can be read against each other.
     */
    const text = `${fmtLabel ? fmtLabel(at) : at.toLocaleString([], { weekday: 'short', hour: 'numeric' })} · ` +
                 `${p.count} ${label}${p.count === 1 ? '' : 's'}`;

    const show = () => {
      tip.textContent = text;
      tip.hidden = false;
      // Measured after it is visible, because an element that is display:none
      // has no width and would clamp to zero every time.
      const w = tip.offsetWidth;
      const centre = bar.offsetLeft + bar.offsetWidth / 2 - w / 2;
      tip.style.left = Math.max(0, Math.min(centre, chart.offsetWidth - w)) + 'px';
      bar.classList.add('on');
    };
    bar.onmouseenter = show;
    bar.onmouseleave = () => { tip.hidden = true; bar.classList.remove('on'); };
    // Tap works too. A touch screen has no hover at all, and this board gets
    // opened on a phone precisely when something has gone wrong.
    bar.onclick = show;
    chart.appendChild(bar);
  }

  const first = new Date(points[0].hour);
  const mid = new Date(points[Math.floor(points.length / 2)].hour);
  const axis = el2('div', 'spark-axis');
  const stamp = d => d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  axis.append(el2('span', '', stamp(first)), el2('span', '', stamp(mid)), el2('span', '', 'now'));

  host.append(peakTag, chart, tip, axis);
}

function el2(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ------------------------------------------------------------- signups ----

function renderTiles(tiles) {
  const by = h => (tiles.find(t => t.hours === h) || {}).count ?? 0;
  $('sg-1').textContent  = by(1);
  $('sg-12').textContent = by(12);
  $('sg-24').textContent = by(24);
  const total = (tiles.find(t => t.hours === null) || {}).count ?? 0;
  $('sg-total').textContent = total + (total === 1 ? ' all time' : ' all time');
}

/**
 * Hourly bars, drawn with divs.
 *
 * Scaled to the busiest hour in the window rather than to a fixed ceiling, so
 * shape is readable at four views an hour and at four hundred. A zero hour
 * keeps a visible sliver — a column of nothing is indistinguishable from a
 * rendering bug, and "was it quiet or is this broken" is the exact question the
 * chart exists to stop you asking.
 */
function renderVisits(visits) {
  renderSpark($('visits'), visits, { label: 'view' });
  const total = visits.reduce((n, v) => n + v.views, 0);
  $('visits-sub').textContent = total
    ? `${total} views over ${visits.length} hours`
    : 'No page views recorded yet — counting started when this was deployed.';
}

function renderFunnel(stages) {
  const body = $('funnel').querySelector('tbody');
  body.innerHTML = '';
  // The biggest single drop, so the row that matters is marked rather than
  // left to be eyeballed against eight others.
  const worst = stages.reduce((a, b) => (b.dropped ?? -1) > (a?.dropped ?? -1) ? b : a, null);

  for (const st of stages) {
    const tr = document.createElement('tr');
    if (st.dropped && worst && st.key === worst.key) tr.className = 'worst';

    const label = document.createElement('td');
    label.textContent = st.label;
    if (st.note) {
      const n = document.createElement('span');
      n.className = 'muted small';
      n.textContent = ' · ' + st.note;
      label.appendChild(n);
    }

    const count = document.createElement('td');
    count.textContent = st.count;

    const rate = document.createElement('td');
    rate.textContent = st.rate === null ? '—' : st.rate + '%';

    const lost = document.createElement('td');
    lost.textContent = st.dropped ? '−' + st.dropped : '';
    if (st.dropped) lost.className = 'drop';

    tr.append(label, count, rate, lost);
    body.appendChild(tr);
  }
}

function renderTextFlow(t) {
  const box = $('textflow');
  box.innerHTML = '';
  const cards = [
    ['Came via a code', t.viaCode, 'picked a league on the site first'],
    ['Texted in cold', t.cold, 'no code — straight to the number'],
    ['Codes never texted', t.codesUnused, 'picked a league, never texted'],
    ['Opted out', t.optedOut, 'replied STOP'],
  ];
  for (const [label, value, sub] of cards) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<span class="stat-label"></span><span class="stat-value"></span><span class="stat-sub"></span>';
    el.querySelector('.stat-label').textContent = label;
    el.querySelector('.stat-value').textContent = value;
    el.querySelector('.stat-sub').textContent = sub;
    box.appendChild(el);
  }
}

/** Tabs. Nothing refetches — load() already has both halves in hand. */
function selectTab(name) {
  for (const t of ['signups', 'leagues', 'messages', 'errors']) {
    const on = t === name;
    $('tab-' + t).hidden = !on;
    const btn = $('tab-btn-' + t);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
  }
}

// ------------------------------------------------------------ messages ----

let CONVOS = [];
let OPEN_CHAT = null;

const when = iso => {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((now - d) / 86400000);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
};

function renderConvos(list) {
  CONVOS = list;
  const box = $('convos');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="muted small" style="padding:16px">No messages yet.</p>';
    return;
  }
  for (const c of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'convo' + (c.chatId === OPEN_CHAT ? ' on' : '');
    row.innerHTML =
      '<div class="convo-top"><span class="convo-title"></span><span class="convo-when"></span></div>' +
      '<div class="convo-prev"></div>';
    row.querySelector('.convo-title').textContent = c.title;
    row.querySelector('.convo-when').textContent = when(c.lastAt);
    // The direction marker matters more than it looks: "→" is the last word
    // being the bot's, which on a quiet thread is the difference between
    // waiting on a person and the bot having gone silent.
    row.querySelector('.convo-prev').textContent =
      (c.lastDirection === 'outbound' ? '→ ' : '') + (c.lastBody || '').slice(0, 90);
    row.onclick = () => openConvo(c.chatId);
    box.appendChild(row);
  }
}

async function openConvo(chatId) {
  OPEN_CHAT = chatId;
  renderConvos(CONVOS);                       // repaint the selection

  const meta = CONVOS.find(c => c.chatId === chatId);
  $('convo-head').textContent = meta
    ? meta.title + (meta.subtitle ? ' · ' + meta.subtitle : '') + ' · ' + meta.messages + ' messages'
    : chatId;

  const pane = $('convo-thread');
  pane.innerHTML = '<p class="muted small" style="padding:16px">Loading…</p>';
  const { messages } = await api('GET', '/api/admin/thread?chatId=' + encodeURIComponent(chatId));

  pane.innerHTML = '';
  let lastSender = null;
  for (const m of messages) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-row ' + m.direction;

    // In a group, who said it is the point. Only shown when the speaker
    // changes, the way a chat app does it — repeating it on every bubble turns
    // a conversation into a log.
    if (m.is_group && m.direction === 'inbound' && m.sender_phone !== lastSender) {
      const who = document.createElement('span');
      who.className = 'bubble-who';
      who.textContent = m.sender_phone || 'unknown';
      wrap.appendChild(who);
    }
    lastSender = m.sender_phone;

    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.body || '';
    b.title = new Date(m.occurred_at).toLocaleString() + (m.protocol ? ' · ' + m.protocol : '');
    wrap.appendChild(b);
    pane.appendChild(wrap);
  }
  // Newest at the bottom and opened scrolled to it, which is where a chat app
  // leaves you and where the interesting message is.
  pane.scrollTop = pane.scrollHeight;
}

// ----------------------------------------------------------------- ops ----

/*
 * The alert strip.
 *
 * Rendered only when something needs doing. A permanent "all systems green"
 * panel becomes wallpaper inside a week and stops being read, which makes it
 * worse than nothing — it occupies the place your eye goes looking for trouble
 * and reports none.
 */
const OPT_OUT_WARN = 1.0;   // percent. Carriers act somewhere above this.

function renderOps(ops) {
  const alerts = [];

  if (ops.delivery.failed > 0) {
    // First, always. A send that did not arrive is the failure that makes every
    // other number on this page a lie.
    alerts.push({
      level: 'bad',
      text: `${ops.delivery.failed} send${ops.delivery.failed === 1 ? '' : 's'} failed in the last ${ops.days} days` +
            (ops.delivery.lastError ? ` — latest: ${ops.delivery.lastError}` : ''),
    });
  }
  if (ops.optOut.rate !== null && ops.optOut.rate >= OPT_OUT_WARN) {
    alerts.push({
      level: 'bad',
      text: `Opt-out rate is ${ops.optOut.rate}% (${ops.optOut.count} of ${ops.optOut.reachable}). Carriers act on this.`,
    });
  }
  const stale = ops.leagues.filter(l => l.daysQuiet !== null && l.daysQuiet >= 14);
  if (stale.length) {
    alerts.push({
      level: 'warn',
      text: `${stale.length} live league${stale.length === 1 ? '' : 's'} ` +
            `${stale.length === 1 ? 'has' : 'have'} not addressed the bot in two weeks.`,
    });
  }

  const box = $('alerts');
  box.hidden = !alerts.length;
  box.innerHTML = '';
  for (const a of alerts) {
    const el = document.createElement('div');
    el.className = 'alert ' + a.level;
    el.textContent = a.text;
    box.appendChild(el);
  }

  const cards = [
    ['Failed sends', ops.delivery.failed,
      ops.delivery.failureRate === null ? 'nothing sent yet' : ops.delivery.failureRate + '% of attempts'],
    ['Opt-out rate', ops.optOut.rate === null ? '—' : ops.optOut.rate + '%',
      `${ops.optOut.count} of ${ops.optOut.reachable} reachable`],
    ['Tokens', (ops.cost.inputTokens + ops.cost.outputTokens).toLocaleString(),
      ops.cost.perLeague === null ? 'no model calls yet' : ops.cost.perLeague.toLocaleString() + ' per league'],
  ];
  const health = $('ops-health');
  health.innerHTML = '';
  for (const [label, value, sub] of cards) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<span class="stat-label"></span><span class="stat-value"></span><span class="stat-sub"></span>';
    el.querySelector('.stat-label').textContent = label;
    el.querySelector('.stat-value').textContent = value;
    el.querySelector('.stat-sub').textContent = sub;
    health.appendChild(el);
  }

  const body = $('quiet').querySelector('tbody');
  if (!ops.leagues.length) {
    body.innerHTML = '<tr><td class="dim">No live leagues yet.</td></tr>';
    return;
  }
  const rows = [`<tr class="head"><td>League</td><td class="num">People talking</td><td class="num">Days quiet</td></tr>`];
  for (const l of ops.leagues) {
    // Never spoken to at all is worse than quiet for a fortnight, and sorts
    // first from the query — it is a league that was set up and abandoned.
    const never = l.daysQuiet === null;
    const bad = never || l.daysQuiet >= 14;
    rows.push(`<tr>
      <td>${esc(l.name)}</td>
      <td class="num ${l.humans ? '' : 'warn'}">${l.humans}</td>
      <td class="num ${bad ? 'warn' : 'dim'}">${never ? 'never' : l.daysQuiet}</td>
    </tr>`);
  }
  body.innerHTML = rows.join('');
}

// -------------------------------------------------------------- errors ----

const SYSTEM_LABEL = {
  web: 'Our API', sendblue: 'Sendblue', anthropic: 'Model',
  sleeper: 'Sleeper', worker: 'Scheduled jobs', db: 'Database',
};

function renderErrors(e) {
  // Short windows first — the question on opening this tab is "is something
  // wrong right NOW", and a seven day total cannot answer it.
  const w = $('err-windows');
  w.innerHTML = '';
  const cards = e.windows.client.map(c => [
    `4xx, last ${c.hours}h`, c.count,
    c.hours === 4 ? 'client errors' : 'rolling window',
  ]);
  const server24 = e.windows.server.find(x => x.hours === 24);
  cards.push(['5xx, last 24h', server24.count, server24.count ? 'ours — look at these' : 'nothing fell over']);

  for (const [label, value, sub] of cards) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<span class="stat-label"></span><span class="stat-value"></span><span class="stat-sub"></span>';
    el.querySelector('.stat-label').textContent = label;
    el.querySelector('.stat-value').textContent = value;
    // A 5xx is categorically worse than a 4xx and should not have to be
    // noticed by reading the label.
    if (label.startsWith('5xx') && value > 0) el.querySelector('.stat-value').classList.add('warn');
    el.querySelector('.stat-sub').textContent = sub;
    w.appendChild(el);
  }

  // Grouped by system for the tiles. A status breakdown belongs in the table
  // below — four tiles that all say "web" would be four ways of saying one
  // thing.
  const bySystem = {};
  for (const r of e.bySystem) bySystem[r.system] = (bySystem[r.system] || 0) + r.count;

  const tiles = $('err-tiles');
  tiles.innerHTML = '';
  const systems = Object.entries(bySystem).sort((a, b) => b[1] - a[1]);
  if (!systems.length) {
    tiles.innerHTML = `<div class="stat"><span class="stat-label">Errors</span>` +
      `<span class="stat-value">0</span><span class="stat-sub">last ${e.days} days</span></div>`;
  }
  for (const [sys, n] of systems) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<span class="stat-label"></span><span class="stat-value"></span><span class="stat-sub"></span>';
    el.querySelector('.stat-label').textContent = SYSTEM_LABEL[sys] || sys;
    el.querySelector('.stat-value').textContent = n;
    el.querySelector('.stat-sub').textContent = `last ${e.days} days`;
    tiles.appendChild(el);
  }

  renderSpark($('err-spark'), e.series, { label: 'error', bad: true });
  $('err-spark-sub').textContent = e.total
    ? `${e.total} in ${e.days} days`
    : 'Nothing has failed since this started recording.';

  const ops = $('err-ops').querySelector('tbody');
  if (!e.byOperation.length) {
    ops.innerHTML = '<tr><td class="dim">Nothing to report.</td></tr>';
  } else {
    const rows = ['<tr class="head"><td>System</td><td>Operation</td><td class="num">Status</td><td class="num">Count</td><td>Latest message</td></tr>'];
    for (const r of e.byOperation) {
      rows.push(`<tr>
        <td class="mono">${esc(SYSTEM_LABEL[r.system] || r.system)}</td>
        <td class="mono dim">${esc(r.operation || '—')}</td>
        <td class="num ${r.status >= 500 ? 'warn' : ''}">${r.status ?? '—'}</td>
        <td class="num">${r.count}</td>
        <td class="dim" style="max-width:380px">${esc(String(r.lastMessage || '').slice(0, 140))}</td>
      </tr>`);
    }
    ops.innerHTML = rows.join('');
  }

  const recent = $('err-recent').querySelector('tbody');
  if (!e.recent.length) {
    recent.innerHTML = '<tr><td class="dim">Nothing yet.</td></tr>';
    return;
  }
  const rows = ['<tr class="head"><td>When</td><td>System</td><td class="num">Status</td><td>Message</td></tr>'];
  for (const r of e.recent) {
    rows.push(`<tr>
      <td class="dim">${fmtTime(r.at)}</td>
      <td class="mono">${esc(SYSTEM_LABEL[r.system] || r.system)}</td>
      <td class="num ${r.status >= 500 ? 'warn' : ''}">${r.status ?? '—'}</td>
      <td>${esc(String(r.message || '').slice(0, 180))}</td>
    </tr>`);
  }
  recent.innerHTML = rows.join('');
}

async function load() {
  const [overview, { leagues }, { drafts }, funnel, { conversations }, ops, errs] = await Promise.all([
    api('GET', '/api/admin/overview?days=30'),
    api('GET', '/api/admin/leagues'),
    api('GET', '/api/admin/drafts?limit=25'),
    api('GET', '/api/admin/funnel?hours=24'),
    api('GET', '/api/admin/threads'),
    api('GET', '/api/admin/ops?days=7'),
    api('GET', '/api/admin/errors?days=7'),
  ]);
  renderOverview(overview);
  renderLeagues(leagues);
  renderDrafts(drafts);

  renderTiles(funnel.tiles);
  renderVisits(funnel.visits.map(v => ({ hour: v.hour, count: v.views, views: v.views })));
  renderFunnel(funnel.funnel);
  renderTextFlow(funnel.textFlow);
  renderConvos(conversations);
  renderOps(ops);
  renderErrors(errs);
}

async function boot() {
  // No /api/config fetch and no Supabase keys: this page never talks to
  // Supabase directly any more, the server does the sending.
  captureTokenFromHash();
  show('signin', false); show('denied', false); show('board', false);

  if (!token()) { show('signin', true); return; }
  try {
    await load();
    show('board', true);
  } catch (err) {
    // 404 is what a signed-in non-operator gets, deliberately: it does not
    // confirm the route exists.
    if (err.status === 404) show('denied', true);
    else { show('signin', true); $('signin-msg').textContent = 'Could not load: ' + err.message; }
  }
}

$('send-link').onclick = sendLink;
$('tab-btn-signups').onclick = () => selectTab('signups');
$('tab-btn-leagues').onclick = () => selectTab('leagues');
$('tab-btn-messages').onclick = () => selectTab('messages');
$('tab-btn-errors').onclick = () => selectTab('errors');
$('lg-filter').oninput = () => renderLeagues();
$('lg-state').onchange = () => renderLeagues();
boot();

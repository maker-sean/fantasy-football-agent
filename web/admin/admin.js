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

function renderLeagues(list) {
  LEAGUES = list;
  const live = list.filter(l => l.onboarding_state === 'live').length;
  $('live-count').textContent = live;
  $('live-sub').textContent = `${list.length} onboarded`;

  const rows = [`<tr class="head"><td>League</td><td>State</td><td class="num">Bound</td><td class="num">Msgs</td><td class="num">Pending</td><td>Last activity</td></tr>`];
  for (const l of list) {
    // Partial binding is the failure that degrades everything quietly: the
    // recap says "Roster 7" and the gate refuses to answer strangers.
    const partial = l.total_members > 0 && l.bound_members < l.total_members;
    rows.push(`<tr class="click" data-league="${esc(l.id)}">
      <td>${esc(l.name)}<div class="dim mono" style="font-size:.72rem">${esc(l.provider)} · ${esc(l.season || '')}</div></td>
      <td class="mono ${l.onboarding_state === 'live' ? 'tag-reply' : 'warn'}">${esc(l.onboarding_state)}</td>
      <td class="num ${partial ? 'warn' : ''}">${l.bound_members}/${l.total_members}</td>
      <td class="num">${l.messages}</td>
      <td class="num ${l.pending_drafts ? 'warn' : 'dim'}">${l.pending_drafts || '—'}</td>
      <td class="dim">${l.last_message_at ? fmtTime(l.last_message_at) : '—'}</td>
    </tr>`);
  }
  const tbody = $('leagues').querySelector('tbody');
  tbody.innerHTML = rows.join('');
  tbody.querySelectorAll('tr.click').forEach(tr =>
    tr.onclick = () => openThread(tr.dataset.league));
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
async function load() {
  const [overview, { leagues }, { drafts }] = await Promise.all([
    api('GET', '/api/admin/overview?days=30'),
    api('GET', '/api/admin/leagues'),
    api('GET', '/api/admin/drafts?limit=25'),
  ]);
  renderOverview(overview);
  renderLeagues(leagues);
  renderDrafts(drafts);
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
boot();

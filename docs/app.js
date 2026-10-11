'use strict';

const APP_VERSION = 'v2.3';

// ---------- storage ----------

const KEYS = {
  settings: 'hl.settings', config: 'hl.config', queue: 'hl.queue',
  cache: 'hl.cache', account: 'hl.account', counts: 'hl.counts', words: 'hl.words',
};
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
  },
};

// ---------- state ----------

const state = {
  settings: store.get(KEYS.settings, null), // { url, key, name, role }
  config: store.get(KEYS.config, { categories: [], fixed: [] }),
  account: store.get(KEYS.account, 'mom'),
  month: thisMonth(),
  cache: store.get(KEYS.cache, {}), // month -> { carry: { team, dad }, entries }
  queue: store.get(KEYS.queue, []), // entries not yet saved to the sheet
  syncing: false,
  lastError: '',
  members: null,
  lastInvite: null,
  momRange: 1,
  pending: null, // Dad's chat message waiting for a category
  chatText: '',
};
let draft = null;
let showAllCats = false;
const loadedAt = {}; // month -> when it was last fetched from the sheet

const role = () => state.settings?.role || 'admin';
const isTeam = () => ['admin', 'team'].includes(role());
const potFor = r => (['admin', 'team'].includes(r) ? 'team' : r);
const SAVINGS = 'Savings and insurance';

// ---------- helpers ----------

function thisMonth() { return today().slice(0, 7); }
function today() { return new Date().toLocaleDateString('en-CA'); }
function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const opts = v % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 };
  return '₹' + Math.abs(v).toLocaleString('en-IN', opts);
}
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dayLabel(date) {
  if (date === today()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date === y.toLocaleDateString('en-CA')) return 'Yesterday';
  const [yy, mm, dd] = date.split('-').map(Number);
  return new Date(yy, mm - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function defaultDateFor(month) {
  return month === thisMonth() ? today() : `${month}-01`;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}
function go(hash) { location.hash = hash; }
function params() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}
function label(e) {
  return e.sub ? `${e.category} · ${e.sub}` : e.category;
}
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast("Couldn't copy. Press and hold to copy."); }
}

// ---------- data ----------

async function api(action, payload = {}, settings = state.settings) {
  const res = await fetch(settings.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: settings.key, action, ...payload }),
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function monthData(m) {
  const d = state.cache[m] || { carry: {}, entries: [] };
  if (typeof d.carry === 'number') d.carry = { team: d.carry }; // v1 cache
  return d;
}

function findEntry(id) {
  for (const m of Object.keys(state.cache)) {
    const e = state.cache[m].entries.find(x => x.id === id);
    if (e) return e;
  }
  return state.queue.find(x => x.id === id) || null;
}

function sortEntries(list) {
  return list.sort((a, b) => (b.date + (b.created_at || '')).localeCompare(a.date + (a.created_at || '')));
}

/** Put an entry into the local cache (removing it from any other month) and queue it for the sheet. */
function saveEntry(entry) {
  const e = {
    ...entry,
    pot: entry.account === 'mom' ? (entry.pot || potFor(role())) : '',
    logged_by: entry.logged_by || state.settings.name,
    created_at: entry.created_at || new Date().toISOString(),
    _v: newId(),
  };
  for (const m of Object.keys(state.cache)) {
    state.cache[m].entries = state.cache[m].entries.filter(x => x.id !== e.id);
  }
  if (!e.deleted) {
    const m = e.date.slice(0, 7);
    state.cache[m] = monthData(m);
    state.cache[m].entries.push(e);
    sortEntries(state.cache[m].entries);
  }
  state.queue = state.queue.filter(x => x.id !== e.id).concat(e);
  store.set(KEYS.cache, state.cache);
  store.set(KEYS.queue, state.queue);
  flush();
}

async function flush() {
  if (state.syncing || !state.queue.length || !state.settings) return;
  state.syncing = true;
  renderSync();
  const batch = state.queue.slice(0, 50);
  let ok = false;
  try {
    await api('save', { entries: batch.map(({ _v, pot, logged_by, ...rest }) => rest) });
    const sent = new Map(batch.map(e => [e.id, e._v]));
    state.queue = state.queue.filter(e => sent.get(e.id) !== e._v); // keep anything edited mid-flight
    store.set(KEYS.queue, state.queue);
    state.lastError = '';
    ok = true;
  } catch (err) {
    state.lastError = navigator.onLine ? err.message : '';
    if (/own entries|Not allowed/.test(err.message)) {
      // The sheet refused these for good; drop them so the queue doesn't stay stuck.
      const bad = new Set(batch.map(e => e.id));
      state.queue = state.queue.filter(e => !bad.has(e.id));
      store.set(KEYS.queue, state.queue);
    }
    if (err.message === 'Invalid key') disconnected();
  } finally {
    state.syncing = false;
    renderSync();
  }
  if (ok && state.queue.length) flush();
  else if (ok) loadMonth(state.month, true);
}

async function loadMonth(m, quiet = false) {
  if (!state.settings) return;
  try {
    const data = await api('list', { month: m });
    const pendingIds = new Set(state.queue.map(e => e.id));
    const pending = state.queue.filter(e => e.date.slice(0, 7) === m && !e.deleted);
    state.cache[m] = { carry: data.carry || {}, entries: sortEntries(data.entries.filter(e => !pendingIds.has(e.id)).concat(pending)) };
    store.set(KEYS.cache, state.cache);
    loadedAt[m] = Date.now();
    state.lastError = '';
    if (state.month === m || (role() === 'mom' && state.momRange > 1)) render();
  } catch (err) {
    state.lastError = navigator.onLine ? err.message : '';
    if (err.message === 'Invalid key') disconnected();
    if (!quiet) renderSync();
  }
}

async function loadConfig() {
  try {
    const data = await api('config');
    state.config = data.config;
    state.settings = { ...state.settings, name: data.user, role: data.role };
    store.set(KEYS.config, state.config);
    store.set(KEYS.settings, state.settings);
    render();
  } catch (err) {
    if (err.message === 'Invalid key') disconnected();
  }
}

function disconnected() {
  state.lastError = 'This phone was disconnected. Ask Hari for a new invite.';
  renderSync();
}

/** Balance of one handler's kanaku in Mom's account for a month. */
function potSummary(pot, m) {
  const d = monthData(m);
  const list = d.entries.filter(e => e.account === 'mom' && (e.pot || 'team') === pot);
  const sum = f => list.filter(f).reduce((s, e) => s + Number(e.amount), 0);
  const received = sum(e => e.type === 'in');
  const spent = sum(e => e.type === 'out' && !e.paid_by_me);
  const covered = sum(e => e.type === 'out' && e.paid_by_me);
  const carry = d.carry[pot] || 0;
  return { received, spent, covered, carry, left: carry + received - spent, count: list.length };
}

function usSummary(m) {
  const d = monthData(m);
  const us = d.entries.filter(e => e.account === 'us');
  const sum = f => us.filter(f).reduce((s, e) => s + Number(e.amount), 0);
  const received = sum(e => e.type === 'in');
  const saved = sum(e => e.type === 'out' && e.category === SAVINGS);
  const spent = sum(e => e.type === 'out' && e.category !== SAVINGS);
  const forHouse = d.entries.filter(e => e.account === 'mom' && e.paid_by_me).reduce((s, e) => s + Number(e.amount), 0);
  return { received, saved, spent, forHouse, left: received - saved - spent - forHouse, count: us.length };
}

function categories(account, type) {
  return state.config.categories.filter(c => c.account === account && c.type === type)
    .filter(c => !(role() === 'dad' && c.name === 'From Dad'));
}
function catInfo(account, type, name) {
  return categories(account, type).find(c => c.name === name);
}

function fixedFor(account, m) {
  const mo = Number(m.slice(5));
  return state.config.fixed.filter(f => f.account === account)
    .filter(f => f.months !== 'odd' || mo % 2 === 1)
    .filter(f => f.months !== 'even' || mo % 2 === 0);
}

/** Same id on every phone for a given fixed payment and month, so two phones marking it paid make one entry. */
function fixedId(f, m) {
  let slug = f.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!slug) slug = [...f.name].reduce((h, c) => ((h * 31 + c.codePointAt(0)) >>> 0), 7).toString(36);
  return `fx-${f.account}-${m}-${slug}`;
}

function fixedEntry(f, m) {
  const list = monthData(m).entries.filter(e => e.account === f.account && e.type === 'out');
  return list.find(e => e.id === fixedId(f, m))
    || list.find(e => e.category === f.category && (!f.sub || e.sub === f.sub))
    || list.find(e => e.category === f.name); // entries logged before the v2 categories
}

function balanceLine(left, whoOwes) {
  return left < 0 ? `${whoOwes} ${money(left)}` : `${money(left)} left`;
}

// ---------- views: joining ----------

function viewJoin() {
  const p = params();
  return `
    <div class="bar"><h1>Join Kutti Krishna House</h1></div>
    <div class="card">
      <p class="label">Joining as</p>
      <p style="margin:0;font-size:24px;font-weight:600">${esc(p.n || '')}</p>
    </div>
    <p class="label">Enter the 6-digit code Hari gave you on the phone call.</p>
    <input id="code" class="text-input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="6-digit code">
    <p class="err" id="err"></p>
    <button class="btn btn-primary" id="join">Join</button>`;
}

function bindJoin() {
  const p = params();
  const codeEl = document.getElementById('code');
  codeEl.oninput = () => { codeEl.value = codeEl.value.replace(/\D/g, '').slice(0, 6); document.getElementById('err').textContent = ''; };
  codeEl.focus();
  document.getElementById('join').onclick = async () => {
    const err = document.getElementById('err');
    const code = codeEl.value;
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(p.u || '') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(p.u || '')) {
      err.textContent = "This invite link is broken. Ask Hari to send it again."; return;
    }
    if (code.length !== 6) { err.textContent = 'Enter all 6 digits.'; return; }
    if (state.settings && !confirm(`This phone is set up for ${state.settings.name}. Switch to ${p.n}?`)) return;
    err.textContent = 'Joining…';
    try {
      const data = await api('join', { name: p.n, code }, { url: p.u, key: '' });
      Object.values(KEYS).forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
      state.settings = { url: p.u, key: data.key, name: data.user, role: data.role };
      state.config = data.config;
      state.cache = {}; state.queue = [];
      state.account = 'mom';
      store.set(KEYS.settings, state.settings);
      store.set(KEYS.config, state.config);
      toast(`Welcome, ${data.user}`);
      location.replace(location.pathname + '#/home');
      render();
      loadMonth(state.month);
    } catch (e) {
      err.textContent = /Failed to fetch|NetworkError/.test(e.message) ? "Couldn't connect. Check your internet." : e.message;
    }
  };
}

function viewSetup() {
  return `
    <div class="bar"><h1>Kutti Krishna House</h1></div>
    <div class="card">
      <p style="margin:0 0 6px;font-size:18px;font-weight:600">Open your invite link</p>
      <p class="label">Hari will send you a link on WhatsApp and tell you a 6-digit code on a call. Open the link on this phone to join.</p>
    </div>
    <details>
      <summary class="label" style="padding:12px 0">I have a key instead</summary>
      <label class="label" for="url">Web app URL</label>
      <input id="url" class="text-input" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec">
      <label class="label" for="key" style="display:block;margin-top:10px">Your key</label>
      <input id="key" class="text-input" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="err" id="err"></p>
      <button class="btn btn-outline" id="connect">Connect</button>
    </details>`;
}

function bindSetup() {
  document.getElementById('connect').onclick = async () => {
    const url = document.getElementById('url').value.trim();
    const key = document.getElementById('key').value.trim();
    const err = document.getElementById('err');
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
      err.textContent = 'That URL should start with https://script.google.com and end with /exec.'; return;
    }
    err.textContent = 'Connecting…';
    try {
      const data = await api('config', {}, { url, key });
      state.settings = { url, key, name: data.user, role: data.role };
      state.config = data.config;
      store.set(KEYS.settings, state.settings);
      store.set(KEYS.config, state.config);
      toast(`Connected as ${data.user}`);
      go('#/home');
      loadMonth(state.month);
    } catch (e) {
      err.textContent = e.message === 'Invalid key' ? "That key isn't valid." : "Couldn't connect. Check the URL and your internet.";
    }
  };
}

// ---------- views: shared pieces ----------

function accountSwitch() {
  if (!isTeam()) return '';
  return `<div class="seg" role="group" aria-label="Account">
    <button data-account="mom" aria-pressed="${state.account === 'mom'}">Mom</button>
    <button data-account="us" aria-pressed="${state.account === 'us'}">Us</button>
  </div>`;
}

function monthNav() {
  const atNow = state.month >= thisMonth();
  return `<div class="month-nav">
    <button class="icon-btn" data-month="-1" aria-label="Previous month">‹</button>
    <strong>${monthLabel(state.month)}</strong>
    <button class="icon-btn" data-month="1" aria-label="Next month" ${atNow ? 'style="visibility:hidden"' : ''}>›</button>
  </div>`;
}

function syncLine() {
  const n = state.queue.length;
  if (state.lastError) return `<p class="sync pending" id="sync">${esc(state.lastError)}${n ? ` · ${n} waiting` : ''}</p>`;
  if (state.syncing) return `<p class="sync" id="sync">Saving…</p>`;
  if (n) return `<p class="sync pending" id="sync">${n} waiting · will save when online</p>`;
  return `<p class="sync" id="sync">✓ Saved</p>`;
}

function topBar(title) {
  return `<div class="bar"><h1>${title}</h1><button class="icon-btn" data-go="#/settings" aria-label="Settings">⚙︎</button></div>`;
}

// ---------- views: team home ----------

function viewHome() {
  if (role() === 'mom') return viewMomHome();
  if (role() === 'dad') return viewDadHome();
  const m = state.month;
  let card;
  if (state.account === 'mom') {
    const s = potSummary('team', m);
    const dad = potSummary('dad', m);
    const pool = s.carry + s.received;
    const pct = pool > 0 ? Math.min(100, Math.round((s.spent / pool) * 100)) : (s.spent ? 100 : 0);
    const owed = s.left < 0;
    card = `<div class="card">
      <p class="label">${owed ? 'Mom owes you' : "Left from Mom's money"}</p>
      <p class="big-num ${owed ? 'neg' : ''}">${money(s.left)}</p>
      <div class="meter ${owed ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <p class="label">${s.carry ? `Brought forward ${s.carry < 0 ? '−' : ''}${money(s.carry)} · ` : ''}In ${money(s.received)} · Spent ${money(s.spent)}</p>
      ${s.covered ? `<p class="note-good">You covered ${money(s.covered)} for the house</p>` : ''}
      ${dad.count ? `<p class="label" style="margin-top:8px">Appa spent ${money(dad.spent)} · ${dad.left < 0 ? `Mom owes him ${money(dad.left)}` : `${money(dad.left)} with him`}</p>` : ''}
    </div>`;
  } else {
    const s = usSummary(m);
    card = `<div class="card">
      <p class="label">Spent this month</p>
      <p class="big-num">${money(s.spent)}</p>
      <p class="label">In ${money(s.received)} · Saved ${money(s.saved)}${s.forHouse ? ` · Mom's house ${money(s.forHouse)}` : ''}</p>
      <p class="label" style="margin-top:4px">${s.left >= 0 ? 'Left' : 'Over by'} ${money(s.left)}</p>
    </div>`;
  }
  const fixed = fixedFor(state.account, m);
  const fixedDone = fixed.filter(f => fixedEntry(f, m)).length;
  const count = monthData(m).entries.filter(e => e.account === state.account).length;
  return `
    ${topBar('Kutti Krishna House')}
    ${accountSwitch()}
    ${monthNav()}
    ${card}
    <button class="btn btn-primary" data-go="#/add?type=out">＋ Add expense</button>
    <button class="btn btn-outline" data-go="#/add?type=in">↙ Money received</button>
    <div class="grid2">
      <button class="tile" data-go="#/fixed"><span>Fixed</span><small>${fixedDone} of ${fixed.length} paid</small></button>
      <button class="tile" data-go="#/list"><span>This month</span><small>${count} entries</small></button>
    </div>
    ${syncLine()}`;
}

// ---------- views: Mom ----------

function momMonths() {
  const out = [];
  for (let i = 0; i < state.momRange; i++) out.push(shiftMonth(state.month, -i));
  return out;
}

function viewMomHome() {
  const months = momMonths();
  const totals = {};
  months.forEach(m => monthData(m).entries
    .filter(e => e.account === 'mom' && e.type === 'out')
    .forEach(e => { totals[e.category] = (totals[e.category] || 0) + Number(e.amount); }));
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, r) => s + r[1], 0);
  const team = potSummary('team', state.month);
  const dad = potSummary('dad', state.month);
  const hint = n => catInfo('mom', 'out', n)?.hint || '';
  return `
    ${topBar('Kutti Krishna House')}
    ${monthNav()}
    <div class="row-chips" role="group" aria-label="Period">
      <button class="chip" data-range="1" aria-pressed="${state.momRange === 1}">This month</button>
      <button class="chip" data-range="3" aria-pressed="${state.momRange === 3}">Last 3 months</button>
    </div>
    <div class="card">
      <p class="label">What we pay for</p>
      <div class="list">
        ${rows.map(([n, v]) => `<button class="item" data-cat="${esc(n)}"><span class="grow"><span class="title">${esc(n)}</span>${hint(n) ? `<span class="sub">${esc(hint(n))}</span>` : ''}</span><span class="amt">${money(v)}</span></button>`).join('') || '<p class="empty-state">Nothing logged yet.</p>'}
      </div>
      ${rows.length ? `<div class="item" style="border:0"><span class="grow"><strong>Total</strong></span><strong>${money(total)}</strong></div>` : ''}
    </div>
    <div class="card">
      <p class="label">Hari and Harini</p>
      <p style="margin:2px 0 10px;font-size:18px;font-weight:600">${team.left < 0 ? `You owe them ${money(team.left)}` : `${money(team.left)} left with them`}</p>
      <p class="label">Appa</p>
      <p style="margin:2px 0 0;font-size:18px;font-weight:600">${dad.left < 0 ? `You owe him ${money(dad.left)}` : `${money(dad.left)} with him`}</p>
    </div>
    <button class="btn btn-outline" data-go="#/add?type=out">＋ Add expense</button>
    ${syncLine()}`;
}

function bindMomHome() {
  document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    state.momRange = Number(b.dataset.range);
    momMonths().forEach(m => { if (!state.cache[m] || m === state.month) loadMonth(m, true); });
    render();
  });
  document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => go(`#/list?cat=${encodeURIComponent(b.dataset.cat)}`));
}

// ---------- views: Dad ----------

function parseChat(text) {
  const nums = [...text.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)];
  if (!nums.length) return null;
  const last = nums[nums.length - 1];
  const amount = Number(last[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  const note = (text.slice(0, last.index) + text.slice(last.index + last[0].length))
    .replace(/(₹|\brs\.?|\brupees?\b|\/-)/gi, ' ').replace(/\s+/g, ' ').trim();
  return { amount, note };
}

function suggestFor(note) {
  const w = (note.split(' ')[0] || '').toLowerCase();
  return store.get(KEYS.words, {})[w] || '';
}

function viewDadHome() {
  const m = state.month;
  const s = potSummary('dad', m);
  const mine = monthData(m).entries.filter(e => e.account === 'mom' && e.pot === 'dad')
    .slice().sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at));
  const bubbles = mine.map(e => `
    <button class="bubble ${e.type === 'in' ? 'in' : ''}" data-edit="${esc(e.id)}">
      <span>${esc(e.note || e.category)} <strong>${e.type === 'in' ? '+' : ''}${money(e.amount)}</strong></span>
      <small>${esc(e.type === 'in' ? 'From Amma' : e.category)} · ${dayLabel(e.date)}${state.queue.some(q => q.id === e.id) ? ' · waiting' : ''}</small>
    </button>`).join('');
  let pending = '';
  if (state.pending) {
    const cats = categories('mom', 'out');
    const sug = suggestFor(state.pending.note);
    const ordered = [...cats.filter(c => c.name === sug), ...cats.filter(c => c.name !== sug && c.top), ...cats.filter(c => c.name !== sug && !c.top)];
    const shown = showAllCats ? ordered : ordered.slice(0, 6);
    pending = `
      <div class="bubble pending"><span>${esc(state.pending.note || 'Expense')} <strong>${money(state.pending.amount)}</strong></span><small>Pick a category</small></div>
      <div class="grid3">
        ${shown.map(c => `<button class="tile" data-chat-cat="${esc(c.name)}" ${c.name === sug ? 'aria-pressed="true"' : ''}>${esc(c.name)}</button>`).join('')}
        ${!showAllCats ? `<button class="tile" data-more><span>More</span></button>` : ''}
      </div>
      <button class="btn btn-danger" data-cancel>Cancel</button>`;
  }
  return `
    ${topBar('Kanaku')}
    ${monthNav()}
    <div class="stats">
      <div class="stat"><span class="label">Spent</span><strong>${money(s.spent)}</strong></div>
      <div class="stat"><span class="label">${s.left < 0 ? 'Amma owes you' : 'With you'}</span><strong>${money(s.left)}</strong></div>
    </div>
    <div class="chat">${bubbles || (state.pending ? '' : '<p class="empty-state">Type what you spent below, like <strong>milk 60</strong>.</p>')}${pending}</div>
    <div class="chat-input">
      <div class="row-chips">
        <button class="chip" data-go="#/add?type=out">Form</button>
        <button class="chip" data-go="#/add?type=in&cat=From%20Mom">Money from Amma</button>
        <button class="chip" id="send-kanaku">Send kanaku to Amma</button>
      </div>
      <p class="err" id="err"></p>
      <div style="display:flex;gap:8px">
        <input id="chat" class="text-input" placeholder="vegetables 450" autocomplete="off" enterkeyhint="send" value="${esc(state.chatText)}" ${state.pending ? 'disabled' : ''}>
        <button class="btn btn-primary send-btn" id="send" aria-label="Send" ${state.pending ? 'disabled' : ''}>➤</button>
      </div>
      ${syncLine()}
    </div>`;
}

function bindDadHome() {
  const input = document.getElementById('chat');
  const err = document.getElementById('err');
  const send = () => {
    const parsed = parseChat(input.value);
    if (!parsed) { err.textContent = 'Add the amount, like: milk 60'; return; }
    state.pending = parsed;
    state.chatText = '';
    showAllCats = false;
    render();
    window.scrollTo(0, document.body.scrollHeight);
  };
  if (input) {
    input.onkeydown = e => { if (e.key === 'Enter') send(); };
    input.oninput = () => { err.textContent = ''; state.chatText = input.value; };
  }
  document.getElementById('send').onclick = send;
  document.querySelectorAll('[data-chat-cat]').forEach(b => b.onclick = () => {
    const cat = b.dataset.chatCat;
    const p = state.pending;
    saveEntry({ id: newId(), date: defaultDateFor(state.month), account: 'mom', type: 'out', amount: p.amount,
      category: cat, sub: '', note: p.note, mode: 'cash', paid_by_me: false, private: false });
    const w = (p.note.split(' ')[0] || '').toLowerCase();
    if (w) { const words = store.get(KEYS.words, {}); words[w] = cat; store.set(KEYS.words, words); }
    state.pending = null;
    toast(`Saved · ${cat}`);
    render();
    document.getElementById('chat')?.focus();
  });
  const more = document.querySelector('[data-more]');
  if (more) more.onclick = () => { showAllCats = true; render(); };
  const cancel = document.querySelector('[data-cancel]');
  if (cancel) cancel.onclick = () => { state.pending = null; render(); };
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => go(`#/add?id=${encodeURIComponent(b.dataset.edit)}`));
  document.getElementById('send-kanaku').onclick = () => shareText(kanakuText(state.month));
}

function kanakuText(m) {
  const s = potSummary('dad', m);
  const list = monthData(m).entries.filter(e => e.account === 'mom' && e.pot === 'dad')
    .slice().sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at));
  const day = d => { const [y, mo, dd] = d.split('-').map(Number); return new Date(y, mo - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
  const lines = list.map(e => `${day(e.date)} · ${e.note || e.category} · ${e.type === 'in' ? '+' : ''}${money(e.amount)}`);
  return [
    `Kanaku – ${monthLabel(m)}`,
    '',
    ...lines,
    '',
    `Spent: ${money(s.spent)}`,
    `Received from you: ${money(s.received)}`,
    s.carry ? `Brought forward: ${s.carry < 0 ? '−' : ''}${money(s.carry)}` : null,
    s.left < 0 ? `You owe me: ${money(s.left)}` : `Balance with me: ${money(s.left)}`,
  ].filter(x => x !== null).join('\n');
}

// ---------- views: add / edit ----------

function startDraft(p) {
  if (p.id) {
    const e = findEntry(p.id);
    if (e) { draft = { ...e, amountText: String(e.amount), isEdit: true }; return; }
  }
  const account = isTeam() ? (p.account || state.account) : 'mom';
  draft = {
    id: newId(), type: p.type === 'in' ? 'in' : 'out', account, amountText: p.amount || '',
    category: p.cat || '', sub: p.sub || '', note: p.note || '', mode: role() === 'dad' ? 'cash' : 'upi',
    paid_by_me: false, private: false, date: defaultDateFor(state.month), isEdit: false,
  };
}

function viewAdd() {
  const d = draft;
  const cats = categories(d.account, d.type);
  const top = cats.filter(c => c.top);
  let visible = showAllCats || top.length === 0 ? cats : top;
  if (d.category && !visible.some(c => c.name === d.category)) {
    visible = visible.concat(cats.find(c => c.name === d.category) || { name: d.category, subs: [] });
  }
  const more = !showAllCats && cats.length > visible.length;
  const info = cats.find(c => c.name === d.category);
  const subs = info?.subs || [];
  const title = d.isEdit ? 'Edit entry' : d.type === 'in' ? 'Money received' : 'Add expense';
  const canPrivate = d.account === 'mom' && role() !== 'dad';
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>${title}</h1></div>
    ${isTeam() ? `<div class="seg" role="group" aria-label="Account">
      <button data-draft-account="mom" aria-pressed="${d.account === 'mom'}">Mom</button>
      <button data-draft-account="us" aria-pressed="${d.account === 'us'}">Us</button>
    </div>` : ''}
    <div class="amount ${d.amountText ? '' : 'empty'}" id="amount">${amountText(d.amountText)}</div>
    <div class="keypad">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-key="${k}" aria-label="${k === '⌫' ? 'Delete digit' : k}">${k}</button>`).join('')}
    </div>
    <div class="grid3" role="group" aria-label="Category">
      ${visible.map(c => `<button class="tile" data-cat="${esc(c.name)}" aria-pressed="${d.category === c.name}">${esc(c.name)}</button>`).join('')}
      ${more ? `<button class="tile" data-more><span>More</span><small>${cats.length - visible.length} more</small></button>` : ''}
    </div>
    ${subs.length ? `<div class="row-chips" role="group" aria-label="Type">
      ${subs.map(s => `<button class="chip" data-sub="${esc(s)}" aria-pressed="${d.sub === s}">${esc(s)}</button>`).join('')}
    </div>` : ''}
    ${isTeam() && d.account === 'mom' && d.type === 'out' ? `
    <button class="toggle-row" role="switch" aria-checked="${d.paid_by_me}" data-toggle-me>
      <span>I'll pay for this myself<small>Counts as house spending, not charged to Mom</small></span><i class="switch"></i>
    </button>` : ''}
    <input class="text-input" id="note" maxlength="200" placeholder="Note (optional)" value="${esc(d.note)}">
    <div class="row-chips">
      <button class="chip" data-mode="upi" aria-pressed="${d.mode === 'upi'}">UPI</button>
      <button class="chip" data-mode="cash" aria-pressed="${d.mode === 'cash'}">Cash</button>
      <label class="chip date-btn" style="display:flex;align-items:center">📅 ${dayLabel(d.date)}<input type="date" id="date" value="${d.date}" max="${today()}" aria-label="Date"></label>
      ${canPrivate ? `<button class="chip" data-private aria-pressed="${!!d.private}">Private</button>` : ''}
    </div>
    ${d.isEdit ? '<button class="btn btn-danger" id="delete">Delete entry</button>' : ''}
    <div class="sticky-save"><p class="err" id="err"></p><button class="btn btn-primary" id="save">✓ Save</button></div>`;
}

function amountText(t) {
  return '₹ ' + (t ? Number(t).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + (t.endsWith('.') ? '.' : '') : '0');
}

function bindAdd() {
  const app = document.getElementById('app');
  const note = document.getElementById('note');
  note.oninput = () => { draft.note = note.value; };
  document.getElementById('date').onchange = e => { if (e.target.value) { draft.date = e.target.value; render(); } };
  app.querySelectorAll('[data-key]').forEach(b => b.onclick = () => {
    const k = b.dataset.key;
    let t = draft.amountText;
    if (k === '⌫') t = t.slice(0, -1);
    else if (k === '.') { if (!t.includes('.')) t = (t || '0') + '.'; }
    else if (/\.\d{2}$/.test(t)) return;
    else if (t.replace('.', '').length >= 8) return;
    else t = t === '0' ? k : t + k;
    draft.amountText = t;
    const el = document.getElementById('amount');
    el.classList.toggle('empty', !t);
    el.textContent = amountText(t);
    document.getElementById('err').textContent = '';
  });
  app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
    if (draft.category !== b.dataset.cat) draft.sub = '';
    draft.category = b.dataset.cat;
    render();
  });
  app.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { draft.sub = draft.sub === b.dataset.sub ? '' : b.dataset.sub; render(); });
  const more = app.querySelector('[data-more]');
  if (more) more.onclick = () => { showAllCats = true; render(); };
  app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { draft.mode = b.dataset.mode; render(); });
  const priv = app.querySelector('[data-private]');
  if (priv) priv.onclick = () => { draft.private = !draft.private; render(); };
  app.querySelectorAll('[data-draft-account]').forEach(b => b.onclick = () => {
    if (draft.account === b.dataset.draftAccount) return;
    draft.account = b.dataset.draftAccount;
    if (!categories(draft.account, draft.type).some(c => c.name === draft.category)) { draft.category = ''; draft.sub = ''; }
    if (draft.account !== 'mom') { draft.paid_by_me = false; draft.private = false; }
    showAllCats = false;
    render();
  });
  const tgl = app.querySelector('[data-toggle-me]');
  if (tgl) tgl.onclick = () => { draft.paid_by_me = !draft.paid_by_me; render(); };

  document.getElementById('save').onclick = () => {
    const amount = Number(draft.amountText);
    const err = document.getElementById('err');
    if (!(amount > 0)) { err.textContent = 'Enter an amount.'; return; }
    if (!draft.category) { err.textContent = 'Pick a category.'; return; }
    const info = catInfo(draft.account, draft.type, draft.category);
    if (info?.sub_required && !draft.sub) { err.textContent = `Pick what kind of ${draft.category.toLowerCase()} expense.`; return; }
    const { amountText: _a, isEdit, _v, ...rest } = draft;
    saveEntry({
      ...rest, amount, note: draft.note.trim(),
      paid_by_me: isTeam() && draft.account === 'mom' && draft.type === 'out' && draft.paid_by_me,
      private: draft.account === 'mom' && role() !== 'dad' && !!draft.private,
    });
    if (isTeam()) { state.account = draft.account; store.set(KEYS.account, state.account); }
    toast(navigator.onLine ? 'Saved' : 'Saved · will sync when online');
    history.back();
  };
  const del = document.getElementById('delete');
  if (del) del.onclick = () => {
    if (!confirm('Delete this entry?')) return;
    const { amountText: _a, isEdit, _v, ...rest } = draft;
    saveEntry({ ...rest, amount: Number(draft.amountText) || Number(rest.amount) || 1, deleted: true });
    toast('Deleted');
    history.back();
  };
}

// ---------- views: fixed ----------

function viewFixed() {
  const m = state.month;
  const list = fixedFor(state.account, m);
  const rows = list.map((f, i) => {
    const done = fixedEntry(f, m);
    if (done) {
      return `<button class="fixed-row done" data-edit="${esc(done.id)}"><span class="check">✓</span><span class="grow">${esc(f.name)}</span><strong>${money(done.amount)}</strong></button>`;
    }
    if (f.per_unit) {
      const n = store.get(KEYS.counts, {})[f.name] ?? 30;
      return `<div class="card">
        <p style="margin:0;font-weight:600">${esc(f.name)}</p>
        <div class="counter">
          <button data-step="-1" data-idx="${i}" aria-label="Fewer ${esc(f.unit || 'units')}">−</button>
          <div class="val"><strong id="cnt-${i}">${n}</strong><span class="label">${esc(f.unit || 'units')} × ${money(f.per_unit)}</span></div>
          <button data-step="1" data-idx="${i}" aria-label="More ${esc(f.unit || 'units')}">+</button>
        </div>
        <button class="btn btn-outline" data-pay-unit="${i}" id="pay-${i}">Mark paid · ${money(n * f.per_unit)}</button>
      </div>`;
    }
    if (f.amount) {
      return `<button class="fixed-row" data-pay="${i}"><span class="check"></span><span class="grow">${esc(f.name)}${f.paid_by_me ? '<small class="label" style="display:block">Paid by you</small>' : ''}</span><strong>${money(f.amount)}</strong></button>`;
    }
    return `<button class="fixed-row" data-ask="${i}"><span class="check"></span><span class="grow">${esc(f.name)}</span><span class="label">Enter amount</span></button>`;
  });
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>Fixed · ${state.account === 'mom' ? 'Mom' : 'Us'}</h1></div>
    <p class="label">${monthLabel(m)}. Tap to mark paid. Tap a paid one to edit it.</p>
    ${rows.join('') || '<p class="empty-state">No fixed payments set up. Add them in the Fixed tab of the sheet.</p>'}
    ${syncLine()}`;
}

function bindFixed() {
  const app = document.getElementById('app');
  const list = fixedFor(state.account, state.month);
  const base = f => ({
    id: newId(), account: f.account, type: 'out', category: f.category, sub: f.sub, note: f.name,
    mode: 'upi', paid_by_me: f.account === 'mom' && f.paid_by_me, private: false, date: defaultDateFor(state.month),
  });
  const markPaid = async (f, amount, note) => {
    const m = state.month;
    if (navigator.onLine) await loadMonth(m, true); // pick up anything the other phone just marked
    const done = fixedEntry(f, m);
    if (done) {
      toast(`${f.name} is already paid${done.logged_by && done.logged_by !== state.settings.name ? ` (${done.logged_by})` : ''}`);
      render();
      return;
    }
    saveEntry({ ...base(f), id: fixedId(f, m), amount, note: note || f.name });
    toast(`${f.name} marked paid`);
    render();
  };
  app.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    b.disabled = true;
    const f = list[b.dataset.pay];
    markPaid(f, f.amount);
  });
  app.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const f = list[b.dataset.idx];
    const counts = store.get(KEYS.counts, {});
    const n = Math.max(0, Math.min(99, (counts[f.name] ?? 30) + Number(b.dataset.step)));
    counts[f.name] = n;
    store.set(KEYS.counts, counts);
    document.getElementById(`cnt-${b.dataset.idx}`).textContent = n;
    document.getElementById(`pay-${b.dataset.idx}`).textContent = `Mark paid · ${money(n * f.per_unit)}`;
  });
  app.querySelectorAll('[data-pay-unit]').forEach(b => b.onclick = () => {
    const f = list[b.dataset.payUnit];
    const n = store.get(KEYS.counts, {})[f.name] ?? 30;
    if (!n) { toast(`Set the number of ${f.unit || 'units'} first`); return; }
    b.disabled = true;
    markPaid(f, n * f.per_unit, `${f.name}: ${n} ${f.unit || 'units'} × ${f.per_unit}`);
  });
  app.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => {
    const f = list[b.dataset.ask];
    go(`#/add?type=out&account=${f.account}&cat=${encodeURIComponent(f.category)}&sub=${encodeURIComponent(f.sub)}&note=${encodeURIComponent(f.name)}`);
  });
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => go(`#/add?id=${encodeURIComponent(b.dataset.edit)}`));
}

// ---------- views: list ----------

function viewList() {
  const p = params();
  const account = isTeam() ? state.account : 'mom';
  let list = monthData(state.month).entries.filter(e => e.account === account);
  if (p.cat) list = list.filter(e => e.category === p.cat);
  const received = list.filter(e => e.type === 'in').reduce((s, e) => s + Number(e.amount), 0);
  const spent = list.filter(e => e.type === 'out').reduce((s, e) => s + Number(e.amount), 0);
  const who = { team: 'Hari and Harini', dad: 'Appa', mom: 'Amma' };
  const rows = list.map(e => `
    <button class="item" data-edit="${esc(e.id)}">
      <span class="grow">
        <span class="title">${esc(label(e))}${e.note ? ' · ' + esc(e.note) : ''}${e.paid_by_me ? '<span class="badge me">on us</span>' : ''}${e.private ? '<span class="badge priv">private</span>' : ''}${state.queue.some(q => q.id === e.id) ? '<span class="badge">waiting</span>' : ''}</span>
        <span class="sub">${dayLabel(e.date)} · ${e.mode === 'cash' ? 'Cash' : 'UPI'} · ${esc(e.logged_by || who[e.pot] || '')}</span>
      </span>
      <span class="amt ${e.type === 'in' ? 'in' : ''}">${e.type === 'in' ? '+' : ''}${money(e.amount)}</span>
    </button>`).join('');
  const title = p.cat ? esc(p.cat) : account === 'mom' ? 'Mom' : 'Us';
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>${title}</h1></div>
    ${p.cat ? '' : accountSwitch()}
    ${monthNav()}
    <div class="stats">
      <div class="stat"><span class="label">Received</span><strong>${money(received)}</strong></div>
      <div class="stat"><span class="label">Spent</span><strong>${money(spent)}</strong></div>
    </div>
    <div class="list">${rows || '<p class="empty-state">No entries this month yet.</p>'}</div>
    ${syncLine()}`;
}

function bindList() {
  const me = state.settings.name;
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const e = findEntry(b.dataset.edit);
    const mine = e && (e.logged_by === me || role() === 'admin' || (role() === 'team' && e.pot !== 'dad' && e.pot !== 'mom'));
    if (!mine) { toast(`Only ${e?.logged_by || 'the person who logged it'} can change this`); return; }
    go(`#/add?id=${encodeURIComponent(b.dataset.edit)}`);
  });
}

// ---------- views: settings / family ----------

function viewSettings() {
  const s = state.settings;
  const roleName = { admin: 'Admin', team: 'Hari and Harini', mom: 'Amma', dad: 'Appa' }[s.role] || s.role;
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>Settings</h1></div>
    <div class="card">
      <p class="label">Signed in as</p><p style="margin:0 0 4px;font-size:20px;font-weight:600">${esc(s.name)}</p>
      <p class="label">${roleName} · ${state.queue.length} entries waiting to save</p>
    </div>
    ${s.role === 'admin' ? '<button class="btn btn-outline" data-go="#/family">Family and invites</button>' : ''}
    <button class="btn btn-outline" id="refresh">Reload categories</button>
    <button class="btn btn-outline" id="sync-now">Save waiting entries now</button>
    ${s.role === 'admin' ? '<button class="btn btn-danger" id="fresh">Start fresh (archive all entries)</button>' : ''}
    <button class="btn btn-danger" id="signout">Disconnect this phone</button>
    <p class="sync">Kutti Krishna House ${APP_VERSION}</p>`;
}

function bindSettings() {
  document.getElementById('refresh').onclick = async () => { await loadConfig(); toast('Updated'); };
  document.getElementById('sync-now').onclick = () => { flush(); toast('Saving…'); };
  const fresh = document.getElementById('fresh');
  if (fresh) fresh.onclick = async () => {
    if (!confirm('Move every entry to the Archive tab and start with an empty ledger? Nothing is deleted.')) return;
    if (!confirm('Are you sure? Everyone will start from zero.')) return;
    try {
      const r = await api('archive_all');
      state.cache = {}; state.queue = [];
      store.set(KEYS.cache, {}); store.set(KEYS.queue, []);
      toast(`Archived ${r.archived} entries`);
      go('#/home');
      loadMonth(state.month);
    } catch (e) { toast(e.message); }
  };
  document.getElementById('signout').onclick = () => {
    const n = state.queue.length;
    if (!confirm(n ? `${n} entries haven't been saved yet and will be lost. Disconnect anyway?` : 'Disconnect this phone?')) return;
    Object.values(KEYS).forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    location.hash = '';
    location.reload();
  };
}

function inviteLink(name) {
  return `${location.origin}${location.pathname}#/join?u=${encodeURIComponent(state.settings.url)}&n=${encodeURIComponent(name)}`;
}

function viewFamily() {
  const members = state.members;
  const status = { active: 'Joined', invited: 'Invite waiting', removed: 'Removed' };
  const roleName = { admin: 'Admin', team: 'Team', mom: 'Amma', dad: 'Appa' };
  const inv = state.lastInvite;
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>Family</h1></div>
    ${inv ? `<div class="card invite-card">
      <p class="label">Invite for ${esc(inv.name)}</p>
      <p class="code">${inv.code.slice(0, 3)} ${inv.code.slice(3)}</p>
      <p class="label">Read this code out on a phone call. It works once, for 24 hours.</p>
      <div class="grid2" style="margin-top:12px">
        <button class="btn btn-outline" id="share-link">Share link</button>
        <button class="btn btn-outline" id="copy-link">Copy link</button>
      </div>
      <p class="label" style="margin-top:10px">Send the link on WhatsApp. Never send the code there.</p>
    </div>` : ''}
    <div class="list">
      ${members ? members.map(m => `
        <div class="item">
          <span class="grow"><span class="title">${esc(m.name)}</span><span class="sub">${roleName[m.role] || esc(m.role)} · ${status[m.status] || esc(m.status)}</span></span>
          <button class="chip" data-reinvite="${esc(m.name)}" data-role="${esc(m.role)}">New invite</button>
          ${m.name !== state.settings.name && m.status !== 'removed' ? `<button class="chip danger" data-remove="${esc(m.name)}">Remove</button>` : ''}
        </div>`).join('') : '<p class="empty-state">Loading…</p>'}
    </div>
    <div class="card">
      <p style="margin:0 0 10px;font-weight:600">Invite someone</p>
      <input id="inv-name" class="text-input" placeholder="Name, like Dad" maxlength="30">
      <div class="row-chips" style="margin:10px 0" role="group" aria-label="Role">
        <button class="chip" data-new-role="mom" aria-pressed="true">Amma</button>
        <button class="chip" data-new-role="dad">Appa</button>
        <button class="chip" data-new-role="team">Team (sees Us)</button>
      </div>
      <p class="err" id="err"></p>
      <button class="btn btn-primary" id="invite">Create invite</button>
    </div>`;
}

function bindFamily() {
  if (!state.members) refreshMembers();
  let newRole = 'mom';
  document.querySelectorAll('[data-new-role]').forEach(b => b.onclick = () => {
    newRole = b.dataset.newRole;
    document.querySelectorAll('[data-new-role]').forEach(x => x.setAttribute('aria-pressed', x === b));
  });
  const make = async (name, r) => {
    const err = document.getElementById('err');
    try {
      const data = await api('invite', { name, role: r });
      state.lastInvite = { name: data.name, code: data.code };
      await refreshMembers();
      window.scrollTo(0, 0);
    } catch (e) { err.textContent = e.message; }
  };
  document.getElementById('invite').onclick = () => {
    const name = document.getElementById('inv-name').value.trim();
    if (!name) { document.getElementById('err').textContent = 'Enter a name.'; return; }
    make(name, newRole);
  };
  document.querySelectorAll('[data-reinvite]').forEach(b => b.onclick = () => {
    const self = b.dataset.reinvite === state.settings.name;
    if (!confirm(self ? 'This disconnects this phone until you join again with the new code. Continue?' : `Make a new invite for ${b.dataset.reinvite}? Their current phone will be disconnected.`)) return;
    make(b.dataset.reinvite, b.dataset.role);
  });
  document.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    if (!confirm(`Remove ${b.dataset.remove}? Their phone stops working immediately.`)) return;
    try { await api('remove', { name: b.dataset.remove }); toast('Removed'); refreshMembers(); } catch (e) { toast(e.message); }
  });
  const share = document.getElementById('share-link');
  if (share) share.onclick = () => shareText(`Join Kutti Krishna House: ${inviteLink(state.lastInvite.name)}\nI'll tell you the code on a call.`);
  const copy = document.getElementById('copy-link');
  if (copy) copy.onclick = () => copyText(inviteLink(state.lastInvite.name));
}

async function refreshMembers() {
  try {
    const data = await api('members');
    state.members = data.members;
    if (route() === 'family') render();
  } catch (e) { toast(e.message); }
}

// ---------- render ----------

function renderSync() {
  const el = document.getElementById('sync');
  if (el) el.outerHTML = syncLine();
}

function route() {
  const name = (location.hash.split('?')[0] || '#/home').replace('#/', '') || 'home';
  if (name === 'join') return 'join';
  return state.settings ? name : 'setup';
}

function render() {
  const app = document.getElementById('app');
  const r = route();
  const views = {
    join: [viewJoin, bindJoin], setup: [viewSetup, bindSetup],
    home: [viewHome, () => (role() === 'mom' ? bindMomHome() : role() === 'dad' ? bindDadHome() : null)],
    add: [viewAdd, bindAdd], fixed: [viewFixed, bindFixed], list: [viewList, bindList],
    settings: [viewSettings, bindSettings], family: [viewFamily, bindFamily],
  };
  let [view, bind] = views[r] || views.home;
  if ((r === 'fixed' && !isTeam()) || (r === 'family' && role() !== 'admin')) [view, bind] = views.home;
  if (r === 'add' && !draft) startDraft(params());
  const focused = document.activeElement?.id;
  app.innerHTML = view();
  bindCommon(app);
  if (bind) bind();
  if (focused === 'chat') document.getElementById('chat')?.focus();
}

function bindCommon(app) {
  app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  app.querySelectorAll('[data-back]').forEach(b => b.onclick = () => {
    if (history.length > 1) history.back(); else go('#/home');
  });
  app.querySelectorAll('[data-account]').forEach(b => b.onclick = () => {
    state.account = b.dataset.account;
    store.set(KEYS.account, state.account);
    render();
  });
  app.querySelectorAll('[data-month]').forEach(b => b.onclick = () => {
    const next = shiftMonth(state.month, Number(b.dataset.month));
    if (next > thisMonth()) return;
    state.month = next;
    state.pending = null;
    render();
    loadMonth(next);
    if (role() === 'mom') momMonths().forEach(m => { if (!state.cache[m]) loadMonth(m, true); });
  });
}

window.addEventListener('hashchange', () => {
  draft = null;
  showAllCats = false;
  render();
  window.scrollTo(0, 0);
  if (state.settings && navigator.onLine && route() !== 'add' && Date.now() - (loadedAt[state.month] || 0) > 20000) {
    loadMonth(state.month, true);
  }
});
window.addEventListener('online', () => { state.lastError = ''; flush(); loadMonth(state.month, true); });
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.settings) {
    flush();
    loadMonth(state.month, true);
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
}

render();
if (state.settings) {
  flush();
  loadMonth(state.month, true);
  loadConfig();
}

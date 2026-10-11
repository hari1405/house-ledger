'use strict';

// ---------- storage ----------

const KEYS = {
  settings: 'hl.settings', config: 'hl.config', queue: 'hl.queue',
  cache: 'hl.cache', account: 'hl.account', counts: 'hl.counts',
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
  settings: store.get(KEYS.settings, null),
  config: store.get(KEYS.config, { categories: [], fixed: [] }),
  account: store.get(KEYS.account, 'mom'),
  month: thisMonth(),
  cache: store.get(KEYS.cache, {}), // month -> { carry, entries }
  queue: store.get(KEYS.queue, []), // entries not yet saved to the sheet
  syncing: false,
  lastError: '',
};
let draft = null;
let showAllCats = false;

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
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}
function go(hash) { location.hash = hash; }
function params() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
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
  return state.cache[m] || { carry: 0, entries: [] };
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
  const e = { ...entry, created_at: entry.created_at || new Date().toISOString(), _v: newId() };
  for (const m of Object.keys(state.cache)) {
    state.cache[m].entries = state.cache[m].entries.filter(x => x.id !== e.id);
  }
  if (!e.deleted) {
    const m = e.date.slice(0, 7);
    state.cache[m] = state.cache[m] || { carry: 0, entries: [] };
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
    await api('save', { entries: batch.map(({ _v, ...rest }) => rest) });
    const sent = new Map(batch.map(e => [e.id, e._v]));
    state.queue = state.queue.filter(e => sent.get(e.id) !== e._v); // keep anything edited mid-flight
    store.set(KEYS.queue, state.queue);
    state.lastError = '';
    ok = true;
  } catch (err) {
    state.lastError = navigator.onLine ? err.message : '';
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
    const pending = state.queue.filter(e => e.date.slice(0, 7) === m);
    const pendingIds = new Set(state.queue.map(e => e.id));
    const entries = data.entries.filter(e => !pendingIds.has(e.id)).concat(pending.filter(e => !e.deleted));
    state.cache[m] = { carry: data.carry, entries: sortEntries(entries) };
    store.set(KEYS.cache, state.cache);
    state.lastError = '';
    if (state.month === m) render();
  } catch (err) {
    state.lastError = navigator.onLine ? err.message : '';
    if (!quiet) renderSync();
  }
}

function summary(account, m) {
  const d = monthData(m);
  const list = d.entries.filter(e => e.account === account);
  const sum = f => list.filter(f).reduce((s, e) => s + Number(e.amount), 0);
  const received = sum(e => e.type === 'in');
  const spent = sum(e => e.type === 'out' && !e.paid_by_me);
  const covered = sum(e => e.type === 'out' && e.paid_by_me);
  const carry = account === 'mom' ? d.carry : 0;
  return { received, spent, covered, carry, left: carry + received - spent, count: list.length };
}

function categories(account, type) {
  return state.config.categories.filter(c => c.account === account && c.type === type);
}

function fixedFor(m) {
  const mo = Number(m.slice(5));
  return state.config.fixed.filter(f => f.months !== 'odd' || mo % 2 === 1)
    .filter(f => f.months !== 'even' || mo % 2 === 0);
}

function fixedEntry(f, m) {
  return monthData(m).entries.find(e => e.account === 'mom' && e.type === 'out' && e.category === f.category);
}

// ---------- views ----------

function viewSetup() {
  return `
    <div class="bar"><h1>Set up this phone</h1></div>
    <p class="label">Paste the web app URL and your key from the Users tab of the House Ledger sheet. You only do this once.</p>
    <label class="label" for="url">Web app URL</label>
    <input id="url" class="text-input" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.settings?.url || '')}">
    <label class="label" for="key">Your key</label>
    <input id="key" class="text-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Long key from the Users tab">
    <p class="err" id="err"></p>
    <button class="btn btn-primary" id="connect">Connect</button>`;
}

function bindSetup() {
  document.getElementById('connect').onclick = async () => {
    const url = document.getElementById('url').value.trim();
    const key = document.getElementById('key').value.trim();
    const err = document.getElementById('err');
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) && !/^http:\/\/localhost[:/]/.test(url)) {
      err.textContent = 'That URL should start with https://script.google.com and end with /exec.';
      return;
    }
    if (key.length < 20) { err.textContent = 'Paste the full key from the Users tab.'; return; }
    err.textContent = 'Connecting…';
    try {
      const data = await api('config', {}, { url, key });
      state.settings = { url, key, name: data.user };
      state.config = data.config;
      store.set(KEYS.settings, state.settings);
      store.set(KEYS.config, state.config);
      toast(`Connected as ${data.user}`);
      go('#/home');
      loadMonth(state.month);
    } catch (e) {
      err.textContent = e.message === 'Invalid key' ? "That key isn't in the Users tab." : "Couldn't connect. Check the URL and your internet.";
    }
  };
}

function accountSwitch() {
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
  if (state.lastError) return `<p class="sync pending" id="sync">${esc(state.lastError)} · ${n} waiting</p>`;
  if (state.syncing) return `<p class="sync" id="sync">Saving to sheet…</p>`;
  if (n) return `<p class="sync pending" id="sync">${n} waiting · will save when online</p>`;
  return `<p class="sync" id="sync">✓ Saved to sheet</p>`;
}

function viewHome() {
  const s = summary(state.account, state.month);
  let card;
  if (state.account === 'mom') {
    const pool = s.carry + s.received;
    const pct = pool > 0 ? Math.min(100, Math.round((s.spent / pool) * 100)) : (s.spent ? 100 : 0);
    const owed = s.left < 0;
    card = `<div class="card">
      <p class="label">${owed ? 'Mom owes you' : "Left from Mom's money"}</p>
      <p class="big-num ${owed ? 'neg' : ''}">${money(s.left)}</p>
      <div class="meter ${owed ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <p class="label">${s.carry ? `Brought forward ${s.carry < 0 ? '−' : ''}${money(s.carry)} · ` : ''}In ${money(s.received)} · Spent ${money(s.spent)}</p>
      ${s.covered ? `<p class="note-good">You covered ${money(s.covered)} for the house</p>` : ''}
    </div>`;
  } else {
    const saved = s.received - s.spent;
    card = `<div class="card">
      <p class="label">Spent this month</p>
      <p class="big-num">${money(s.spent)}</p>
      <p class="label">In ${money(s.received)} · ${saved >= 0 ? 'Saved' : 'Over by'} ${money(saved)}</p>
    </div>`;
  }
  const fixed = fixedFor(state.month);
  const fixedDone = fixed.filter(f => fixedEntry(f, state.month)).length;
  const tiles = state.account === 'mom'
    ? `<div class="grid2">
         <button class="tile" data-go="#/fixed"><span>Fixed</span><small>${fixedDone} of ${fixed.length} paid</small></button>
         <button class="tile" data-go="#/list"><span>This month</span><small>${s.count} entries</small></button>
       </div>`
    : `<button class="btn btn-outline" data-go="#/list">This month · ${s.count} entries</button>`;
  return `
    <div class="bar"><h1>House Ledger</h1><button class="icon-btn" data-go="#/settings" aria-label="Settings">⚙︎</button></div>
    ${accountSwitch()}
    ${monthNav()}
    ${card}
    <button class="btn btn-primary" data-go="#/add?type=out">＋ Add expense</button>
    <button class="btn btn-outline" data-go="#/add?type=in">↙ Money received</button>
    ${tiles}
    ${syncLine()}`;
}

function startDraft(p) {
  if (p.id) {
    const e = findEntry(p.id);
    if (e) { draft = { ...e, amountText: String(e.amount), isEdit: true }; return; }
  }
  const account = p.account || state.account;
  draft = {
    id: newId(), type: p.type === 'in' ? 'in' : 'out', account, amountText: p.amount || '',
    category: p.cat || '', note: p.note || '', mode: 'upi', paid_by_me: false,
    date: defaultDateFor(state.month), isEdit: false,
  };
}

function viewAdd() {
  const d = draft;
  const cats = categories(d.account, d.type);
  const top = cats.filter(c => c.top);
  let visible = showAllCats || top.length === 0 ? cats : top;
  if (d.category && !visible.some(c => c.name === d.category)) {
    visible = visible.concat(cats.find(c => c.name === d.category) || { name: d.category });
  }
  const more = !showAllCats && cats.length > visible.length;
  const title = d.isEdit ? 'Edit entry' : d.type === 'in' ? 'Money received' : 'Add expense';
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>${title}</h1></div>
    <div class="seg" role="group" aria-label="Account">
      <button data-draft-account="mom" aria-pressed="${d.account === 'mom'}">Mom</button>
      <button data-draft-account="us" aria-pressed="${d.account === 'us'}">Us</button>
    </div>
    <div class="amount ${d.amountText ? '' : 'empty'}" id="amount">₹ ${d.amountText ? esc(Number(d.amountText).toLocaleString('en-IN', { maximumFractionDigits: 2 })) + (d.amountText.endsWith('.') ? '.' : '') : '0'}</div>
    <div class="keypad">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-key="${k}" aria-label="${k === '⌫' ? 'Delete digit' : k}">${k}</button>`).join('')}
    </div>
    <div class="grid3" role="group" aria-label="Category">
      ${visible.map(c => `<button class="tile" data-cat="${esc(c.name)}" aria-pressed="${d.category === c.name}">${esc(c.name)}</button>`).join('')}
      ${more ? `<button class="tile" data-more><span>More</span><small>${cats.length - visible.length} more</small></button>` : ''}
    </div>
    ${d.account === 'mom' && d.type === 'out' ? `
    <button class="toggle-row" role="switch" aria-checked="${d.paid_by_me}" data-toggle-me>
      <span>I'll pay for this myself<small>Counts as house spending, not charged to Mom</small></span><i class="switch"></i>
    </button>` : ''}
    <input class="text-input" id="note" maxlength="200" placeholder="Note (optional)" value="${esc(d.note)}">
    <div class="row-chips">
      <button class="chip" data-mode="upi" aria-pressed="${d.mode === 'upi'}">UPI</button>
      <button class="chip" data-mode="cash" aria-pressed="${d.mode === 'cash'}">Cash</button>
      <label class="chip date-btn" style="display:flex;align-items:center">📅 ${dayLabel(d.date)}<input type="date" id="date" value="${d.date}" max="${today()}" aria-label="Date"></label>
    </div>
    ${d.isEdit ? '<button class="btn btn-danger" id="delete">Delete entry</button>' : ''}
    <div class="sticky-save"><p class="err" id="err"></p><button class="btn btn-primary" id="save">✓ Save</button></div>`;
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
    el.textContent = '₹ ' + (t ? Number(t).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + (t.endsWith('.') ? '.' : '') : '0');
    document.getElementById('err').textContent = '';
  });
  app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { draft.category = b.dataset.cat; render(); });
  const more = app.querySelector('[data-more]');
  if (more) more.onclick = () => { showAllCats = true; render(); };
  app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { draft.mode = b.dataset.mode; render(); });
  app.querySelectorAll('[data-draft-account]').forEach(b => b.onclick = () => {
    if (draft.account === b.dataset.draftAccount) return;
    draft.account = b.dataset.draftAccount;
    if (!categories(draft.account, draft.type).some(c => c.name === draft.category)) draft.category = '';
    if (draft.account !== 'mom') draft.paid_by_me = false;
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
    const { amountText, isEdit, _v, ...rest } = draft;
    saveEntry({ ...rest, amount, note: draft.note.trim(), paid_by_me: draft.account === 'mom' && draft.type === 'out' && draft.paid_by_me });
    state.account = draft.account;
    store.set(KEYS.account, state.account);
    toast(navigator.onLine ? 'Saved' : 'Saved · will sync when online');
    history.back();
  };
  const del = document.getElementById('delete');
  if (del) del.onclick = () => {
    if (!confirm('Delete this entry?')) return;
    const { amountText, isEdit, _v, ...rest } = draft;
    saveEntry({ ...rest, amount: Number(draft.amountText) || Number(rest.amount) || 1, deleted: true });
    toast('Deleted');
    history.back();
  };
}

function viewFixed() {
  const m = state.month;
  const rows = fixedFor(m).map((f, i) => {
    const done = fixedEntry(f, m);
    if (done) {
      return `<button class="fixed-row done" data-edit="${esc(done.id)}"><span class="check">✓</span><span class="grow">${esc(f.name)}</span><strong>${money(done.amount)}</strong></button>`;
    }
    if (f.per_unit) {
      const counts = store.get(KEYS.counts, {});
      const n = counts[f.name] ?? 30;
      return `<div class="card" data-unit-card="${i}">
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
      return `<button class="fixed-row" data-pay="${i}"><span class="check"></span><span class="grow">${esc(f.name)}</span><strong>${money(f.amount)}</strong></button>`;
    }
    return `<button class="fixed-row" data-ask="${i}"><span class="check"></span><span class="grow">${esc(f.name)}</span><span class="label">Enter amount</span></button>`;
  });
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>Fixed · ${monthLabel(m)}</h1></div>
    <p class="label">Tap to mark paid. Tap a paid one to edit it.</p>
    ${rows.join('') || '<p class="empty-state">No fixed payments set up. Add them in the Fixed tab of the sheet.</p>'}
    ${syncLine()}`;
}

function bindFixed() {
  const app = document.getElementById('app');
  const list = fixedFor(state.month);
  const base = f => ({
    id: newId(), account: 'mom', type: 'out', category: f.category, note: '',
    mode: 'upi', paid_by_me: false, date: defaultDateFor(state.month),
  });
  app.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    const f = list[b.dataset.pay];
    saveEntry({ ...base(f), amount: f.amount });
    toast(`${f.name} marked paid`);
    render();
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
    saveEntry({ ...base(f), amount: n * f.per_unit, note: `${n} ${f.unit || 'units'} × ${f.per_unit}` });
    toast(`${f.name} marked paid`);
    render();
  });
  app.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => {
    const f = list[b.dataset.ask];
    go(`#/add?type=out&account=mom&cat=${encodeURIComponent(f.category)}`);
  });
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => go(`#/add?id=${encodeURIComponent(b.dataset.edit)}`));
}

function viewList() {
  const s = summary(state.account, state.month);
  const list = monthData(state.month).entries.filter(e => e.account === state.account);
  const rows = list.map(e => `
    <button class="item" data-edit="${esc(e.id)}">
      <span class="grow">
        <span class="title">${esc(e.category)}${e.note ? ' · ' + esc(e.note) : ''}${e.paid_by_me ? '<span class="badge me">on me</span>' : ''}${state.queue.some(q => q.id === e.id) ? '<span class="badge">waiting</span>' : ''}</span>
        <span class="sub">${dayLabel(e.date)} · ${e.mode === 'cash' ? 'Cash' : 'UPI'}${e.logged_by ? ' · ' + esc(e.logged_by) : ''}</span>
      </span>
      <span class="amt ${e.type === 'in' ? 'in' : ''}">${e.type === 'in' ? '+' : ''}${money(e.amount)}</span>
    </button>`).join('');
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>${state.account === 'mom' ? 'Mom' : 'Us'}</h1></div>
    ${accountSwitch()}
    ${monthNav()}
    <div class="stats">
      <div class="stat"><span class="label">Received</span><strong>${money(s.received)}</strong></div>
      <div class="stat"><span class="label">Spent</span><strong>${money(s.spent)}</strong></div>
    </div>
    <div class="list">${rows || '<p class="empty-state">No entries this month yet.</p>'}</div>
    ${syncLine()}`;
}

function bindList() {
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => go(`#/add?id=${encodeURIComponent(b.dataset.edit)}`));
}

function viewSettings() {
  const s = state.settings;
  return `
    <div class="bar"><button class="icon-btn" data-back aria-label="Back">←</button><h1>Settings</h1></div>
    <div class="card">
      <p class="label">Signed in as</p><p style="margin:0 0 10px;font-size:20px;font-weight:600">${esc(s.name)}</p>
      <p class="label">${state.queue.length} entries waiting to save</p>
    </div>
    <button class="btn btn-outline" id="refresh">Reload categories and fixed payments</button>
    <button class="btn btn-outline" id="sync-now">Save waiting entries now</button>
    <button class="btn btn-danger" id="signout">Disconnect this phone</button>
    <p class="sync">House Ledger v1</p>`;
}

function bindSettings() {
  document.getElementById('refresh').onclick = async () => {
    try {
      const data = await api('config');
      state.config = data.config;
      store.set(KEYS.config, state.config);
      toast('Updated from sheet');
    } catch { toast("Couldn't reach the sheet"); }
  };
  document.getElementById('sync-now').onclick = () => { flush(); toast('Saving…'); };
  document.getElementById('signout').onclick = () => {
    if (state.queue.length && !confirm(`${state.queue.length} entries haven't been saved yet and will be lost. Disconnect anyway?`)) return;
    if (!state.queue.length && !confirm('Disconnect this phone?')) return;
    Object.values(KEYS).forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    location.hash = '';
    location.reload();
  };
}

// ---------- render ----------

function renderSync() {
  const el = document.getElementById('sync');
  if (el) el.outerHTML = syncLine();
}

function route() {
  const name = (location.hash.split('?')[0] || '#/home').replace('#/', '') || 'home';
  return state.settings ? name : 'setup';
}

function render() {
  const app = document.getElementById('app');
  const r = route();
  const views = {
    setup: [viewSetup, bindSetup], home: [viewHome], add: [viewAdd, bindAdd],
    fixed: [viewFixed, bindFixed], list: [viewList, bindList], settings: [viewSettings, bindSettings],
  };
  const [view, bind] = views[r] || views.home;
  if (r === 'add' && !draft) startDraft(params());
  app.innerHTML = view();
  bindCommon(app);
  if (bind) bind();
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
    render();
    loadMonth(next);
  });
}

window.addEventListener('hashchange', () => {
  if (route() !== 'add') draft = null;
  else { draft = null; showAllCats = false; }
  render();
  window.scrollTo(0, 0);
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
if (state.settings) { flush(); loadMonth(state.month, true); }

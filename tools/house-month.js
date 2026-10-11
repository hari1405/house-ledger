#!/usr/bin/env node
// Monthly close for Kutti Krishna House.
//
//   node tools/house-month.js join <6-digit-code> --url <web app url> [--name Claude]
//   node tools/house-month.js analyse <YYYY-MM>            export + analysis + Mom's draft + private report
//   node tools/house-month.js publish <YYYY-MM> [--team N] [--dad N]   send the draft to Mom's app
//   node tools/house-month.js reconcile <YYYY-MM> <statement.csv>      match a normalised bank statement
//
// Credentials live outside the repo in ~/.config/house-ledger/credentials.json (mode 600).
// Reports and data go to reports/<YYYY-MM>/ which is git-ignored (the repo is public).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CRED_DIR = process.env.HOUSE_LEDGER_CONFIG || path.join(os.homedir(), '.config', 'house-ledger');
const CRED = path.join(CRED_DIR, 'credentials.json');
const SAVINGS = 'Savings and insurance';

// ---------- helpers ----------

function die(msg) { console.error(msg); process.exit(1); }
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function shift(m, d) {
  const [y, mo] = m.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthName(m, style = 'long') {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: style, timeZone: 'UTC' });
}
const r2 = n => Math.round(n * 100) / 100;
const ceilTo = (n, step) => Math.ceil(n / step) * step;
const money = n => (n < 0 ? '−' : '') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
const sum = (list, f = () => true) => r2(list.filter(f).reduce((s, e) => s + Number(e.amount), 0));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byCategory = list => Object.entries(list.reduce((acc, e) => {
  acc[e.category] = (acc[e.category] || 0) + Number(e.amount); return acc;
}, {})).map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);

function creds() {
  if (!fs.existsSync(CRED)) die(`No credentials yet. In the app: Settings → Family → invite "Claude" as Team, then run:\n  node tools/house-month.js join <code> --url <web app url>`);
  return JSON.parse(fs.readFileSync(CRED, 'utf8'));
}

async function api(action, payload, c = creds()) {
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: c.key, action, ...payload }),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data.ok) die(`Server said: ${data.error}`);
  return data;
}

function outDir(m) {
  const d = path.join(ROOT, 'reports', m);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- join ----------

async function join(code) {
  const url = arg('url');
  const name = arg('name', 'Claude');
  if (!/^\d{6}$/.test(code || '')) die('Usage: join <6-digit-code> --url <web app url> [--name Claude]');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url || '') && !/^http:\/\/localhost[:/]/.test(url || '')) die('--url must be the /exec web app URL');
  const data = await api('join', { name, code }, { url, key: '' });
  if (!['admin', 'team'].includes(data.role)) die(`Joined as ${data.role}; the analysis needs a Team invite.`);
  fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CRED, JSON.stringify({ url, key: data.key, name: data.user, role: data.role }, null, 2), { mode: 0o600 });
  console.log(`Joined as ${data.user} (${data.role}). Key saved to ${CRED}`);
}

// ---------- analysis ----------

function fixedMatch(f, e) {
  return e.account === f.account && e.type === 'out' && e.category === f.category && (!f.sub || e.sub === f.sub);
}

function potFlow(entries, pot) {
  const list = entries.filter(e => e.account === 'mom' && e.pot === pot);
  return {
    received: sum(list, e => e.type === 'in'),
    spent: sum(list, e => e.type === 'out' && !e.paid_by_me),
    covered: sum(list, e => e.type === 'out' && e.paid_by_me),
    fromMama: sum(list, e => e.type === 'in' && e.category === 'From Mama'),
  };
}

function analyse(data, M) {
  const N = shift(M, 1);
  const months = [shift(M, -3), shift(M, -2), shift(M, -1), M];
  const inMonth = m => data.entries.filter(e => e.date.slice(0, 7) === m);
  const fixed = data.config.fixed;

  // carry into M for each pot, walking forward from the export's starting carry
  const carry = { ...data.carry };
  months.slice(0, 3).forEach(m => ['team', 'dad'].forEach(p => {
    const f = potFlow(inMonth(m), p);
    carry[p] = r2(carry[p] + f.received - f.spent);
  }));

  const cur = inMonth(M);
  const recent = [shift(M, -2), shift(M, -1), M]; // for "usual" amounts
  const active = (m, pred) => inMonth(m).some(pred);

  // ----- team pot -----
  const tf = potFlow(cur, 'team');
  const teamLeft = r2(carry.team + tf.received - tf.spent);
  const teamOut = e => e.account === 'mom' && e.pot === 'team' && e.type === 'out' && !e.paid_by_me;
  const momFixed = fixed.filter(f => f.account === 'mom' && !f.paid_by_me)
    .filter(f => f.months !== 'odd' || Number(N.slice(5)) % 2 === 1)
    .filter(f => f.months !== 'even' || Number(N.slice(5)) % 2 === 0);
  const estimateLines = momFixed.map(f => {
    let amount = f.amount;
    let note = '';
    if (f.per_unit) {
      const last = cur.filter(e => fixedMatch(f, e)).pop();
      amount = last ? Number(last.amount) : f.per_unit * 30;
      note = last ? `same as ${monthName(M, 'short')}` : `estimated at 30 ${f.unit || 'units'}`;
    } else if (!amount) {
      const past = data.entries.filter(e => fixedMatch(f, e)).map(e => Number(e.amount));
      amount = past.length ? ceilTo(past.reduce((a, b) => a + b, 0) / past.length, 100) : 0;
      note = past.length ? `average of last ${past.length}` : 'no history yet';
    }
    return { label: f.name, amount: r2(amount), note };
  }).filter(l => l.amount > 0);
  const isFixed = e => momFixed.some(f => fixedMatch(f, e)) || fixed.some(f => f.account === 'mom' && fixedMatch(f, e));
  const variableByMonth = recent.filter(m => active(m, teamOut)).map(m => sum(inMonth(m), e => teamOut(e) && !isFixed(e)));
  const variable = variableByMonth.length ? ceilTo(variableByMonth.reduce((a, b) => a + b, 0) / variableByMonth.length, 500) : 0;
  if (variable) estimateLines.push({ label: 'Medicines, groceries and other', amount: variable, note: `usual over ${variableByMonth.length} month${variableByMonth.length > 1 ? 's' : ''}` });
  const teamEstimate = r2(estimateLines.reduce((s, l) => s + l.amount, 0));
  const mamaMonths = recent.map(m => potFlow(inMonth(m), 'team').fromMama).filter(x => x > 0);
  const mama = mamaMonths.length ? Math.round(mamaMonths.reduce((a, b) => a + b, 0) / mamaMonths.length / 100) * 100 : 0;
  const teamCheque = Math.max(0, ceilTo(teamEstimate - mama - teamLeft, 100));

  // ----- dad pot -----
  const df = potFlow(cur, 'dad');
  const dadLeft = r2(carry.dad + df.received - df.spent);
  const dadOut = e => e.account === 'mom' && e.pot === 'dad' && e.type === 'out';
  const dadMonths = recent.filter(m => active(m, dadOut)).map(m => sum(inMonth(m), dadOut));
  const dadEstimate = dadMonths.length ? ceilTo(dadMonths.reduce((a, b) => a + b, 0) / dadMonths.length, 500) : 0;
  const dadCheque = Math.max(0, ceilTo(dadEstimate - dadLeft, 100));

  const leftStep = (left, who) => (left >= 0
    ? { label: `Left with ${who} from ${monthName(M)}`, amount: -left }
    : { label: `${monthName(M)} shortfall ${who === 'them' ? 'they' : 'he'} paid`, amount: -left });

  // ----- what Mom sees -----
  const momOut = cur.filter(e => e.account === 'mom' && e.type === 'out');
  const prevMomOut = recent.slice(0, 2).map(m => byCategory(inMonth(m).filter(e => e.account === 'mom' && e.type === 'out')));
  const notes = [];
  if (tf.covered) notes.push(`Hari and Harini also paid ${money(tf.covered)} themselves (not charged to you).`);
  const nursing = cur.filter(e => e.account === 'mom' && /nursing/i.test(e.category)).map(e => (e.note || '').match(/(\d+)\s*days/)).filter(Boolean);
  if (nursing.length) notes.push(`Nursing was for ${nursing[nursing.length - 1][1]} days.`);
  const alternating = new Set(fixed.filter(f => f.months && f.months !== 'all').map(f => f.category)); // billed every other month
  byCategory(momOut).forEach(c => {
    if (alternating.has(c.name)) return;
    const prev = prevMomOut.map(list => (list.find(x => x.name === c.name) || {}).amount || 0).filter(x => x > 0);
    if (!prev.length) return;
    const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
    if (c.amount - avg > 2000 && c.amount > avg * 1.3) notes.push(`${c.name} was higher than usual (${money(c.amount)} vs about ${money(avg)}).`);
  });

  const summary = {
    version: 1,
    month: M,
    for_month: N,
    total_spent: sum(momOut),
    categories: byCategory(momOut),
    pots: {
      team: {
        name: 'Hari and Harini', received: tf.received, spent: tf.spent, covered: tf.covered,
        carry: carry.team, left: teamLeft, estimate: teamEstimate, estimate_lines: estimateLines, mama, cheque: teamCheque,
        steps: [
          { label: `${monthName(N)} estimate`, amount: teamEstimate },
          ...(mama ? [{ label: 'Mama sends', amount: -mama }] : []),
          leftStep(teamLeft, 'them'),
        ],
      },
      dad: {
        name: 'Appa', received: df.received, spent: df.spent, carry: carry.dad, left: dadLeft,
        estimate: dadEstimate, cheque: dadCheque,
        steps: [
          { label: `${monthName(N)} estimate`, amount: dadEstimate },
          leftStep(dadLeft, 'him'),
        ],
      },
    },
    total_cheque: teamCheque + dadCheque,
    notes: notes.slice(0, 4),
  };

  // ----- private analysis for Hari -----
  const us = cur.filter(e => e.account === 'us');
  const usIncome = sum(us, e => e.type === 'in');
  const usSaved = sum(us, e => e.type === 'out' && e.category === SAVINGS);
  const usSpent = sum(us, e => e.type === 'out' && e.category !== SAVINGS);
  const usOut = us.filter(e => e.type === 'out' && e.category !== SAVINGS);
  const baby = usOut.filter(e => e.category === 'Baby');
  const babyBySub = Object.entries(baby.reduce((a, e) => { a[e.sub || 'Unspecified'] = (a[e.sub || 'Unspecified'] || 0) + Number(e.amount); return a; }, {}))
    .map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);
  const babyTrend = months.map(m => ({ month: m, amount: sum(inMonth(m), e => e.account === 'us' && e.category === 'Baby' && e.type === 'out') }));
  const byPerson = Object.entries(usOut.reduce((a, e) => { a[e.logged_by] = (a[e.logged_by] || 0) + Number(e.amount); return a; }, {}))
    .map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);

  const warnings = [];
  const dueNow = fixed.filter(f => f.months !== 'odd' || Number(M.slice(5)) % 2 === 1).filter(f => f.months !== 'even' || Number(M.slice(5)) % 2 === 0);
  [['mom', "Mom's money"], ['us', 'Us']].forEach(([acct, label]) => {
    const missing = dueNow.filter(f => f.account === acct && !cur.some(e => fixedMatch(f, e))).map(f => f.name);
    if (missing.length) warnings.push(`${label}: ${missing.length} fixed payment${missing.length > 1 ? 's' : ''} not logged (${missing.join(', ')})`);
  });
  if (!tf.received) warnings.push(`No "From Mom" money logged for you two in ${monthName(M)}.`);
  const other = sum(cur, e => e.type === 'out' && e.category === 'Other');
  if (other > 0.1 * (tf.spent + usSpent)) warnings.push(`"Other" is ${money(other)}. Worth re-categorising.`);
  const familySupport = sum(usOut, e => e.category === 'Family support') + tf.covered;

  const analysis = {
    month: M, for_month: N, summary, warnings,
    us: {
      income: usIncome, spent: usSpent, saved: usSaved, house_support: tf.covered, family_support: familySupport,
      left: r2(usIncome - usSpent - usSaved - tf.covered),
      savings_rate: usIncome ? Math.round((usSaved / usIncome) * 100) : null,
      categories: byCategory(usOut).map(c => ({
        ...c, subs: Object.entries(usOut.filter(e => e.category === c.name).reduce((a, e) => { const k = e.sub || '—'; a[k] = (a[k] || 0) + Number(e.amount); return a; }, {}))
          .map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
      })),
      baby: { total: sum(baby), by_sub: babyBySub, trend: babyTrend },
      by_person: byPerson,
      top: usOut.slice().sort((a, b) => b.amount - a.amount).slice(0, 5).map(e => ({ date: e.date, what: e.note || e.sub || e.category, category: e.category, amount: e.amount })),
    },
    mom: { team_categories: byCategory(cur.filter(teamOut)), dad_categories: byCategory(cur.filter(dadOut)) },
    entries_count: cur.length,
  };
  return analysis;
}

function reportHtml(a) {
  const s = a.summary;
  const t = s.pots.team, d = s.pots.dad;
  const rows = list => list.map(x => `<tr><td>${esc(x.name || x.label)}${x.note ? ` <span class="m">(${esc(x.note)})</span>` : ''}</td><td class="n">${money(x.amount)}</td></tr>`).join('');
  const steps = st => st.map(x => `<tr><td>${esc(x.label)}</td><td class="n">${x.amount < 0 ? '−' : '+'}${money(Math.abs(x.amount))}</td></tr>`).join('');
  const bar = (v, max) => `<span class="bar"><i style="width:${max ? Math.round((v / max) * 100) : 0}%"></i></span>`;
  const babyMax = Math.max(...a.us.baby.trend.map(x => x.amount), 1);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${monthName(a.month)} close</title><style>
:root{--bg:#f6f4ef;--card:#fff;--t:#1d1d1b;--m:#6b6a64;--l:#d9d6cc;--a:#1f6f5c;--w:#9a5b0b;--ws:#faeeda}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--card:#22221f;--t:#f1efe8;--m:#a8a69d;--l:#3a3a35;--a:#5dcaa5;--w:#efb45a;--ws:#3a2a10}}
body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.m{color:var(--m);font-size:13px}
.card{background:var(--card);border:1px solid var(--l);border-radius:14px;padding:14px 16px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.k{font-size:13px;color:var(--m)}.v{font-size:22px;font-weight:650}
table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid var(--l)}td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.warn{background:var(--ws);color:var(--w);border-radius:10px;padding:8px 12px;margin:6px 0}.cheque{font-size:28px;font-weight:700;color:var(--a)}
.bar{display:inline-block;width:120px;height:8px;background:var(--l);border-radius:4px;vertical-align:middle;margin-left:8px}.bar i{display:block;height:100%;background:var(--a);border-radius:4px}
</style></head><body><main>
<h1>${monthName(a.month)} ${a.month.slice(0, 4)} close</h1><p class="m">Private report for Hari. ${a.entries_count} entries. Not published anywhere.</p>
${a.warnings.length ? `<h2>Check before publishing</h2>${a.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}` : ''}
<h2>Cheques for ${monthName(s.for_month)} (draft for Mom)</h2>
<div class="grid">
<div class="card"><div class="k">To Hari</div><div class="cheque">${money(t.cheque)}</div><table>${steps(t.steps)}</table></div>
<div class="card"><div class="k">To Appa</div><div class="cheque">${money(d.cheque)}</div><table>${steps(d.steps)}</table></div>
</div>
<div class="card"><div class="k">${monthName(s.for_month)} estimate for you two</div><table>${rows(t.estimate_lines)}</table></div>
<h2>Mom's money in ${monthName(a.month)}</h2>
<div class="grid">
<div class="card"><div class="k">You two</div><table><tr><td>Brought forward</td><td class="n">${money(t.carry)}</td></tr><tr><td>From Mom${t.mama ? ' and Mama' : ''}</td><td class="n">${money(t.received)}</td></tr><tr><td>Spent</td><td class="n">${money(t.spent)}</td></tr><tr><td><b>Left</b></td><td class="n"><b>${money(t.left)}</b></td></tr><tr><td>Paid yourselves</td><td class="n">${money(t.covered)}</td></tr></table></div>
<div class="card"><div class="k">Appa</div><table><tr><td>Brought forward</td><td class="n">${money(d.carry)}</td></tr><tr><td>From Mom</td><td class="n">${money(d.received)}</td></tr><tr><td>Spent</td><td class="n">${money(d.spent)}</td></tr><tr><td><b>Left</b></td><td class="n"><b>${money(d.left)}</b></td></tr></table></div>
</div>
<div class="card"><div class="k">All house spending by category (what Mom sees)</div><table>${rows(s.categories)}</table></div>
${s.notes.length ? `<div class="card"><div class="k">Notes Mom will see</div><ul>${s.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
<h2>Us in ${monthName(a.month)}</h2>
<div class="grid">
<div class="card"><div class="k">Income</div><div class="v">${money(a.us.income)}</div></div>
<div class="card"><div class="k">Spent</div><div class="v">${money(a.us.spent)}</div></div>
<div class="card"><div class="k">Saved${a.us.savings_rate !== null ? ` (${a.us.savings_rate}%)` : ''}</div><div class="v">${money(a.us.saved)}</div></div>
<div class="card"><div class="k">Left after Mom's house</div><div class="v">${money(a.us.left)}</div></div>
</div>
<div class="card"><div class="k">Family support incl. Mom's house: ${money(a.us.family_support)}</div></div>
<div class="card"><div class="k">By category</div><table>${a.us.categories.map(c => `<tr><td><b>${esc(c.name)}</b>${c.subs.filter(x => x.name !== '—').length ? `<br><span class="m">${c.subs.filter(x => x.name !== '—').map(x => `${esc(x.name)} ${money(x.amount)}`).join(' · ')}</span>` : ''}</td><td class="n">${money(c.amount)}</td></tr>`).join('')}</table></div>
<h2>Baby</h2>
<div class="grid"><div class="card"><div class="k">${monthName(a.month)}</div><div class="v">${money(a.us.baby.total)}</div><table>${rows(a.us.baby.by_sub)}</table></div>
<div class="card"><div class="k">Last 4 months</div><table>${a.us.baby.trend.map(x => `<tr><td>${monthName(x.month, 'short')}</td><td class="n">${money(x.amount)}${bar(x.amount, babyMax)}</td></tr>`).join('')}</table></div></div>
<h2>Biggest Us expenses</h2><div class="card"><table>${a.us.top.map(x => `<tr><td>${esc(x.what)} <span class="m">${esc(x.category)} · ${x.date.slice(8)} ${monthName(x.date.slice(0, 7), 'short')}</span></td><td class="n">${money(x.amount)}</td></tr>`).join('')}</table></div>
<h2>Who logged Us spending</h2><div class="card"><table>${rows(a.us.by_person)}</table></div>
</main></body></html>`;
}

// ---------- reconcile ----------

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function reconcile(M, file) {
  const dataFile = path.join(ROOT, 'reports', M, 'data.json');
  if (!fs.existsSync(dataFile)) die(`Run analyse ${M} first.`);
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  const col = n => head.findIndex(h => h.trim().toLowerCase() === n);
  const [ci, ca, cd, ct] = ['date', 'amount', 'description', 'type'].map(col);
  if ([ci, ca, cd, ct].some(i => i < 0)) die('CSV needs columns: date (YYYY-MM-DD), amount, description, type (dr/cr)');
  const who = arg('who');
  const pool = data.entries.filter(e => e.date.slice(0, 7) === M && e.mode !== 'cash' && (!who || e.logged_by === who));
  const used = new Set();
  const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const unmatched = [];
  rows.forEach(r => {
    const date = r[ci].trim(), amount = Number(String(r[ca]).replace(/[,₹\s]/g, '')), type = r[ct].trim().toLowerCase().startsWith('c') ? 'in' : 'out';
    if (!date.startsWith(M) || !(amount > 0)) return;
    const hit = pool.find(e => !used.has(e.id) && e.type === type && Math.abs(Number(e.amount) - amount) < 1 && days(e.date, date) <= 3);
    if (hit) used.add(hit.id); else unmatched.push({ date, amount, type, description: r[cd].trim() });
  });
  const notInStatement = pool.filter(e => !used.has(e.id));
  const out = { month: M, statement: path.basename(file), matched: used.size, unmatched_statement: unmatched, logged_not_in_statement: notInStatement.map(e => ({ date: e.date, amount: e.amount, what: e.note || e.sub || e.category, logged_by: e.logged_by })) };
  fs.writeFileSync(path.join(outDir(M), `reconcile-${path.basename(file, '.csv')}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// ---------- main ----------

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'join') return join(a1);
  if (!/^\d{4}-\d{2}$/.test(a1 || '')) die('Usage: house-month.js analyse|publish|reconcile <YYYY-MM> …');
  const M = a1;
  const dir = outDir(M);

  if (cmd === 'analyse') {
    const data = await api('export', { from: shift(M, -3), to: M });
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 2));
    const analysis = analyse(data, M);
    fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2));
    fs.writeFileSync(path.join(dir, 'summary-draft.json'), JSON.stringify(analysis.summary, null, 2));
    fs.writeFileSync(path.join(dir, 'report.html'), reportHtml(analysis));
    console.log(JSON.stringify({ ...analysis, summary: undefined, draft: {
      cheque_to_hari: analysis.summary.pots.team.cheque, cheque_to_appa: analysis.summary.pots.dad.cheque,
      team_steps: analysis.summary.pots.team.steps, dad_steps: analysis.summary.pots.dad.steps,
      estimate_lines: analysis.summary.pots.team.estimate_lines, notes: analysis.summary.notes,
    } }, null, 2));
    console.log(`\nWrote ${dir}/report.html`);
    return;
  }

  if (cmd === 'publish') {
    const draftFile = path.join(dir, 'summary-draft.json');
    if (!fs.existsSync(draftFile)) die(`Run analyse ${M} first.`);
    const s = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    for (const [flag, pot] of [['team', 'team'], ['dad', 'dad']]) {
      const v = arg(flag);
      if (v !== undefined) {
        const n = Number(v);
        if (!(n >= 0)) die(`--${flag} must be a number`);
        const p = s.pots[pot];
        if (n !== p.cheque) p.steps.push({ label: 'Adjusted by Hari', amount: n - p.cheque, adjusted: true });
        p.cheque = n;
      }
    }
    s.total_cheque = s.pots.team.cheque + s.pots.dad.cheque;
    await api('publish_summary', { summary: s });
    fs.writeFileSync(path.join(dir, 'summary-published.json'), JSON.stringify(s, null, 2));
    console.log(`Published ${monthName(M)} summary: ${money(s.pots.team.cheque)} to Hari, ${money(s.pots.dad.cheque)} to Appa.`);
    return;
  }

  if (cmd === 'reconcile') return reconcile(M, a2);
  die('Unknown command');
})().catch(e => die(e.stack || String(e)));

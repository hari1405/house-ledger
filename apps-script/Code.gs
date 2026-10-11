/**
 * House Ledger — backend for the PWA.
 *
 * Tabs:
 *   Transactions  one row per entry (never deleted, soft-delete flag instead)
 *   Users         name + private key per phone
 *   Categories    tiles shown in the app, per account (mom / us) and type (out / in)
 *   Fixed         monthly fixed payments shown on the "Fixed" screen
 *
 * Every request is a POST with a text/plain JSON body: { key, action, ... }
 * Actions: config, list, save
 */

const TAB = { tx: 'Transactions', users: 'Users', cats: 'Categories', fixed: 'Fixed' };
const TX_COLS = ['id', 'date', 'account', 'type', 'amount', 'category', 'note', 'mode',
                 'paid_by_me', 'logged_by', 'created_at', 'updated_at', 'deleted'];

// ---------- one-time setup (run from the editor) ----------

function setup() {
  const ss = SpreadsheetApp.getActive();

  const tx = sheet_(ss, TAB.tx, TX_COLS);
  tx.getRange('B:B').setNumberFormat('@'); // keep dates as plain YYYY-MM-DD text
  tx.getRange('A:A').setNumberFormat('@');
  tx.getRange('K:L').setNumberFormat('@'); // timestamps as text too

  const users = sheet_(ss, TAB.users, ['name', 'key']);
  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 2, 2).setValues([['Hari', newKey_()], ['Harini', newKey_()]]);
  }

  const cats = sheet_(ss, TAB.cats, ['account', 'type', 'name', 'top']);
  if (cats.getLastRow() < 2) {
    const rows = [];
    const add = (account, type, names, topCount) =>
      names.forEach((n, i) => rows.push([account, type, n, i < topCount ? 'yes' : '']));
    add('mom', 'out', ['Meds', 'Patti Thatha', 'Diapers', 'Doctor / Physio', 'Repairs', 'Groceries',
                       'Nursing', 'Mission', 'Meera Patti', 'Internet', 'Electricity', 'Milk',
                       'Home needs', 'Donations', 'Gifts and functions', 'Tax', 'Other'], 6);
    add('mom', 'in',  ['From Mom', 'From Mama', 'Other'], 3);
    add('us',  'out', ['Food', 'Groceries', 'Transport', 'Shopping', 'Health', 'Bills',
                       'Rent', 'Fuel', 'Insurance / LIC', 'Investment', 'Family support',
                       'Entertainment', 'Gifts', 'Other'], 6);
    add('us',  'in',  ['Salary Hari', 'Salary Harini', 'Other'], 3);
    cats.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  // per_unit > 0 means "count × per_unit" (e.g. nursing days × 900); amount blank means ask each time
  const fixed = sheet_(ss, TAB.fixed, ['name', 'category', 'amount', 'per_unit', 'unit', 'months']);
  if (fixed.getLastRow() < 2) {
    fixed.getRange(2, 1, 5, 6).setValues([
      ['Mission',     'Mission',     9000, '',  '',     'all'],
      ['Meera Patti', 'Meera Patti', 1000, '',  '',     'all'],
      ['Internet',    'Internet',    1200, '',  '',     'all'],
      ['Nursing',     'Nursing',     '',   900, 'days', 'all'],
      ['Electricity', 'Electricity', '',   '',  '',     'odd'],
    ]);
  }

  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

// ---------- web app ----------

function doGet() {
  return json_({ ok: true, service: 'house-ledger' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  const user = auth_(req.key);
  if (!user) return json_({ ok: false, error: 'Invalid key' });

  try {
    switch (req.action) {
      case 'config': return json_({ ok: true, user, config: config_() });
      case 'list':   return json_({ ok: true, ...list_(req.month) });
      case 'save':   return json_({ ok: true, saved: save_(req.entries || [], user) });
      default:       return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// ---------- actions ----------

function config_() {
  const ss = SpreadsheetApp.getActive();
  return {
    categories: rows_(ss.getSheetByName(TAB.cats)).map(r => ({
      account: r.account, type: r.type, name: r.name, top: r.top === 'yes',
    })),
    fixed: rows_(ss.getSheetByName(TAB.fixed)).map(r => ({
      name: r.name, category: r.category, amount: Number(r.amount) || 0,
      per_unit: Number(r.per_unit) || 0, unit: r.unit, months: r.months || 'all',
    })),
  };
}

/** Entries for one month (YYYY-MM) plus Mom's carried-forward balance before that month. */
function list_(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const all = rows_(SpreadsheetApp.getActive().getSheetByName(TAB.tx))
    .filter(r => r.deleted !== true && r.deleted !== 'TRUE')
    .map(clean_);
  let carry = 0;
  const entries = [];
  all.forEach(r => {
    const m = r.date.slice(0, 7);
    if (m === month) entries.push(r);
    else if (m < month && r.account === 'mom' && !r.paid_by_me) {
      carry += r.type === 'in' ? r.amount : -r.amount;
    }
  });
  entries.sort((a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at));
  return { month, carry: Math.round(carry * 100) / 100, entries };
}

/** Insert or update by id (client generates ids, so retries from the offline queue are safe). */
function save_(entries, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(TAB.tx);
    const last = sh.getLastRow();
    const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const rowOf = new Map(ids.map((id, i) => [id, i + 2]));
    const now = new Date().toISOString();
    const appends = new Map();
    const saved = [];

    entries.forEach(e => {
      const v = validate_(e);
      const existing = rowOf.get(v.id);
      if (appends.has(v.id)) {
        appends.set(v.id, toRow_(v, user, appends.get(v.id)[10], now));
      } else if (existing) {
        const old = sh.getRange(existing, 1, 1, TX_COLS.length).getValues()[0];
        const row = toRow_(v, old[TX_COLS.indexOf('logged_by')], old[TX_COLS.indexOf('created_at')], now);
        sh.getRange(existing, 1, 1, TX_COLS.length).setValues([row]);
      } else {
        appends.set(v.id, toRow_(v, user, v.created_at || now, now));
      }
      saved.push(v.id);
    });

    if (appends.size) {
      const rows = [...appends.values()];
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, TX_COLS.length).setValues(rows);
    }
    return saved;
  } finally {
    lock.releaseLock();
  }
}

// ---------- helpers ----------

function validate_(e) {
  const id = String(e.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('Bad id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) throw new Error('Bad date');
  if (!['mom', 'us'].includes(e.account)) throw new Error('Bad account');
  if (!['in', 'out'].includes(e.type)) throw new Error('Bad type');
  const amount = Number(e.amount);
  if (!(amount > 0) || amount > 10000000) throw new Error('Bad amount');
  return {
    id, date: e.date, account: e.account, type: e.type, amount: Math.round(amount * 100) / 100,
    category: String(e.category || 'Other').slice(0, 60),
    note: String(e.note || '').slice(0, 200),
    mode: e.mode === 'cash' ? 'cash' : 'upi',
    paid_by_me: e.account === 'mom' && e.type === 'out' && e.paid_by_me === true,
    deleted: e.deleted === true,
    created_at: e.created_at,
  };
}

function toRow_(v, loggedBy, createdAt, updatedAt) {
  return [v.id, v.date, v.account, v.type, v.amount, v.category, v.note, v.mode,
          v.paid_by_me, loggedBy, createdAt, updatedAt, v.deleted];
}

function clean_(r) {
  const date = r.date instanceof Date
    ? Utilities.formatDate(r.date, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : String(r.date);
  return {
    id: String(r.id), date, account: r.account, type: r.type, amount: Number(r.amount),
    category: r.category, note: r.note, mode: r.mode,
    paid_by_me: r.paid_by_me === true || r.paid_by_me === 'TRUE',
    logged_by: r.logged_by, created_at: String(r.created_at),
  };
}

function auth_(key) {
  if (!key || typeof key !== 'string') return null;
  const hit = rows_(SpreadsheetApp.getActive().getSheetByName(TAB.users))
    .find(r => String(r.key) === key);
  return hit ? String(hit.name) : null;
}

function rows_(sh) {
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.filter(r => r.some(c => c !== '')).map(r =>
    Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function sheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

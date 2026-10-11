/**
 * House Ledger — backend for the PWA (v2: family roles).
 *
 * Tabs:
 *   Transactions  one row per entry (never hard-deleted; soft-delete flag)
 *   Users         one row per person: role, hashed device key, invite state
 *   Categories    tiles per account (mom / us) and type (out / in), with optional subcategories
 *   Fixed         monthly fixed payments shown on the "Fixed" screen (team only)
 *   Archive       rows moved out by "Start fresh"
 *
 * Roles:
 *   admin  Hari: everything, plus family management
 *   team   Harini: everything except family management
 *   mom    Mom's money only (including private entries); no "Us"
 *   dad    Mom's money only, never private entries; balances only for his own kanaku
 *
 * Each entry in Mom's account belongs to a "pot" (whose kanaku it is), set from the
 * logger's role: team (Hari and Harini), dad, or mom (her own spending, no balance).
 *
 * Every request is a POST with a text/plain JSON body: { key, action, ... }
 * Actions: join (no key), config, list, save, members, invite, remove, archive_all
 */

const SCHEMA = '2';
const TAB = { tx: 'Transactions', users: 'Users', cats: 'Categories', fixed: 'Fixed', archive: 'Archive' };
const TX_COLS = ['id', 'date', 'account', 'type', 'amount', 'category', 'note', 'mode',
                 'paid_by_me', 'logged_by', 'created_at', 'updated_at', 'deleted', 'private', 'pot', 'sub'];
const USER_COLS = ['name', 'role', 'key_hash', 'status', 'invite_hash', 'invite_expires', 'invite_attempts', 'joined_at'];
const CAT_COLS = ['account', 'type', 'name', 'top', 'subs', 'sub_required', 'hint'];
const FIXED_COLS = ['account', 'name', 'category', 'sub', 'amount', 'per_unit', 'unit', 'months', 'paid_by_me'];
const TEAM = ['admin', 'team'];
const INVITE_HOURS = 24;
const MAX_CODE_TRIES = 5;

// ---------- setup / migration ----------

/** Safe to run any time from the editor; requests also run it once per schema version. */
function setup() {
  ensureSchema_(true);
}

function ensureSchema_(force) {
  const props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('schema') === SCHEMA) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!force && props.getProperty('schema') === SCHEMA) return;
    const ss = SpreadsheetApp.getActive();

    const tx = sheet_(ss, TAB.tx, TX_COLS);
    setHeader_(tx, TX_COLS);
    tx.getRange('A:B').setNumberFormat('@');
    tx.getRange('K:L').setNumberFormat('@');

    // Users: v1 had [name, key] in plain text. Hash the keys and add roles.
    const users = sheet_(ss, TAB.users, USER_COLS);
    const uHead = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0];
    if (uHead[1] === 'key') {
      const old = users.getLastRow() > 1 ? users.getRange(2, 1, users.getLastRow() - 1, 2).getValues() : [];
      users.clearContents();
      setHeader_(users, USER_COLS);
      const rows = old.filter(r => r[0]).map((r, i) => [
        r[0], i === 0 ? 'admin' : 'team', r[1] ? hash_(String(r[1])) : '', r[1] ? 'active' : 'removed', '', '', 0, '']);
      if (rows.length) users.getRange(2, 1, rows.length, USER_COLS.length).setValues(rows);
    } else {
      setHeader_(users, USER_COLS);
    }

    const cats = sheet_(ss, TAB.cats, CAT_COLS);
    if (cats.getRange(1, 5).getValues()[0][0] !== 'subs' || cats.getLastRow() < 2) {
      cats.clearContents();
      setHeader_(cats, CAT_COLS);
      const rows = seedCategories_();
      cats.getRange(2, 1, rows.length, CAT_COLS.length).setValues(rows);
    }

    const fixed = sheet_(ss, TAB.fixed, FIXED_COLS);
    if (fixed.getRange(1, 1).getValues()[0][0] !== 'account' || fixed.getLastRow() < 2) {
      fixed.clearContents();
      setHeader_(fixed, FIXED_COLS);
      const rows = seedFixed_();
      fixed.getRange(2, 1, rows.length, FIXED_COLS.length).setValues(rows);
    }

    sheet_(ss, TAB.archive, TX_COLS);

    const blank = ss.getSheetByName('Sheet1');
    if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);
    props.setProperty('schema', SCHEMA);
  } finally {
    lock.releaseLock();
  }
}

function seedCategories_() {
  const rows = [];
  // [name, top, subs, sub_required, hint]
  const add = (account, type, list) => list.forEach(c =>
    rows.push([account, type, c[0], c[1] ? 'yes' : '', (c[2] || []).join(', '), c[3] ? 'yes' : '', c[4] || '']));

  add('mom', 'out', [
    ['Medicines', 1, [], 0, 'Pharmacy bills'],
    ['Groceries and milk', 1, ['Groceries', 'Vegetables and fruit', 'Milk'], 0, 'Provisions, vegetables, fruit, milk'],
    ['Care supplies', 1, ['Diapers', 'Underpads', 'Gloves', 'Other'], 0, 'Diapers, underpads, gloves'],
    ['Doctor and tests', 1, ['Doctor', 'Physio', 'Tests', 'Oxygen'], 0, 'Consultations, physio, labs, oxygen'],
    ['Patti Thatha needs', 1, [], 0, 'Their personal items'],
    ['Transport', 1, [], 0, 'Autos, cabs, trains'],
    ['Nursing and care staff', 0, [], 0, 'Nurse salary'],
    ['Household help', 0, ['Rajam', 'Sathya', 'Other'], 0, 'Rajam, Sathya'],
    ['Bills', 0, ['Electricity', 'Internet', 'Gas', 'TV', 'Newspaper'], 0, 'Electricity, internet, gas, TV, newspaper'],
    ['Rent', 0, [], 0, 'House rent'],
    ['Home and repairs', 0, [], 0, 'Fixes, appliances, furniture'],
    ['Family and giving', 0, ['Mission', 'Meera Patti', 'Donation', 'Gifts', 'Functions'], 0, 'Mission, Meera Patti, donations, gifts, functions'],
    ['Other', 0, [], 0, 'Anything else'],
  ]);
  add('mom', 'in', [['From Mom', 1], ['From Dad', 1], ['Other', 1]]);
  add('us', 'out', [
    ['Baby', 1, ['Diapers and wipes', 'Feeding', 'Clothes', 'Health and vaccines', 'Bath and skin care', 'Toys and gear', 'Other'], 1, ''],
    ['Groceries and milk', 1, ['Groceries', 'Vegetables and fruit', 'Milk'], 0, ''],
    ['Food outside', 1, ['Delivery', 'Eating out', 'Snacks'], 0, ''],
    ['Transport', 1, ['Petrol', 'Cab and auto', 'Vehicle service', 'Train and bus'], 0, ''],
    ['Shopping', 1, ['Clothes', 'Home items', 'Electronics', 'Personal care'], 0, ''],
    ['Health', 1, ['Doctor', 'Medicines', 'Tests'], 0, ''],
    ['Bills', 0, ['Electricity', 'Gas', 'Wi-Fi', 'Mobile'], 0, ''],
    ['Subscriptions', 0, ['Google', 'Claude', 'YouTube', 'Netflix', 'Hotstar', 'Spotify', 'Other'], 0, ''],
    ['Household help', 0, ['Rekha Aunty', 'Other'], 0, ''],
    ['Fun and travel', 0, ['Entertainment', 'Trips'], 0, ''],
    ['Family support', 0, ['Harini', 'Gobi', 'Dad', 'Patti Thatha Athai', 'Meera Patti', 'Other'], 0, ''],
    ['Giving', 0, ['Mission', 'Orphanage', 'Other'], 0, ''],
    ['Rent', 0, [], 0, ''],
    ['Savings and insurance', 0, ['RD Harini', 'RD Hari', 'LIC Hari', 'LIC Harini', 'Investment'], 0, 'Counted as saved, not spent'],
    ['Other', 0, [], 0, ''],
  ]);
  add('us', 'in', [['Salary Hari', 1], ['Salary Harini', 1], ['Other', 1]]);
  return rows;
}

function seedFixed_() {
  // [account, name, category, sub, amount, per_unit, unit, months, paid_by_me]
  return [
    ['mom', 'Nursing', 'Nursing and care staff', '', '', 900, 'days', 'all', ''],
    ['mom', 'Mission', 'Family and giving', 'Mission', 9000, '', '', 'all', ''],
    ['mom', 'Meera Patti', 'Family and giving', 'Meera Patti', 1000, '', '', 'all', ''],
    ['mom', 'Internet', 'Bills', 'Internet', 1200, '', '', 'all', ''],
    ['mom', 'Electricity', 'Bills', 'Electricity', '', '', '', 'odd', ''],
    ['mom', 'House rent (paid by us)', 'Rent', '', 30000, '', '', 'all', 'yes'],
    ['us', 'Rent', 'Rent', '', 25000, '', '', 'all', ''],
    ['us', 'Rekha Aunty', 'Household help', 'Rekha Aunty', 2500, '', '', 'all', ''],
    ['us', 'RD Harini', 'Savings and insurance', 'RD Harini', 20000, '', '', 'all', ''],
    ['us', 'RD Hari', 'Savings and insurance', 'RD Hari', 10000, '', '', 'all', ''],
    ['us', 'LIC Hari', 'Savings and insurance', 'LIC Hari', 10000, '', '', 'all', ''],
    ['us', 'LIC Harini', 'Savings and insurance', 'LIC Harini', 5000, '', '', 'all', ''],
    ['us', 'Investment', 'Savings and insurance', 'Investment', 23000, '', '', 'all', ''],
    ['us', 'Harini', 'Family support', 'Harini', 10000, '', '', 'all', ''],
    ['us', 'Gobi', 'Family support', 'Gobi', 10000, '', '', 'all', ''],
    ['us', 'Dad', 'Family support', 'Dad', 5000, '', '', 'all', ''],
    ['us', 'Patti Thatha Athai', 'Family support', 'Patti Thatha Athai', 4000, '', '', 'all', ''],
    ['us', 'Meera Patti', 'Family support', 'Meera Patti', 1000, '', '', 'all', ''],
    ['us', 'Mission', 'Giving', 'Mission', 1000, '', '', 'all', ''],
    ['us', 'Orphanage', 'Giving', 'Orphanage', 1500, '', '', 'all', ''],
    ['us', 'Wi-Fi', 'Bills', 'Wi-Fi', 1200, '', '', 'all', ''],
    ['us', 'Mobile recharge', 'Bills', 'Mobile', 2500, '', '', 'all', ''],
    ['us', 'Subscriptions', 'Subscriptions', '', 5230, '', '', 'all', ''],
    ['us', 'Electricity', 'Bills', 'Electricity', '', '', '', 'all', ''],
    ['us', 'Gas', 'Bills', 'Gas', '', '', '', 'all', ''],
  ];
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
  try {
    ensureSchema_(false);
    if (req.action === 'join') return json_(join_(req));

    const user = auth_(req.key);
    if (!user) return json_({ ok: false, error: 'Invalid key' });
    const admin = user.role === 'admin';

    switch (req.action) {
      case 'config':  return json_({ ok: true, user: user.name, role: user.role, config: config_(user) });
      case 'list':    return json_({ ok: true, ...list_(req.month, user) });
      case 'save':    return json_({ ok: true, saved: save_(req.entries || [], user) });
      case 'members': return json_(admin ? { ok: true, members: members_() } : denied_());
      case 'invite':  return json_(admin ? { ok: true, ...invite_(req.name, req.role) } : denied_());
      case 'remove':  return json_(admin ? { ok: true, ...remove_(req.name, user) } : denied_());
      case 'archive_all': return json_(admin ? { ok: true, archived: archiveAll_() } : denied_());
      default:        return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// ---------- people ----------

function auth_(key) {
  if (!key || typeof key !== 'string' || key.length < 20) return null;
  const h = hash_(key);
  const hit = rows_(sheetOf_(TAB.users)).find(r => r.key_hash === h && r.status === 'active');
  return hit ? { name: String(hit.name), role: String(hit.role) } : null;
}

function members_() {
  return rows_(sheetOf_(TAB.users)).map(r => ({
    name: String(r.name), role: String(r.role), status: String(r.status),
    joined_at: String(r.joined_at || ''), invite_expires: String(r.invite_expires || ''),
  }));
}

/** Create or refresh an invite. Re-inviting someone disconnects their old phone. */
function invite_(name, role) {
  name = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z .'-]{0,29}$/.test(name)) throw new Error('Use a short name, letters only');
  if (!['admin', 'team', 'mom', 'dad'].includes(role)) throw new Error('Bad role');
  const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000).padStart(6, '0');
  const expires = new Date(Date.now() + INVITE_HOURS * 3600 * 1000).toISOString();
  withUserRow_(name, (row, isNew) => {
    row.role = isNew ? role : (row.role === 'admin' ? 'admin' : role);
    row.key_hash = '';
    row.status = 'invited';
    row.invite_hash = hash_(code);
    row.invite_expires = expires;
    row.invite_attempts = 0;
  });
  return { name, code, expires };
}

function join_(req) {
  const name = String(req.name || '').trim();
  const code = String(req.code || '').trim();
  if (!name || !/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code' };
  let result;
  withUserRow_(name, (row, isNew) => {
    if (isNew || row.status !== 'invited') { result = { ok: false, error: 'This invite was already used or replaced. Ask Hari for a new one.' }; return false; }
    if (new Date(row.invite_expires) < new Date()) { result = { ok: false, error: 'This invite has expired. Ask Hari for a new one.' }; return false; }
    if (Number(row.invite_attempts) >= MAX_CODE_TRIES) { result = { ok: false, error: 'Too many wrong tries. Ask Hari for a new invite.' }; return false; }
    if (hash_(code) !== row.invite_hash) {
      row.invite_attempts = Number(row.invite_attempts || 0) + 1;
      const left = MAX_CODE_TRIES - row.invite_attempts;
      result = { ok: false, error: left > 0 ? `Wrong code. ${left} tries left.` : 'Too many wrong tries. Ask Hari for a new invite.' };
      return true;
    }
    const key = newKey_();
    row.key_hash = hash_(key);
    row.status = 'active';
    row.invite_hash = '';
    row.invite_expires = '';
    row.invite_attempts = 0;
    row.joined_at = new Date().toISOString();
    result = { ok: true, key, user: String(row.name), role: String(row.role) };
    return true;
  }, false);
  if (result.ok) result.config = config_({ name: result.user, role: result.role });
  return result;
}

function remove_(name, admin) {
  name = String(name || '').trim();
  if (name.toLowerCase() === admin.name.toLowerCase()) throw new Error("You can't remove yourself");
  let found = false;
  withUserRow_(name, (row, isNew) => {
    if (isNew) return false;
    found = true;
    row.key_hash = '';
    row.status = 'removed';
    row.invite_hash = '';
    row.invite_expires = '';
    return true;
  }, false);
  if (!found) throw new Error('No such person');
  return { name };
}

/** Run fn on the Users row for name (case-insensitive). fn returns false to skip writing. */
function withUserRow_(name, fn, createIfMissing = true) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheetOf_(TAB.users);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    let idx = values.findIndex((r, i) => i > 0 && String(r[0]).toLowerCase() === name.toLowerCase());
    const isNew = idx < 0;
    if (isNew && !createIfMissing) {
      fn({}, true);
      return;
    }
    const row = isNew ? { name } : Object.fromEntries(head.map((h, i) => [h, values[idx][i]]));
    if (fn(row, isNew) === false) return;
    const out = USER_COLS.map(c => row[c] ?? '');
    if (isNew) sh.getRange(sh.getLastRow() + 1, 1, 1, USER_COLS.length).setValues([out]);
    else sh.getRange(idx + 1, 1, 1, USER_COLS.length).setValues([out]);
  } finally {
    lock.releaseLock();
  }
}

// ---------- entries ----------

function config_(user) {
  const team = TEAM.includes(user.role);
  const cats = rows_(sheetOf_(TAB.cats))
    .filter(r => team || r.account === 'mom')
    .map(r => ({
      account: r.account, type: r.type, name: String(r.name), top: r.top === 'yes',
      subs: String(r.subs || '').split(',').map(s => s.trim()).filter(Boolean),
      sub_required: r.sub_required === 'yes', hint: String(r.hint || ''),
    }));
  const fixed = team ? rows_(sheetOf_(TAB.fixed)).map(r => ({
    account: r.account, name: String(r.name), category: String(r.category), sub: String(r.sub || ''),
    amount: Number(r.amount) || 0, per_unit: Number(r.per_unit) || 0, unit: String(r.unit || ''),
    months: r.months || 'all', paid_by_me: r.paid_by_me === 'yes',
  })) : [];
  return { categories: cats, fixed };
}

function visible_(r, user) {
  if (TEAM.includes(user.role)) return true;
  if (r.account !== 'mom') return false;
  return !(user.role === 'dad' && r.private);
}

/** Entries for one month (YYYY-MM) plus each pot's carried-forward balance before that month. */
function list_(month, user) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const all = rows_(sheetOf_(TAB.tx))
    .filter(r => r.deleted !== true && r.deleted !== 'TRUE')
    .map(clean_)
    .filter(r => visible_(r, user));
  const pots = user.role === 'dad' ? ['dad'] : ['team', 'dad'];
  const carry = Object.fromEntries(pots.map(p => [p, 0]));
  const entries = [];
  all.forEach(r => {
    const m = r.date.slice(0, 7);
    if (m === month) entries.push(r);
    else if (m < month && r.account === 'mom' && r.pot in carry) {
      if (r.type === 'in') carry[r.pot] += r.amount;
      else if (!r.paid_by_me) carry[r.pot] -= r.amount;
    }
  });
  Object.keys(carry).forEach(p => { carry[p] = Math.round(carry[p] * 100) / 100; });
  entries.sort((a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at));
  return { month, carry, entries };
}

/** Insert or update by id (client generates ids, so retries from the offline queue are safe). */
function save_(entries, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheetOf_(TAB.tx);
    const last = sh.getLastRow();
    const existing = last > 1 ? sh.getRange(2, 1, last - 1, TX_COLS.length).getValues() : [];
    const rowOf = new Map(existing.map((r, i) => [String(r[0]), i]));
    const roles = Object.fromEntries(rows_(sheetOf_(TAB.users)).map(r => [String(r.name), String(r.role)]));
    const col = c => TX_COLS.indexOf(c);
    const now = new Date().toISOString();
    const appends = new Map();
    const saved = [];

    entries.forEach(e => {
      const v = validate_(e, user);
      if (appends.has(v.id)) {
        const prev = appends.get(v.id);
        appends.set(v.id, toRow_(v, prev[col('logged_by')], prev[col('created_at')], now, prev[col('pot')]));
      } else if (rowOf.has(v.id)) {
        const i = rowOf.get(v.id);
        const old = existing[i];
        if (!canEdit_(user, String(old[col('logged_by')]), roles)) throw new Error('You can only change your own entries');
        const row = toRow_(v, old[col('logged_by')], old[col('created_at')], now, old[col('pot')] || 'team');
        sh.getRange(i + 2, 1, 1, TX_COLS.length).setValues([row]);
      } else {
        appends.set(v.id, toRow_(v, user.name, v.created_at || now, now, potFor_(user.role)));
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

function canEdit_(user, loggedBy, roles) {
  if (user.role === 'admin' || loggedBy === user.name) return true;
  return user.role === 'team' && TEAM.includes(roles[loggedBy]);
}

function potFor_(role) {
  return TEAM.includes(role) ? 'team' : role;
}

function archiveAll_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheetOf_(TAB.tx);
    const n = sh.getLastRow() - 1;
    if (n < 1) return 0;
    const rows = sh.getRange(2, 1, n, TX_COLS.length).getValues();
    const ar = sheetOf_(TAB.archive);
    ar.getRange(ar.getLastRow() + 1, 1, n, TX_COLS.length).setValues(rows);
    sh.deleteRows(2, n);
    return n;
  } finally {
    lock.releaseLock();
  }
}

// ---------- helpers ----------

function validate_(e, user) {
  const id = String(e.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('Bad id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) throw new Error('Bad date');
  if (!['mom', 'us'].includes(e.account)) throw new Error('Bad account');
  if (!['in', 'out'].includes(e.type)) throw new Error('Bad type');
  const team = TEAM.includes(user.role);
  if (!team && e.account !== 'mom') throw new Error('Not allowed');
  const amount = Number(e.amount);
  if (!(amount > 0) || amount > 10000000) throw new Error('Bad amount');
  return {
    id, date: e.date, account: e.account, type: e.type, amount: Math.round(amount * 100) / 100,
    category: String(e.category || 'Other').slice(0, 60),
    sub: String(e.sub || '').slice(0, 60),
    note: String(e.note || '').slice(0, 200),
    mode: e.mode === 'cash' ? 'cash' : 'upi',
    paid_by_me: team && e.account === 'mom' && e.type === 'out' && e.paid_by_me === true,
    private: e.account === 'mom' && user.role !== 'dad' && e.private === true,
    deleted: e.deleted === true,
    created_at: e.created_at,
  };
}

function toRow_(v, loggedBy, createdAt, updatedAt, pot) {
  return [v.id, v.date, v.account, v.type, v.amount, v.category, v.note, v.mode,
          v.paid_by_me, loggedBy, createdAt, updatedAt, v.deleted, v.private, v.account === 'mom' ? pot : '', v.sub];
}

function clean_(r) {
  const date = r.date instanceof Date
    ? Utilities.formatDate(r.date, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : String(r.date);
  const bool = x => x === true || x === 'TRUE';
  return {
    id: String(r.id), date, account: r.account, type: r.type, amount: Number(r.amount),
    category: String(r.category), sub: String(r.sub || ''), note: String(r.note || ''), mode: r.mode,
    paid_by_me: bool(r.paid_by_me), private: bool(r.private),
    pot: r.account === 'mom' ? (r.pot || 'team') : '',
    logged_by: String(r.logged_by), created_at: String(r.created_at),
  };
}

function denied_() {
  return { ok: false, error: 'Only Hari can do that' };
}

function sheetOf_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

function rows_(sh) {
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.filter(r => r.some(c => c !== '')).map(r =>
    Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function sheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) setHeader_(sh, headers);
  return sh;
}

function setHeader_(sh, headers) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

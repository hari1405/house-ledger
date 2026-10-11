// Backend tests against the local mock server: node dev/api-test.js [port]
const fs = require('fs');
const path = require('path');
const port = Number(process.argv[2]) || 8788;
const URL_ = `http://localhost:${port}/exec`;
const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '.keys.json'), 'utf8'));

let pass = 0, fail = 0;
const call = async body => (await fetch(URL_, { method: 'POST', body: JSON.stringify(body) })).json();
const check = (name, cond, extra = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`);
};
const id = s => `t${s}`.padEnd(10, '0');
const e = (i, o) => ({ id: id(i), date: '2026-11-03', account: 'mom', type: 'out', amount: 100, category: 'Medicines', ...o });

(async () => {
  const hari = keys.Hari, harini = keys.Harini;

  // migration + v1 keys still work
  let r = await call({ key: hari, action: 'config' });
  check('v1 key works after migration (Hari = admin)', r.ok && r.role === 'admin', r);
  check('categories have Baby subcategories', r.config.categories.some(c => c.name === 'Baby' && c.subs.includes('Feeding') && c.sub_required));
  check('fixed list has us + mom items', r.config.fixed.some(f => f.account === 'us') && r.config.fixed.some(f => f.account === 'mom'));
  r = await call({ key: harini, action: 'config' });
  check('Harini = team', r.ok && r.role === 'team', r);
  r = await call({ key: harini, action: 'members' });
  check('team cannot list members', !r.ok, r);

  // invites
  const momInv = await call({ key: hari, action: 'invite', name: 'Mom', role: 'mom' });
  const dadInv = await call({ key: hari, action: 'invite', name: 'Dad', role: 'dad' });
  check('invite returns 6-digit code', /^\d{6}$/.test(momInv.code) && /^\d{6}$/.test(dadInv.code), [momInv, dadInv]);
  r = await call({ key: harini, action: 'invite', name: 'X', role: 'dad' });
  check('team cannot invite', !r.ok, r);
  r = await call({ action: 'join', name: 'Mom', code: '000000' === momInv.code ? '111111' : '000000' });
  check('wrong code rejected with tries left', !r.ok && /4 tries left/.test(r.error), r);
  r = await call({ action: 'join', name: 'Nobody', code: '123456' });
  check('unknown name rejected', !r.ok, r);
  const mom = await call({ action: 'join', name: 'mom', code: momInv.code });
  check('Mom joins (case-insensitive name)', mom.ok && mom.role === 'mom' && mom.key.length === 64, mom);
  check('Mom config hides us categories and fixed', mom.config.categories.every(c => c.account === 'mom') && mom.config.fixed.length === 0);
  r = await call({ action: 'join', name: 'Mom', code: momInv.code });
  check('code is single use', !r.ok, r);
  const dad = await call({ action: 'join', name: 'Dad', code: dadInv.code });
  check('Dad joins', dad.ok && dad.role === 'dad', dad);

  // lockout after 5 wrong tries
  const tmp = await call({ key: hari, action: 'invite', name: 'Temp', role: 'dad' });
  const wrong = tmp.code === '999999' ? '999998' : '999999';
  for (let i = 0; i < 5; i++) r = await call({ action: 'join', name: 'Temp', code: wrong });
  r = await call({ action: 'join', name: 'Temp', code: tmp.code });
  check('right code refused after 5 wrong tries', !r.ok && /Too many/.test(r.error), r);

  // keys are hashed in the sheet
  const users = await (await fetch(`http://localhost:${port}/__dump?tab=Users`)).json();
  check('no plain keys stored', !JSON.stringify(users).includes(mom.key) && !JSON.stringify(users).includes(hari));

  // saving with role rules
  r = await call({ key: hari, action: 'save', entries: [
    e(1, { type: 'in', amount: 75000, category: 'From Mom' }),
    e(2, { amount: 54000, category: 'Nursing and care staff' }),
    e(3, { amount: 2500, category: 'Family and giving', private: true }),
    e(4, { amount: 30000, category: 'Rent', paid_by_me: true }),
    e(5, { account: 'us', amount: 1800, category: 'Baby', sub: 'Diapers and wipes' }),
    { ...e(15, { amount: 900, category: 'Medicines' }), date: '2026-10-20' },
  ] });
  check('Hari saves 6 entries', r.ok && r.saved.length === 6, r);
  r = await call({ key: dad.key, action: 'save', entries: [
    e(6, { type: 'in', amount: 5000, category: 'From Mom' }),
    e(7, { amount: 450, category: 'Groceries and milk', note: 'vegetables', private: true, paid_by_me: true }),
  ] });
  check('Dad saves 2 entries', r.ok, r);
  r = await call({ key: dad.key, action: 'save', entries: [e(8, { account: 'us', category: 'Baby' })] });
  check('Dad cannot write to Us', !r.ok, r);
  r = await call({ key: mom.key, action: 'save', entries: [e(9, { amount: 300, category: 'Medicines', private: true })] });
  check('Mom saves a private entry', r.ok, r);
  r = await call({ key: dad.key, action: 'save', entries: [e(2, { amount: 1 })] });
  check("Dad cannot edit Hari's entry", !r.ok && /own entries/.test(r.error), r);
  r = await call({ key: harini, action: 'save', entries: [e(2, { amount: 55000, category: 'Nursing and care staff' })] });
  check("Harini can edit Hari's entry (same team)", r.ok, r);
  r = await call({ key: harini, action: 'save', entries: [e(9, { amount: 1 })] });
  check("Harini cannot edit Mom's entry", !r.ok, r);

  // visibility + pots
  const L = async (k, m = '2026-11') => call({ key: k, action: 'list', month: m });
  const dadView = await L(dad.key);
  const ids = x => x.entries.map(v => v.id).sort().join(',');
  check('Dad sees no private and no Us', !dadView.entries.some(v => v.private || v.account === 'us'), dadView.entries);
  check('Dad sees his entries + team non-private', ids(dadView) === [id(1), id(2), id(4), id(6), id(7)].sort().join(','), ids(dadView));
  const dadOwn = dadView.entries.find(v => v.id === id(7));
  check("Dad's entry: pot dad, private and paid_by_me stripped", dadOwn.pot === 'dad' && !dadOwn.private && !dadOwn.paid_by_me, dadOwn);
  check('Dad gets only his own carry', Object.keys(dadView.carry).join() === 'dad', dadView.carry);
  const momView = await L(mom.key);
  check('Mom sees private, not Us', momView.entries.some(v => v.private) && !momView.entries.some(v => v.account === 'us'));
  check('Mom gets team + dad carry', 'team' in momView.carry && 'dad' in momView.carry);
  const teamView = await L(harini);
  check('Harini sees everything incl. Us', teamView.entries.length === 8, teamView.entries.length);

  // carry into December: team = 75000 - 55000 - 2500 (private counts) - 900 (Oct) ; rent paid_by_me excluded; dad = 5000 - 450
  const dec = await L(hari, '2026-12');
  check('team carry into Dec = 16600', dec.carry.team === 16600, dec.carry);
  check('dad carry into Dec = 4550', dec.carry.dad === 4550, dec.carry);
  const nov = await L(hari);
  check('Oct entry carried into Nov team = -900', nov.carry.team === -900, nov.carry);

  // remove + archive
  r = await call({ key: hari, action: 'remove', name: 'Dad' });
  check('Hari removes Dad', r.ok, r);
  r = await call({ key: dad.key, action: 'config' });
  check("Dad's key stops working", !r.ok, r);
  r = await call({ key: hari, action: 'remove', name: 'Hari' });
  check('Hari cannot remove himself', !r.ok, r);
  const mem = await call({ key: hari, action: 'members' });
  check('members lists statuses', mem.members.find(m => m.name === 'Dad').status === 'removed' && mem.members.find(m => m.name === 'Temp').status === 'invited', mem.members);
  r = await call({ key: harini, action: 'archive_all' });
  check('team cannot archive', !r.ok, r);
  r = await call({ key: hari, action: 'archive_all' });
  check('archive moves all rows', r.ok && r.archived === 9, r);
  check('after archive, list is empty', (await L(hari)).entries.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

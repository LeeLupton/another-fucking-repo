// The money stores: what a row has to carry to be trusted, writes that land together, an account deleted with what
// was recorded under it, and backups that carry the whole household out and back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
require('../js/store.js');
const Schema = require('../js/schema.js');
const M = require('../js/money.js');
const DB = globalThis.ItemizerStore;
const STORE = require.resolve('../js/store.js');

const acct = { id: 'a1', name: 'Everyday Checking', type: 'checking', institution: 'Coastal Federal', mask: '000123454821' };
const t1 = { id: 'x1', accountId: 'a1', date: '2026-10-01', amount: -23.456, merchant: 'Blue Ocean Coffee', original: 'SQ *BLUE OCEAN', categoryId: 'coffee', tags: ['work', 'work', ''], reviewed: true };

test('accounts keep the last four digits only, and need a name and a known type', () => {
  const a = DB.sanitizeAccount(acct);
  assert.equal(a.mask, '4821');
  assert.ok(!JSON.stringify(a).includes('123454821'));
  assert.equal(DB.sanitizeAccount(Object.assign({}, acct, { type: 'yacht' })), null);
  assert.equal(DB.sanitizeAccount(Object.assign({}, acct, { name: '  ' })), null);
  assert.equal(DB.sanitizeAccount(Object.assign({}, acct, { id: '__proto__' })), null);
  assert.equal(DB.sanitizeAccount(Object.assign({}, acct, { importKey: 'ofx-abc123' })).importKey, 'ofx-abc123');
  assert.equal(DB.sanitizeAccount(Object.assign({}, acct, { importKey: '000123454821' })).importKey, '', 'only a hash can stand for the number');
  for (const type of M.ACCOUNT_TYPES.map((t) => t.id)) assert.ok(DB.sanitizeAccount(Object.assign({}, acct, { type })), type);
});

test('transactions round to the cent, dedupe their tags, and keep splits only when they add up', () => {
  const t = DB.sanitizeTransaction(t1);
  assert.equal(t.amount, -23.46);
  assert.deepEqual(t.tags, ['work']);
  assert.equal(t.source, 'manual');
  assert.equal(DB.sanitizeTransaction(Object.assign({}, t1, { date: '2026-13-01' })), null);
  assert.equal(DB.sanitizeTransaction(Object.assign({}, t1, { amount: 'lots' })), null);
  assert.equal(DB.sanitizeTransaction(Object.assign({}, t1, { amount: 1e12 })), null);
  assert.equal(DB.sanitizeTransaction(Object.assign({}, t1, { categoryId: '<script>' })).categoryId, 'uncategorized');
  const good = DB.sanitizeTransaction(Object.assign({}, t1, { amount: -100, splits: [{ categoryId: 'groceries', amount: -60 }, { categoryId: 'clothing', amount: -40 }] }));
  assert.equal(good.splits.length, 2);
  const bad = DB.sanitizeTransaction(Object.assign({}, t1, { amount: -100, splits: [{ categoryId: 'groceries', amount: -60 }, { categoryId: 'clothing', amount: -39 }] }));
  assert.equal(bad.splits, undefined);
  for (const s of M.DEFAULT_CATEGORIES) assert.equal(DB.sanitizeTransaction(Object.assign({}, t1, { categoryId: s.id })).categoryId, s.id);
});

test('the other money rows are checked the same way', () => {
  assert.deepEqual(DB.sanitizeRow('balances', { accountId: 'a1', date: '2026-10-01', balance: '9197.204' }), { id: 'a1:2026-10-01', accountId: 'a1', date: '2026-10-01', balance: 9197.2, source: 'manual' });
  assert.equal(DB.sanitizeRow('budgets', { month: '2026-10', categoryId: 'groceries', amount: -5 }), null);
  assert.equal(DB.sanitizeRow('budgets', { month: '2026-10', categoryId: '__flexible', amount: 1450 }).id, '2026-10:__flexible');
  assert.equal(DB.sanitizeRow('categories', { id: 'c1', custom: true, name: 'Boat' }), null, 'a custom category needs a group');
  assert.deepEqual(DB.sanitizeRow('categories', { id: 'coffee', name: 'Caffeine', rollover: 1, updatedAt: 'x' }), { id: 'coffee', name: 'Caffeine', rollover: true, updatedAt: 'x' });
  assert.equal(DB.sanitizeRow('rules', { id: 'r1', when: { text: 'venmo' }, then: {} }), null, 'a rule that does nothing is refused');
  const rule = DB.sanitizeRow('rules', { id: 'r1', when: { field: 'nope', op: 'regex', text: ' venmo ', min: '-4', max: '200' }, then: { categoryId: 'gifts', addTags: ['a', 'a'] } });
  assert.deepEqual(rule.when, { field: 'any', op: 'contains', text: 'venmo', sign: '', min: null, max: 200, accountId: '' });
  assert.deepEqual(rule.then.addTags, ['a']);
  assert.equal(DB.sanitizeRow('goals', { id: 'g1', name: 'Fund', target: 1000, accountIds: ['a1', 'a1', 'bad id!'], contributions: [{ date: '2026-01-01', amount: 50 }, { date: 'x', amount: 1 }] }).contributions.length, 1);
  assert.deepEqual(DB.sanitizeRow('goals', { id: 'g1', name: 'Fund', target: 1000, accountIds: ['a1', 'a1', 'bad id!'] }).accountIds, ['a1']);
  assert.equal(DB.sanitizeRow('holdings', { id: 'h1', accountId: 'b', symbol: 'vti', shares: 3, price: -1 }), null);
  assert.equal(DB.sanitizeRow('holdings', { id: 'h1', accountId: 'b', symbol: 'vti', shares: 3, price: 300, assetClass: 'beanie babies' }).assetClass, 'other');
  assert.equal(DB.sanitizeRow('recurring', { id: 'netflix|out', status: 'ignored' }).status, 'ignored');
  assert.equal(DB.sanitizeRow('recurring', { id: '__proto__', status: 'ignored' }), null);
  assert.equal(DB.sanitizeRow('recurring', { id: M.streamKey('Netflix', 'out') }).id, 'netflix|out');
  const settings = DB.sanitizeSettings({ budgetMode: 'zero-based' });
  assert.equal(settings.budgetMode, 'category');
  assert.equal(DB.sanitizeSettings({ budgetMode: 'flex' }).budgetMode, 'flex');
});

test('a batch across the money stores lands whole, and a bad row refuses all of it', async () => {
  await DB.clearAll();
  await DB.writeMoney({ put: { accounts: [acct], transactions: [t1], balances: [{ accountId: 'a1', date: '2026-10-01', balance: 100 }] } });
  let money = await DB.getMoney();
  assert.equal(money.accounts.length, 1); assert.equal(money.transactions.length, 1); assert.equal(money.balances.length, 1);
  await assert.rejects(() => DB.writeMoney({ put: { transactions: [Object.assign({}, t1, { id: 'x2' }), { id: 'x3' }] } }), /transaction could not be saved/);
  money = await DB.getMoney();
  assert.equal(money.transactions.length, 1, 'the good row of a refused batch was not written either');
  await assert.rejects(() => DB.writeMoney({ put: { entries: [] } }), /Not a money store/);
  await DB.writeMoney({ delete: { transactions: ['x1'] }, put: { transactions: [Object.assign({}, t1, { id: 'x9' })] } });
  assert.deepEqual((await DB.getMoney()).transactions.map((t) => t.id), ['x9']);
});

test('deleting an account takes its transactions, balances, and holdings, and lets go of it in goals', async () => {
  await DB.clearAll();
  await DB.writeMoney({ put: {
    accounts: [acct, Object.assign({}, acct, { id: 'a2', name: 'Savings', type: 'savings' })],
    transactions: [t1, Object.assign({}, t1, { id: 'x2', accountId: 'a2' })],
    balances: [{ accountId: 'a1', date: '2026-10-01', balance: 1 }, { accountId: 'a2', date: '2026-10-01', balance: 2 }],
    holdings: [{ id: 'h1', accountId: 'a1', symbol: 'VTI', shares: 1, price: 1 }],
    goals: [{ id: 'g1', name: 'Fund', target: 10, accountIds: ['a1', 'a2'] }],
  } });
  const gone = await DB.deleteAccount('a1');
  assert.equal(gone.transactions.length, 1);
  const money = await DB.getMoney();
  assert.deepEqual(money.accounts.map((a) => a.id), ['a2']);
  assert.deepEqual(money.transactions.map((t) => t.id), ['x2']);
  assert.deepEqual(money.balances.map((b) => b.accountId), ['a2']);
  assert.equal(money.holdings.length, 0);
  assert.deepEqual(money.goals[0].accountIds, ['a2']);
});

test('a backup carries the whole household out and back; a version-3 file leaves the money alone', async () => {
  await DB.clearAll();
  const sample = M.sampleData('2026-10-14');
  await DB.writeMoney({ put: { accounts: sample.accounts, transactions: sample.transactions, balances: sample.balances, holdings: sample.holdings, goals: sample.goals, budgets: sample.budgets, categories: [{ id: 'coffee', name: 'Caffeine' }], rules: [{ id: 'r1', when: { text: 'venmo' }, then: { categoryId: 'gifts' } }], recurring: [{ id: 'netflix|out', status: 'confirmed' }] } });
  await DB.putEntry({ id: 'e1', date: '2026-10-01', taxYear: 2026, lineId: 'med.prescriptions', amount: 12, txId: 'sample-tx-1' });
  const out = await DB.exportJSON();
  assert.equal(out.transactions.length, sample.transactions.length);
  assert.equal(out.entries[0].txId, 'sample-tx-1');
  await DB.clearAll();
  const res = await DB.importJSON(JSON.parse(JSON.stringify(out)), { schema: Schema });
  assert.equal(res.money.transactions, sample.transactions.length);
  assert.equal(res.money.accounts, sample.accounts.length);
  const back = await DB.getMoney();
  assert.equal(back.balances.length, sample.balances.length);
  assert.equal(back.categories[0].name, 'Caffeine');
  assert.equal((await DB.getEntries())[0].txId, 'sample-tx-1');
  // an older backup has no money in it, and restoring it does not take the money away
  await DB.importJSON({ app: 'itemizer', version: 3, entries: [{ id: 'e2', date: '2026-01-06', taxYear: 2026, lineId: 'med.doctor', amount: 2 }] }, { schema: Schema });
  assert.equal((await DB.getMoney()).transactions.length, sample.transactions.length);
  // a replace takes the money records the file does not carry, but keeps what the app has learned
  await DB.importJSON({ app: 'itemizer', version: 4, entries: [], accounts: [acct] }, { replace: true, schema: Schema });
  const after = await DB.getMoney();
  assert.deepEqual(after.accounts.map((a) => a.id), ['a1']);
  assert.equal(after.transactions.length, 0);
  assert.equal(after.categories.length, 1);
  assert.equal(after.rules.length, 1);
});

test('a ledger-only wipe takes the records and keeps the categories, rules, and recurring choices', async () => {
  await DB.clearAll();
  await DB.writeMoney({ put: { accounts: [acct], transactions: [t1], categories: [{ id: 'coffee', name: 'Caffeine' }], rules: [{ id: 'r1', when: { text: 'venmo' }, then: { hide: true } }] } });
  await DB.clearAll({ keepSettings: true });
  const m = await DB.getMoney();
  assert.equal(m.accounts.length, 0); assert.equal(m.transactions.length, 0);
  assert.equal(m.categories.length, 1); assert.equal(m.rules.length, 1);
});

test('a version-3 database opens as version 4 with every old row in place and the money stores added', () => {
  // a fake IndexedDB in the child: enough of the API for an upgrade from 3 to 4 to run its onupgradeneeded
  const setup = `
    const stores = new Map([['entries', new Map([['e1', { id: 'e1', date: '2026-01-05', lineId: 'med.doctor', amount: 5 }]])], ['settings', new Map()]]);
    const names = () => ({ contains: (n) => stores.has(n) });
    function os(name) { const m = stores.get(name); return { indexNames: { contains: () => false }, createIndex() {}, getAll() { const r = { result: Array.from(m.values()) }; setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; }, get(k) { const r = { result: m.get(k) }; setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; }, put(v) { m.set(v.id || v.key, v); }, getAllKeys() { return { result: Array.from(m.keys()) }; } }; }
    const db = { objectStoreNames: names(), createObjectStore(n) { stores.set(n, new Map()); return os(n); }, transaction(list) { const t = { objectStore: os, oncomplete: null }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return t; }, close() {} };
    globalThis.indexedDB = { open(name, version) { const req = { result: db, transaction: { objectStore: os } }; setTimeout(() => { req.onupgradeneeded({ oldVersion: 3, newVersion: version }); req.onsuccess(); }, 0); return req; } };
    globalThis.__stores = stores;`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `${setup}\nrequire(${JSON.stringify(STORE)});\nconst DB = globalThis.ItemizerStore;\n(async () => { await DB.openDB(); process.stdout.write(JSON.stringify({ names: Array.from(globalThis.__stores.keys()), entry: globalThis.__stores.get('entries').get('e1') })); })().catch((e) => { console.error(e); process.exit(1); });`], { encoding: 'utf8' }));
  for (const store of DB.MONEY_STORES) assert.ok(out.names.includes(store), store);
  assert.equal(out.entry.amount, 5);
});

test('a batch that touches one store is written through IndexedDB too, not only when it spans several', () => {
  // a fake IndexedDB in the child that keeps every put, to check the single-store path reaches the object store by name
  const setup = `
    const stores = new Map();
    const names = () => ({ contains: (n) => stores.has(n) });
    function os(name) { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return { indexNames: { contains: () => true }, createIndex() {}, put(v) { m.set(v.id || v.key, v); }, delete(k) { m.delete(k); }, getAll() { const r = { result: Array.from(m.values()) }; return r; }, getAllKeys() { return { result: Array.from(m.keys()) }; } }; }
    const db = { objectStoreNames: names(), createObjectStore(n) { stores.set(n, new Map()); return os(n); }, transaction() { const t = { objectStore: os }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return t; }, close() {} };
    globalThis.indexedDB = { open() { const req = { result: db, transaction: { objectStore: os } }; setTimeout(() => { req.onupgradeneeded({ oldVersion: 0 }); req.onsuccess(); }, 0); return req; } };
    globalThis.__stores = stores;`;
  const body = `await DB.openDB(); await DB.writeMoney({ put: { budgets: [{ month: '2026-10', categoryId: 'groceries', amount: 600 }] } }); await DB.writeMoney({ delete: { goals: ['none'] } }); return Array.from(globalThis.__stores.get('budgets').values());`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `${setup}\nrequire(${JSON.stringify(STORE)});\nconst DB = globalThis.ItemizerStore;\n(async () => { const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out)); })().catch((e) => { console.error(e); process.exit(1); });`], { encoding: 'utf8' }));
  assert.deepEqual(out, [{ id: '2026-10:groceries', month: '2026-10', categoryId: 'groceries', amount: 600 }]);
});

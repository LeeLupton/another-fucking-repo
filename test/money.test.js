const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/money.js');

const CATS = M.effectiveCategories([]);
const IDX = M.categoryIndex(CATS);
let n = 0;
const tx = (date, amount, merchant, categoryId, extra) => Object.assign({ id: `t${++n}`, accountId: 'chk', date, amount, merchant, categoryId, tags: [], reviewed: true, hidden: false }, extra || {});

test('month arithmetic clamps to the month end and never drifts', () => {
  assert.equal(M.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(M.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(M.addMonths('2026-01-31', 2), '2026-03-31'); // from the anchor, not from Feb 28
  assert.equal(M.addMonthsYM('2026-11', 3), '2027-02');
  assert.equal(M.addMonthsYM('2026-01', -1), '2025-12');
  assert.deepEqual(M.monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(M.daysBetween('2026-03-07', '2026-03-09'), 2); // across a DST change, still whole days
  assert.equal(M.daysInMonth('2026-02'), 28);
  assert.equal(M.monthLabel('2026-10', { long: true, noYear: true }), 'October');
});

test('money prints whole dollars half away from zero, and compact figures for axes', () => {
  assert.equal(M.money(1234.5), '$1,235');
  assert.equal(M.money(-0.4), '$0');
  assert.equal(M.money(-1234.5), '-$1,235');
  assert.equal(M.money(19.995, { cents: true }), '$20.00');
  assert.equal(M.moneyCompact(950), '$950');
  assert.equal(M.moneyCompact(12900), '$13K');
  assert.equal(M.moneyCompact(4200), '$4.2K');
  assert.equal(M.moneyCompact(-1250000), '-$1.25M');
  assert.equal(M.cents(1.005), 1.01);
  assert.equal(M.cents(-2.675), -2.68);
});

test('statement lines become merchant names people recognise', () => {
  const cases = [
    ['SQ *BLUE OCEAN COFFEE 0042  MOREHEAD CITY NC', 'Blue Ocean Coffee'],
    ['PURCHASE AUTHORIZED ON 03/14 HARRIS TEETER #0123 MOREHEAD CITY NC', 'Harris Teeter'],
    ['POS DEBIT 1234 FOOD LION #2231 BEAUFORT NC', 'Food Lion'],
    ['AMZN Mktp US*2K4LL1', 'Amazon'],
    ['AMAZON PRIME*2K4LL1', 'Amazon Prime'],
    ['UBER   *EATS', 'Uber Eats'],
    ['UBER *TRIP HELP.UBER.COM', 'Uber'],
    ['CVS/PHARMACY #07741', 'CVS'],
    ['DIRECT DEP COASTAL LOGISTICS PAYROLL', 'Coastal Logistics Payroll'],
    ['ONLINE TRANSFER TO SAV ...9930', 'Transfer to Sav'],
    ['NETFLIX.COM', 'Netflix'],
    ['WWW.ETSY.COM', 'Etsy'],
    ["Joe's Crab Shack", "Joe's Crab Shack"], // a name already in mixed case is left as written
  ];
  for (const [raw, want] of cases) assert.equal(M.cleanMerchant(raw), want, raw);
  assert.equal(M.cleanMerchant(''), '');
  assert.equal(M.merchantKey('Food Lion'), M.merchantKey('FOOD-LION'));
});

test('categories come from keywords, the longest match winning, and the sign has a say', () => {
  const cat = (merchant, amount, extra) => M.suggestCategory(Object.assign({ merchant, original: merchant, amount }, extra || {}), { categories: CATS }).categoryId;
  assert.equal(cat('Food Lion', -82.1), 'groceries');
  assert.equal(cat('Uber Eats', -31), 'restaurants'); // "uber eats" beats "uber"
  assert.equal(cat('Uber', -18), 'rideshare');
  assert.equal(cat('Shell', -44), 'gas_fuel');
  assert.equal(cat('Shellfish Shack Seafood', -60), 'restaurants'); // "shell$" must end the word
  assert.equal(cat('Coastal Logistics Payroll', 2412.5), 'paycheck');
  assert.equal(cat('Coastal Logistics Payroll', -2412.5), 'uncategorized'); // a purchase never lands in income
  assert.equal(cat('Amazon', 24.99), 'shopping'); // a refund from a named shop goes back where the purchase went
  assert.equal(cat('Mystery Co', 50), 'other_income');
  assert.equal(cat('Mystery Co', -50), 'uncategorized');
  // money landing on a credit card is the payment, whatever the words
  assert.equal(M.suggestCategory({ merchant: 'Payment Thank You', amount: 500 }, { categories: CATS, account: { type: 'credit' } }).categoryId, 'cc_payment');
  assert.equal(M.suggestCategory({ merchant: 'Online Transfer', amount: 500 }, { categories: CATS, account: { type: 'credit' } }).categoryId, 'cc_payment');
});

test('a merchant filed before goes back where it was; a rule beats both', () => {
  const history = M.buildHistory([tx('2026-01-02', -40, 'Morning Tide', 'coffee'), tx('2026-01-09', -40, 'Morning Tide', 'coffee')]);
  const ctx = { categories: CATS, history };
  const s = M.suggestCategory({ merchant: 'Morning Tide', amount: -12 }, ctx);
  assert.equal(s.categoryId, 'coffee');
  assert.equal(s.source, 'history');
  const rules = [{ id: 'r1', order: 0, when: { field: 'merchant', op: 'contains', text: 'morning tide' }, then: { categoryId: 'restaurants' } }];
  const r = M.suggestCategory({ merchant: 'Morning Tide', amount: -12 }, Object.assign({ rules }, ctx));
  assert.equal(r.categoryId, 'restaurants');
  assert.equal(r.source, 'rule');
  // history never files a purchase under income
  const h2 = M.buildHistory([tx('2026-01-02', 900, 'Venmo Jim', 'other_income')]);
  assert.notEqual(M.suggestCategory({ merchant: 'Venmo Jim', amount: -20 }, { categories: CATS, history: h2 }).categoryId, 'other_income');
});

test('rules match on text, sign, amount range, and account, and the first rule wins each field', () => {
  const rule = { id: 'a', order: 0, when: { field: 'any', op: 'contains', text: 'zelle', sign: 'out', min: 50, max: 500, accountId: 'chk' }, then: { categoryId: 'rent', addTags: ['house'] } };
  assert.equal(M.ruleMatches(rule, { merchant: 'Zelle to Landlord', amount: -450, accountId: 'chk' }), true);
  assert.equal(M.ruleMatches(rule, { merchant: 'Zelle to Landlord', amount: 450, accountId: 'chk' }), false);
  assert.equal(M.ruleMatches(rule, { merchant: 'Zelle to Landlord', amount: -40, accountId: 'chk' }), false);
  assert.equal(M.ruleMatches(rule, { merchant: 'Zelle to Landlord', amount: -450, accountId: 'card' }), false);
  assert.equal(M.ruleMatches({ when: { field: 'merchant', op: 'is', text: 'zelle' } }, { merchant: 'Zelle to Landlord' }), false);
  assert.equal(M.ruleMatches({ when: { field: 'merchant', op: 'starts', text: 'zelle' } }, { merchant: 'Zelle to Landlord' }), true);
  assert.equal(M.ruleMatches({ when: { field: 'merchant', op: 'contains', text: '  ' } }, { merchant: 'x' }), false); // an empty rule matches nothing
  const second = { id: 'b', order: 1, when: { field: 'any', op: 'contains', text: 'landlord' }, then: { categoryId: 'misc', merchant: 'Landlord', addTags: ['rent'], review: true } };
  const { patch, fired } = M.applyRules({ merchant: 'Zelle to Landlord', amount: -450, accountId: 'chk', tags: [] }, [second, rule]);
  assert.equal(patch.categoryId, 'rent');
  assert.equal(patch.merchant, 'Landlord');
  assert.deepEqual(patch.tags.sort(), ['house', 'rent']);
  assert.equal(patch.reviewed, true);
  assert.deepEqual(fired, ['a', 'b']);
});

test('category edits lay over the built-ins; custom categories join them', () => {
  const cats = M.effectiveCategories([
    { id: 'coffee', name: 'Caffeine', rollover: true, budget: 'fixed' },
    { id: 'groceries', groupId: 'income' }, // an expense cannot be moved into an income group
    { id: 'uncategorized', hidden: true }, // the catch-all cannot be hidden
    { id: 'c-boat', name: 'Boat', groupId: 'lifestyle', custom: true },
    { id: 'paycheck', hidden: true },
  ]);
  const idx = M.categoryIndex(cats);
  assert.equal(idx.get('coffee').name, 'Caffeine');
  assert.equal(idx.get('coffee').rollover, true);
  assert.equal(idx.get('coffee').budget, 'fixed');
  assert.equal(idx.get('groceries').groupId, 'food');
  assert.equal(idx.get('uncategorized').hidden, false);
  assert.equal(idx.get('c-boat').kind, 'expense');
  assert.ok(idx.byGroup.get('lifestyle').some((c) => c.id === 'c-boat'));
  assert.equal(idx.get('nope').id, 'uncategorized'); // an id the list lacks reads as uncategorized
  // a hidden category is never suggested
  assert.notEqual(M.suggestCategory({ merchant: 'Payroll', amount: 900 }, { categories: cats }).categoryId, 'paycheck');
});

test('category names from another app map onto these', () => {
  assert.equal(M.categoryByName('Restaurants & Bars', CATS), 'restaurants');
  assert.equal(M.categoryByName('  coffee shops ', CATS), 'coffee');
  assert.equal(M.categoryByName('Gas & Fuel', CATS), 'gas_fuel');
  assert.equal(M.categoryByName('Credit Card Payment', CATS), 'cc_payment');
  assert.equal(M.categoryByName('Groceries', CATS), 'groceries');
  assert.equal(M.categoryByName('Boat Stuff', CATS), null);
  const renamed = M.effectiveCategories([{ id: 'coffee', name: 'Caffeine' }]);
  assert.equal(M.categoryByName('Caffeine', renamed), 'coffee');
});

test('a transfer seen from both ends pairs once, with the nearest date, across accounts', () => {
  const list = [
    tx('2026-03-01', -500, 'Transfer to Savings', 'uncategorized', { id: 'out1', accountId: 'chk' }),
    tx('2026-03-02', 500, 'Transfer from Checking', 'uncategorized', { id: 'in1', accountId: 'sav' }),
    tx('2026-03-05', 500, 'Transfer from Checking', 'uncategorized', { id: 'in2', accountId: 'sav' }),
    tx('2026-03-01', 500, 'Refund', 'uncategorized', { id: 'same', accountId: 'chk' }), // same account: not a transfer
    tx('2026-03-20', -500, 'Rent', 'rent', { id: 'far', accountId: 'chk' }), // too far from any 500 coming in
  ];
  assert.deepEqual(M.findTransferPairs(list), [['out1', 'in1']]);
});

test('splits count instead of the transaction, and must add up to the cent', () => {
  const t = tx('2026-03-03', -100, 'Target', 'shopping', { splits: [{ categoryId: 'groceries', amount: -60 }, { categoryId: 'clothing', amount: -40 }] });
  assert.deepEqual(M.linesOf(t).map((l) => l.categoryId), ['groceries', 'clothing']);
  assert.equal(M.splitsBalance(t, t.splits), true);
  assert.equal(M.splitsBalance(t, [{ amount: -60 }, { amount: -39.99 }]), false);
  const f = M.cashFlow([t], IDX, '2026-03-01', '2026-03-31');
  assert.equal(f.byCategory.get('groceries').spend, 60);
  assert.equal(f.byCategory.get('clothing').spend, 40);
  assert.equal(f.byCategory.has('shopping'), false);
});

test('a transaction account walks from its nearest balance; a manual account takes the figure entered', () => {
  const acct = { id: 'chk', type: 'checking' };
  const txs = [tx('2026-01-05', -100, 'A', 'misc'), tx('2026-01-10', 1000, 'Pay', 'paycheck'), tx('2026-01-20', -50, 'B', 'misc')];
  // no balance known: start from zero
  assert.equal(M.makeLedger(acct, txs, [], { today: '2026-01-31' }).at('2026-01-15'), 900);
  // a balance known after: walk back
  const after = M.makeLedger(acct, txs, [{ date: '2026-01-31', balance: 2000 }], { today: '2026-01-31' });
  assert.equal(after.at('2026-01-31'), 2000);
  assert.equal(after.at('2026-01-15'), 2050);
  assert.equal(after.at('2026-01-01'), 1150);
  // a balance known before: walk forward
  const before = M.makeLedger(acct, txs, [{ date: '2026-01-01', balance: 500 }], { today: '2026-01-31' });
  assert.equal(before.at('2026-01-10'), 1400);
  assert.equal(before.current, 1350);
  // the day of a snapshot already includes that day's transactions
  assert.equal(M.makeLedger(acct, txs, [{ date: '2026-01-10', balance: 3000 }], { today: '2026-01-31' }).at('2026-01-10'), 3000);
  const house = { id: 'h', type: 'property' };
  const L = M.makeLedger(house, txs, [{ date: '2026-01-01', balance: 400000 }, { date: '2026-06-01', balance: 410000 }], { today: '2026-07-01' });
  assert.equal(L.mode, 'manual');
  assert.equal(L.at('2025-12-01'), 400000); // before the first valuation, the first valuation
  assert.equal(L.at('2026-05-31'), 400000);
  assert.equal(L.at('2026-06-15'), 410000);
  // the holdings' value stands in for today
  assert.equal(M.makeLedger({ id: 'b', type: 'brokerage' }, [], [{ date: '2026-01-01', balance: 10 }], { today: '2026-07-01', current: 12345.67 }).current, 12345.67);
});

test('net worth adds assets and subtracts what is owed, leaving out excluded accounts', () => {
  const accounts = [{ id: 'chk', type: 'checking' }, { id: 'card', type: 'credit' }, { id: 'x', type: 'other_asset', excludeFromNetWorth: true }];
  const ledgers = {
    chk: M.makeLedger(accounts[0], [], [{ date: '2026-01-01', balance: 5000 }]),
    card: M.makeLedger(accounts[1], [], [{ date: '2026-01-01', balance: -1200 }]),
    x: M.makeLedger(accounts[2], [], [{ date: '2026-01-01', balance: 99999 }]),
  };
  const [p] = M.netWorthSeries(accounts, ledgers, ['2026-02-01']);
  assert.deepEqual(p, { date: '2026-02-01', assets: 5000, liabilities: 1200, net: 3800 });
  assert.deepEqual(M.monthEndDates('2026-10-14', 3), ['2026-08-31', '2026-09-30', '2026-10-14']);
});

test('cash flow counts income and spending, nets refunds, and leaves out transfers and hidden rows', () => {
  const list = [
    tx('2026-05-01', 3000, 'Payroll', 'paycheck'),
    tx('2026-05-02', -200, 'Food Lion', 'groceries'),
    tx('2026-05-03', 30, 'Food Lion', 'groceries'), // a refund
    tx('2026-05-04', -500, 'Transfer', 'transfer'),
    tx('2026-05-05', -999, 'Secret', 'shopping', { hidden: true }),
    tx('2026-06-01', -10, 'Later', 'misc'),
  ];
  const f = M.cashFlow(list, IDX, '2026-05-01', '2026-05-31');
  assert.equal(f.income, 3000);
  assert.equal(f.expenses, 170);
  assert.equal(f.net, 2830);
  assert.equal(Math.round(f.savingsRate * 1000), 943);
  assert.equal(f.byGroup.get('food').spend, 170);
  assert.equal(f.count, 3);
  assert.equal(M.cashFlow(list, IDX, '2026-05-01', '2026-05-31', { accountIds: ['card'] }).count, 0);
  const month = M.monthlyFlow(list, IDX, ['2026-05', '2026-06']);
  assert.deepEqual(month.map((m) => m.expenses), [170, 10]);
  assert.equal(M.cashFlow([], IDX, '2026-05-01', '2026-05-31').savingsRate, null);
});

test('spending adds up day by day and stops at today', () => {
  const list = [tx('2026-05-01', -10, 'A', 'misc'), tx('2026-05-03', -5, 'B', 'misc'), tx('2026-05-03', 100, 'Pay', 'paycheck'), tx('2026-05-04', -50, 'T', 'transfer')];
  const c = M.cumulativeSpend(list, IDX, '2026-05', '2026-05-04');
  assert.deepEqual(c.slice(0, 5), [10, 10, 15, 15, null]);
  assert.equal(c.length, 31);
});

test('a budget carries forward until it is changed, and 0 stops it', () => {
  const idx = M.budgetIndex([{ month: '2026-01', categoryId: 'groceries', amount: 600 }, { month: '2026-04', categoryId: 'groceries', amount: 650 }, { month: '2026-07', categoryId: 'groceries', amount: 0 }]);
  assert.deepEqual(M.budgetFor(idx, 'groceries', '2025-12'), { amount: 0, source: 'none' });
  assert.equal(M.budgetFor(idx, 'groceries', '2026-01').source, 'set');
  assert.deepEqual(M.budgetFor(idx, 'groceries', '2026-03'), { amount: 600, source: 'carried', from: '2026-01' });
  assert.equal(M.budgetFor(idx, 'groceries', '2026-05').amount, 650);
  assert.equal(M.budgetFor(idx, 'groceries', '2026-09').amount, 0);
});

test('the month budget shows planned, spent, left, and rollover', () => {
  const cats = M.effectiveCategories([{ id: 'restaurants', rollover: true, rolloverStart: '2026-03' }]);
  const index = M.categoryIndex(cats);
  const budgets = [
    { month: '2026-03', categoryId: 'groceries', amount: 600 },
    { month: '2026-03', categoryId: 'restaurants', amount: 200 },
    { month: '2026-03', categoryId: 'paycheck', amount: 5000 },
  ];
  const list = [
    tx('2026-03-05', -150, 'Diner', 'restaurants'), // 50 left in March
    tx('2026-04-05', -260, 'Diner', 'restaurants'), // 60 over in April
    tx('2026-05-02', -500, 'Food Lion', 'groceries'),
    tx('2026-05-03', -100, 'Diner', 'restaurants'),
    tx('2026-05-01', 4800, 'Payroll', 'paycheck'),
  ];
  const b = M.budgetMonth({ month: '2026-05', index, budgets, transactions: list, mode: 'category' });
  const row = (id) => b.expense.groups.flatMap((g) => g.rows).find((r) => r.category.id === id);
  assert.equal(row('groceries').planned, 600);
  assert.equal(row('groceries').source, 'carried');
  assert.equal(row('groceries').remaining, 100);
  assert.equal(row('restaurants').rollover, -10); // +50 from March, -60 from April
  assert.equal(row('restaurants').available, 190);
  assert.equal(row('restaurants').remaining, 90);
  assert.equal(b.income.planned, 5000);
  assert.equal(b.income.actual, 4800);
  assert.equal(b.expense.planned, 800);
  assert.equal(b.leftToBudget, 4200);
  assert.equal(b.hasBudget, true);
});

test('flex budgeting pools the flexible categories and rolls non-monthly ones over', () => {
  const budgets = [
    { month: '2026-01', categoryId: '__flexible', amount: 1000 },
    { month: '2026-01', categoryId: 'mortgage', amount: 1700 },
    { month: '2026-01', categoryId: 'travel', amount: 100 },
    { month: '2026-01', categoryId: 'groceries', amount: 600 }, // ignored in flex mode: groceries is in the pool
  ];
  const list = [tx('2026-03-02', -700, 'Food Lion', 'groceries'), tx('2026-03-02', -400, 'Diner', 'restaurants'), tx('2026-03-01', -1700, 'Mortgage', 'mortgage'), tx('2026-02-10', -50, 'Air', 'travel')];
  const b = M.budgetMonth({ month: '2026-03', index: IDX, budgets, transactions: list, mode: 'flex' });
  assert.equal(b.flex.flexible.planned, 1000);
  assert.equal(b.flex.flexible.actual, 1100);
  assert.equal(b.flex.flexible.remaining, -100);
  assert.equal(b.flex.fixed.planned, 1700);
  const travel = b.expense.groups.flatMap((g) => g.rows).find((r) => r.category.id === 'travel');
  assert.equal(travel.rollover, 150); // January 100 unspent, February 100 - 50
  assert.equal(b.expense.planned, 2800);
});

test('a suggested budget is the recent average, rounded to a tidy figure', () => {
  const list = [tx('2026-01-10', -412, 'Food Lion', 'groceries'), tx('2026-02-10', -388, 'Food Lion', 'groceries'), tx('2026-03-10', -431, 'Food Lion', 'groceries')];
  assert.equal(M.suggestBudget(list, IDX, 'groceries', '2026-04'), 410);
  assert.equal(M.suggestBudget(list, IDX, 'coffee', '2026-04'), 0);
});

test('recurring bills keep to an interval and an amount; the weekly grocery run does not count', () => {
  const list = [];
  for (const d of ['2026-06-03', '2026-07-03', '2026-08-03']) list.push(tx(d, -15.49, 'Netflix', 'subscriptions'));
  for (const d of ['2026-07-20', '2026-08-20']) list.push(tx(d, -9.99, 'Tiny App', 'subscriptions')); // two identical charges are enough
  for (let i = 0; i < 8; i++) list.push(tx(M.addDays('2026-06-06', i * 7), -(60 + (i % 3) * 45), 'Food Lion', 'groceries'));
  for (let i = 0; i < 6; i++) list.push(tx(M.addDays('2026-06-05', i * 14), 2412.5, 'Payroll', 'paycheck'));
  for (const d of ['2026-02-01', '2026-03-01', '2026-04-01']) list.push(tx(d, -50, 'Old Gym', 'fitness'));
  list.push(tx('2026-07-25', -1200, 'Card Payment', 'cc_payment'), tx('2026-08-25', -1300, 'Card Payment', 'cc_payment'), tx('2026-06-25', -1100, 'Card Payment', 'cc_payment'));
  list.push(tx('2026-07-25', 1200, 'Payment Thank You', 'cc_payment', { accountId: 'card' }), tx('2026-08-25', 1300, 'Payment Thank You', 'cc_payment', { accountId: 'card' }), tx('2026-06-25', 1100, 'Payment Thank You', 'cc_payment', { accountId: 'card' }));
  const streams = M.detectRecurring(list, { today: '2026-08-28', index: IDX });
  const by = (m) => streams.find((s) => s.merchant === m);
  assert.equal(by('Netflix').cadence, 'monthly');
  assert.equal(by('Netflix').nextDate, '2026-09-03');
  assert.equal(by('Netflix').status, 'upcoming');
  assert.equal(by('Tiny App').cadence, 'monthly');
  assert.equal(by('Food Lion'), undefined);
  assert.equal(by('Payroll').cadence, 'biweekly');
  assert.equal(by('Payroll').sign, 'in');
  assert.equal(by('Old Gym').status, 'lapsed');
  assert.ok(by('Card Payment'), 'paying the card is a bill');
  assert.equal(by('Payment Thank You'), undefined, "the card's side of the payment is not income");
  const ignored = M.detectRecurring(list, { today: '2026-08-28', index: IDX, overrides: new Map([[M.streamKey('Netflix', 'out'), { status: 'ignored' }]]) });
  assert.equal(ignored.find((s) => s.merchant === 'Netflix').ignored, true);
  const soon = M.upcoming(streams, '2026-08-28', '2026-09-10');
  assert.deepEqual(soon.filter((u) => u.stream.merchant === 'Netflix').map((u) => u.date), ['2026-09-03']);
  assert.ok(!soon.some((u) => u.stream.merchant === 'Old Gym'));
  const monthly = M.recurringMonthly(streams);
  assert.ok(monthly.in > 5000 && monthly.in < 5300);
});

test('goals count linked balances, logged contributions, or debt paid down', () => {
  const today = '2026-10-14';
  const manual = M.goalProgress({ target: 2400, targetDate: '2027-05-15', startAmount: 300, contributions: [{ date: '2026-08-01', amount: 150 }, { date: '2026-09-01', amount: 150 }, { date: '2026-10-01', amount: 150 }] }, {}, today);
  assert.equal(manual.saved, 750);
  assert.equal(manual.remaining, 1650);
  assert.equal(manual.monthsLeft, 7);
  assert.equal(manual.monthlyNeeded, 235.71);
  assert.equal(manual.pace, 150);
  assert.equal(manual.status, 'behind');
  const linked = M.goalProgress({ target: 10000, targetDate: '2027-12-31', accountIds: ['sav'] }, { balanceOn: (id, d) => (d >= today ? 6000 : 3000) }, today);
  assert.equal(linked.saved, 6000);
  assert.equal(linked.pace, 1000);
  assert.equal(linked.status, 'on_track');
  const debt = M.goalProgress({ kind: 'debt', target: 0, startAmount: 16000, accountIds: ['loan'] }, { balanceOn: () => -12000 }, today);
  assert.equal(debt.saved, 4000);
  assert.equal(debt.target, 16000);
  assert.equal(debt.status, 'no_date');
  assert.equal(M.goalProgress({ target: 100, startAmount: 150 }, {}, today).status, 'done');
});

test('holdings add up to a portfolio with its mix and gain', () => {
  const p = M.portfolio([
    { accountId: 'b', symbol: 'VTI', shares: 10, price: 300, costBasis: 2500 },
    { accountId: 'b', symbol: 'BND', shares: 20, price: 75, costBasis: 1600 },
    { accountId: 'r', symbol: 'XYZ', name: 'Something', shares: 1, price: 500 },
  ]);
  assert.equal(p.value, 5000);
  assert.equal(p.cost, 4100);
  assert.equal(p.gain, 400); // only the holdings with a cost basis count toward the gain
  assert.deepEqual(p.classes.map((c) => [c.id, c.value]), [['us_stock', 3500], ['bond', 1500]]);
  assert.equal(p.byAccount.get('r'), 500);
  assert.equal(M.guessAssetClass('VXUS'), 'intl_stock');
  assert.equal(M.guessAssetClass('SPAXX', 'Fidelity Government Money Market'), 'cash');
  assert.equal(M.guessAssetClass('VNQ'), 'real_estate');
  assert.equal(M.guessAssetClass('BTC'), 'crypto');
});

test('insights name overspending, bills due, a price rise, and what needs review', () => {
  const today = '2026-10-14';
  const list = [];
  for (const d of ['2026-07-02', '2026-08-02', '2026-09-02']) list.push(tx(d, -10.99, 'Streamy', 'subscriptions'));
  list.push(tx('2026-10-02', -13.99, 'Streamy', 'subscriptions'));
  for (const d of ['2026-07-16', '2026-08-16', '2026-09-16']) list.push(tx(d, -120, 'Duke Energy', 'electric_gas'));
  list.push(tx('2026-10-05', -700, 'Diner', 'restaurants'));
  const budget = M.budgetMonth({ month: '2026-10', index: IDX, budgets: [{ month: '2026-10', categoryId: 'restaurants', amount: 300 }], transactions: list, mode: 'category' });
  const streams = M.detectRecurring(list, { today, index: IDX });
  const out = M.insights({ today, transactions: list, index: IDX, budget, streams, goals: [], cashAccounts: [{ balance: 50 }], reviewCount: 2 });
  const ids = out.map((i) => i.id.split(':')[0]);
  assert.ok(ids.includes('over'), 'restaurants over budget');
  assert.ok(ids.includes('bills'), 'Duke Energy due on the 16th');
  assert.ok(ids.includes('short'), 'cash does not cover the bills');
  assert.ok(ids.includes('rise'), 'Streamy went up');
  assert.ok(ids.includes('review'));
  assert.equal(out[0].level, 'warn'); // warnings first
  for (const i of out) assert.ok(i.title && i.body && i.view, i.id);
});

test('the example household is the same every time, all in the past, all marked as examples', () => {
  const a = M.sampleData('2026-10-14'), b = M.sampleData('2026-10-14');
  assert.deepEqual(a.transactions.map((t) => [t.date, t.amount, t.merchant]), b.transactions.map((t) => [t.date, t.amount, t.merchant]));
  const all = [].concat(a.accounts, a.transactions, a.balances, a.holdings, a.budgets, a.goals);
  for (const r of all) assert.equal(r.sample, true, JSON.stringify(r).slice(0, 80));
  for (const t of a.transactions) {
    assert.ok(t.date <= '2026-10-14', t.date);
    assert.ok(/^[A-Za-z0-9_.:-]{1,64}$/.test(t.id));
    assert.ok(IDX.has(t.categoryId), t.categoryId);
  }
  assert.equal(new Set(a.transactions.map((t) => t.id)).size, a.transactions.length);
  // every card payment out of checking lands on the card the same day
  const outs = a.transactions.filter((t) => t.categoryId === 'cc_payment' && t.amount < 0);
  for (const o of outs) assert.ok(a.transactions.some((t) => t.categoryId === 'cc_payment' && t.amount === -o.amount && t.date === o.date && t.accountId !== o.accountId));
  const card = a.accounts.find((x) => x.type === 'credit');
  const owed = M.makeLedger(card, a.transactions.filter((t) => t.accountId === card.id), a.balances.filter((x) => x.accountId === card.id), { today: '2026-10-14' }).current;
  assert.ok(owed < 0 && owed > -4000, String(owed));
  assert.ok(a.transactions.some((t) => !t.reviewed), 'a couple are left to review');
});

test('every category that can go to the tax ledger names a line the worksheet has', () => {
  const Schema = require('../js/schema.js');
  const lines = M.DEFAULT_CATEGORIES.filter((c) => c.tax);
  assert.ok(lines.length >= 8);
  for (const c of lines) assert.ok(Schema.getLine(c.tax), `${c.id} -> ${c.tax}`);
  // a mortgage payment is principal and interest; the deductible part comes from the lender's 1098, so it is not offered
  assert.equal(M.DEFAULT_CATEGORIES.find((c) => c.id === 'mortgage').tax, undefined);
});

test('category ids, group slots, and the account types are what storage and the stylesheet expect', () => {
  const ids = M.DEFAULT_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_.:-]{1,64}$/);
  const slots = M.GROUPS.filter((g) => g.slot).map((g) => g.slot);
  assert.equal(new Set(slots).size, slots.length, 'no two groups share a palette slot');
  assert.ok(slots.every((n) => n >= 1 && n <= 8));
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  for (let n = 0; n <= 8; n++) assert.match(css, new RegExp(`--series-${n}: #[0-9a-f]{6};`), `--series-${n}`);
  const store = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'store.js'), 'utf8');
  for (const t of M.ACCOUNT_TYPES) assert.ok(store.includes(`'${t.id}'`), `store.js knows ${t.id}`);
  for (const g of M.GROUPS) assert.ok(store.includes(`'${g.id}'`), `store.js knows the ${g.id} group`);
});

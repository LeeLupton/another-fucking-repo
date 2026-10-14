const test = require('node:test');
const assert = require('node:assert/strict');
const IMP = require('../js/importer.js');
const M = require('../js/money.js');
const MI = require('../js/money-import.js');

// OFX 1.x: SGML, leaf elements never closed, aggregates closed
const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261014120000[-5:EST]<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>053112345<ACCTID>000123454821<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20261013
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001120000.000[-5:EST]<TRNAMT>-1684.22<FITID>2026100101<NAME>HARBOR BANK MTG PMT<MEMO>WEB PMT</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261002<TRNAMT>2412.50<FITID>2026100201<NAME>COASTAL LOGISTICS DIR DEP</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-23,40<FITID>2026100301<NAME>SQ *BLUE OCEAN COFFEE &amp; TEA</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>9197.20<DTASOF>20261013</LEDGERBAL>
<AVAILBAL><BALAMT>9100.00<DTASOF>20261013</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

// OFX 2.x: XML, everything closed
const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF>
<CCACCTFROM><ACCTID>4111111111111177</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-82.10</TRNAMT><FITID>A1</FITID><NAME>FOOD LION #2231</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260925</DTPOSTED><TRNAMT>1929.94</TRNAMT><FITID>A2</FITID><NAME>PAYMENT THANK YOU</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260231</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>BAD</FITID><NAME>NOT A DAY</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-2286.58</BALAMT><DTASOF>20261013</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

const OFX_INV = `<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><DTASOF>20261013</DTASOF><CURDEF>USD</CURDEF>
<INVACCTFROM><BROKERID>broker.example</BROKERID><ACCTID>X99-6402</ACCTID></INVACCTFROM>
<INVPOSLIST>
<POSSTOCK><INVPOS><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>64.2</UNITS><UNITPRICE>318.40</UNITPRICE><MKTVAL>20441.28</MKTVAL><DTPRICEASOF>20261013</DTPRICEASOF></INVPOS></POSSTOCK>
<POSMF><INVPOS><SECID><UNIQUEID>921937835</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><UNITS>52</UNITS><UNITPRICE>73.02</UNITPRICE><MKTVAL>3797.04</MKTVAL></INVPOS></POSMF>
</INVPOSLIST>
<INVBAL><AVAILCASH>1840.55</AVAILCASH></INVBAL>
</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>
<SECLISTMSGSRSV1><SECLIST>
<STOCKINFO><SECINFO><SECID><UNIQUEID>922908769</UNIQUEID></SECID><SECNAME>Vanguard Total Stock Market ETF</SECNAME><TICKER>VTI</TICKER></SECINFO></STOCKINFO>
<MFINFO><SECINFO><SECID><UNIQUEID>921937835</UNIQUEID></SECID><SECNAME>Vanguard Total Bond Market ETF</SECNAME><TICKER>BND</TICKER></SECINFO></MFINFO>
</SECLIST></SECLISTMSGSRSV1></OFX>`;

test('an OFX 1.x statement gives its transactions, its balance, and no account number', () => {
  const { statements } = MI.parseOFX(OFX_SGML);
  assert.equal(statements.length, 1);
  const st = statements[0];
  assert.equal(st.kind, 'bank');
  assert.equal(st.mask, '4821');
  assert.equal(MI.ofxAccountType(st), 'checking');
  assert.equal(st.balance, 9197.2);
  assert.equal(st.balanceDate, '2026-10-13');
  assert.deepEqual(st.transactions.map((t) => [t.date, t.amount, t.fitid]), [['2026-10-01', -1684.22, '2026100101'], ['2026-10-02', 2412.5, '2026100201'], ['2026-10-03', -23.4, '2026100301']]);
  assert.equal(st.transactions[2].name, 'SQ *BLUE OCEAN COFFEE & TEA');
  assert.ok(!JSON.stringify(statements).includes('000123454821'), 'the full account number is not kept');
  assert.equal(MI.parseOFX(OFX_SGML).statements[0].key, st.key, 'the same account hashes the same every time');
});

test('an OFX 2.x card statement keeps the sign the bank gave and drops impossible dates', () => {
  const st = MI.parseOFX(OFX_XML).statements[0];
  assert.equal(st.kind, 'credit');
  assert.equal(MI.ofxAccountType(st), 'credit');
  assert.equal(st.mask, '1177');
  assert.equal(st.balance, -2286.58);
  assert.deepEqual(st.transactions.map((t) => t.amount), [-82.1, 1929.94]);
});

test('a brokerage statement gives positions with their tickers and the cash beside them', () => {
  const st = MI.parseOFX(OFX_INV).statements[0];
  assert.equal(st.kind, 'investment');
  assert.equal(MI.ofxAccountType(st), 'brokerage');
  assert.deepEqual(st.positions.map((p) => [p.symbol, p.shares, p.price]), [['VTI', 64.2, 318.4], ['BND', 52, 73.02]]);
  assert.equal(st.positions[0].name, 'Vanguard Total Stock Market ETF');
  assert.equal(st.cash, 1840.55);
  assert.equal(st.balance, 26078.87);
});

test('a file that is not OFX, or has no statement in it, says so', () => {
  assert.throws(() => MI.parseOFX('Date,Amount\n2026-01-01,5'), /not an OFX/);
  assert.throws(() => MI.parseOFX('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>'), /No bank, card, or investment statement/);
  assert.equal(MI.ofxDate('20260229'), null);
  assert.equal(MI.ofxDate('20240229'), '2024-02-29');
  assert.equal(MI.ofxAmount('1,234.50'), 1234.5);
});

test("another budgeting app's export brings its accounts, categories, tags, and notes", () => {
  const csv = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags\n'
    + '2026-10-05,Food Lion,Groceries,Rewards Visa,FOOD LION #2231 BEAUFORT NC,,-82.10,\n'
    + '2026-10-02,Coastal Logistics,Paychecks,Everyday Checking,COASTAL LOGISTICS DIR DEP,,2412.50,\n'
    + '2026-10-01,Boat Yard,Boat Stuff,Everyday Checking,BOAT YARD INC,new prop,-450.00,"boat, summer"\n';
  const rows = IMP.parseCSV(csv);
  const map = MI.detectColumns(rows);
  assert.equal(rows[0][map.account], 'Account');
  assert.equal(rows[0][map.category], 'Category');
  assert.equal(rows[0][map.original], 'Original Statement');
  assert.equal(rows[0][map.tags], 'Tags');
  assert.equal(rows[0][map.notes], 'Notes');
  const norm = MI.normalize(rows, map);
  assert.deepEqual(norm.rows.map((r) => r.amount), [-82.1, 2412.5, -450]); // the file's own signs survive the round trip
  assert.deepEqual(norm.rows[2].tags, ['boat', 'summer']);
  assert.equal(norm.rows[2].notes, 'new prop');
  assert.equal(norm.rows[0].account, 'Rewards Visa');
  const reviewed = MI.review(norm.rows.map((r) => Object.assign({}, r, { accountId: r.account === 'Rewards Visa' ? 'card' : 'chk' })), { transactions: [], categories: M.effectiveCategories([]) });
  assert.equal(reviewed[0].categoryId, 'groceries');
  assert.equal(reviewed[1].categoryId, 'paycheck');
  assert.equal(reviewed[2].newCategory, 'Boat Stuff', 'a category this app lacks is offered as a new one');
  assert.equal(reviewed[0].merchant, 'Food Lion');
  assert.equal(reviewed[0].original, 'FOOD LION #2231 BEAUFORT NC');
});

test('a plain bank export: spending positive, a running balance, and the closing figure', () => {
  const csv = 'Posted Date,Description,Debit,Credit,Balance\n'
    + '10/03/2026,SQ *BLUE OCEAN COFFEE,23.40,,9197.20\n'
    + '10/02/2026,COASTAL LOGISTICS DIR DEP,,2412.50,9220.60\n'
    + '10/01/2026,HARBOR BANK MTG PMT,1684.22,,6808.10\n';
  const rows = IMP.parseCSV(csv);
  const map = MI.detectColumns(rows);
  const norm = MI.normalize(rows, map);
  assert.deepEqual(norm.rows.map((r) => r.amount), [-23.4, 2412.5, -1684.22]);
  assert.deepEqual(MI.closingBalance(norm.rows), { date: '2026-10-03', balance: 9197.2 });
  // oldest first: the last row on the latest day is the closing one
  const asc = [{ date: '2026-10-01', balance: 1 }, { date: '2026-10-03', balance: 2 }, { date: '2026-10-03', balance: 3 }];
  assert.deepEqual(MI.closingBalance(asc), { date: '2026-10-03', balance: 3 });
  assert.equal(MI.closingBalance([{ date: '2026-10-01', balance: null }]), null);
});

test('re-importing a statement finds what is already there, by bank id or by day, amount, and merchant', () => {
  const existing = [
    { id: 'e1', accountId: 'chk', date: '2026-10-01', amount: -1684.22, merchant: 'My Mortgage', original: 'HARBOR BANK MTG PMT' }, // renamed since
    { id: 'e2', accountId: 'chk', date: '2026-10-02', amount: 2412.5, merchant: 'Payroll', fitid: '2026100201' },
    { id: 'e3', accountId: 'chk', date: '2026-10-04', amount: -5, merchant: 'Morning Tide Coffee' },
  ];
  const rows = [
    { accountId: 'chk', date: '2026-10-01', amount: -1684.22, description: 'HARBOR BANK MTG PMT' },
    { accountId: 'chk', date: '2026-10-02', amount: 2412.5, description: 'COASTAL LOGISTICS DIR DEP', fitid: '2026100201' },
    { accountId: 'chk', date: '2026-10-04', amount: -5, description: 'MORNING TIDE COFFEE' },
    { accountId: 'chk', date: '2026-10-04', amount: -5, description: 'MORNING TIDE COFFEE' }, // a second coffee the ledger does not have
    { accountId: 'sav', date: '2026-10-04', amount: -5, description: 'MORNING TIDE COFFEE' }, // another account
  ];
  const out = MI.review(rows, { transactions: existing, categories: M.effectiveCategories([]) });
  assert.deepEqual(out.map((r) => r.duplicate), [true, true, true, false, false]);
  assert.deepEqual(out.map((r) => r.selected), [false, false, false, true, true]);
});

test('rules apply on the way in: category, merchant, tags, and hiding', () => {
  const rules = [{ id: 'r', order: 0, when: { field: 'any', op: 'contains', text: 'venmo' }, then: { categoryId: 'gifts', merchant: 'Venmo', addTags: ['family'], hide: true } }];
  const [r] = MI.review([{ accountId: 'chk', date: '2026-10-04', amount: -40, description: 'VENMO PAYMENT 1023' }], { transactions: [], categories: M.effectiveCategories([]), rules });
  assert.equal(r.categoryId, 'gifts');
  assert.equal(r.merchant, 'Venmo');
  assert.deepEqual(r.tags, ['family']);
  assert.equal(r.hidden, true);
});

test('account numbers hash the same way every time and never come back out', () => {
  assert.equal(MI.hashId('123'), MI.hashId('123'));
  assert.notEqual(MI.hashId('123'), MI.hashId('124'));
  assert.ok(!MI.hashId('000123454821').includes('123454821'));
  assert.equal(MI.lastFour('X99-6402'), '6402');
});

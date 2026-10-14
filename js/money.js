/*
 * money.js — the household-finance engine: accounts, transactions, categories, budgets, cash flow,
 * recurring bills, goals, holdings, and the insights drawn from them.
 *
 * Pure functions over plain rows, the same way rules.js is for the tax side: nothing here touches
 * storage or the page, so every figure the money views show can be checked under `node --test`.
 *
 * Sign convention, used everywhere: an amount is signed from the owner's side. Money in is positive
 * (a paycheck, a refund, a card payment landing on the card); money out is negative (a purchase,
 * a bill, a payment leaving checking). A balance is what the account is worth to the owner, so an
 * asset is positive and a debt is negative: a card with $1,200 owed has a balance of -1200, and net
 * worth is simply the sum of every balance.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerMoney = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- dates: ISO day strings throughout, arithmetic in UTC so no time zone moves a day --------------------

  const DAY = 86400000;
  const pad2 = (n) => String(n).padStart(2, '0');
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const YM = /^\d{4}-\d{2}$/;
  const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const isoOfUTC = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
  function todayISO(now) { const d = now || new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  const addDays = (iso, n) => isoOfUTC(utc(iso) + n * DAY);
  /** Whole days from a to b (positive when b is later). */
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
  const monthOf = (iso) => String(iso).slice(0, 7);
  const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const monthStart = (ym) => `${ym}-01`;
  const monthEnd = (ym) => `${ym}-${pad2(daysInMonth(ym))}`;
  function addMonthsYM(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
  }
  /** The same day n months on, clamped to the month's last day: Jan 31 + 1 month is Feb 28, and Feb 28 + 1 is Mar 28. */
  function addMonths(iso, n) {
    const ym = addMonthsYM(monthOf(iso), n);
    return `${ym}-${pad2(Math.min(Number(iso.slice(8, 10)), daysInMonth(ym)))}`;
  }
  const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
  /** Every month from a to b inclusive, oldest first. */
  function monthRange(a, b) { const out = []; for (let ym = a; ym <= b && out.length < 600; ym = addMonthsYM(ym, 1)) out.push(ym); return out; }
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthLabel(ym, opts) {
    const [y, m] = ym.split('-').map(Number);
    const name = (opts && opts.long ? MONTHS_LONG : MONTHS_SHORT)[m - 1];
    return opts && opts.noYear ? name : `${name} ${y}`;
  }
  function dayLabel(iso, withYear) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS_SHORT[m - 1]} ${d}${withYear ? `, ${y}` : ''}`; }

  // ---- numbers ---------------------------------------------------------------------------------------

  /** Half away from zero at the cent, on the decimal value rather than the binary double. */
  function cents(n) { const x = Number(n) || 0; const r = Math.round(Math.abs(x) * 100 + 1e-7) / 100; return x < 0 ? -r : r; }
  const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
  function median(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** "$1,234" (whole dollars, half away from zero); `cents` keeps two places. Negative zero prints as $0. */
  function money(n, opts) {
    const v = Number(n) || 0;
    if (opts && opts.cents) return usd2.format(Math.abs(v) < 0.005 ? 0 : cents(v));
    const r = (v < 0 ? -1 : 1) * Math.round(Math.abs(v));
    return usd0.format(r === 0 ? 0 : r);
  }
  /** "$12.9K", "$1.2M": for axis ticks and tight tiles. Under $1,000 it is plain dollars. */
  function moneyCompact(n) {
    const v = Number(n) || 0, a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a < 1000) return money(v);
    if (a < 1e6) return `${sign}$${(a / 1e3).toFixed(a < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
    return `${sign}$${(a / 1e6).toFixed(a < 1e7 ? 2 : 1).replace(/\.?0+$/, '')}M`;
  }
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

  // ---- accounts --------------------------------------------------------------------------------------

  /**
   * `mode` is how the balance is known by default: 'transactions' walks the balance from a known figure through
   * every transaction; 'manual' takes the balance as entered (or as the holdings add up to) and nothing else.
   */
  const ACCOUNT_TYPES = [
    { id: 'checking', label: 'Checking', group: 'cash', liability: false, mode: 'transactions' },
    { id: 'savings', label: 'Savings', group: 'cash', liability: false, mode: 'transactions' },
    { id: 'cash', label: 'Cash', group: 'cash', liability: false, mode: 'transactions' },
    { id: 'credit', label: 'Credit card', group: 'credit', liability: true, mode: 'transactions' },
    { id: 'brokerage', label: 'Brokerage', group: 'investment', liability: false, mode: 'manual' },
    { id: 'retirement', label: 'Retirement', group: 'investment', liability: false, mode: 'manual' },
    { id: 'property', label: 'Real estate', group: 'property', liability: false, mode: 'manual' },
    { id: 'vehicle', label: 'Vehicle', group: 'vehicle', liability: false, mode: 'manual' },
    { id: 'other_asset', label: 'Other asset', group: 'other_asset', liability: false, mode: 'manual' },
    { id: 'mortgage', label: 'Mortgage', group: 'loan', liability: true, mode: 'manual' },
    { id: 'loan', label: 'Loan', group: 'loan', liability: true, mode: 'manual' },
    { id: 'other_liability', label: 'Other liability', group: 'other_liability', liability: true, mode: 'manual' },
  ];
  const ACCOUNT_GROUPS = [
    { id: 'cash', label: 'Cash' },
    { id: 'credit', label: 'Credit cards' },
    { id: 'investment', label: 'Investments' },
    { id: 'property', label: 'Real estate' },
    { id: 'vehicle', label: 'Vehicles' },
    { id: 'other_asset', label: 'Other assets' },
    { id: 'loan', label: 'Loans' },
    { id: 'other_liability', label: 'Other liabilities' },
  ];
  const accountType = (id) => ACCOUNT_TYPES.find((t) => t.id === id) || ACCOUNT_TYPES[0];
  const isLiability = (account) => !!(account && accountType(account.type).liability);
  const balanceModeOf = (account) => (account && (account.balanceMode === 'manual' || account.balanceMode === 'transactions') ? account.balanceMode : accountType(account && account.type).mode);
  /** A guess at the type from a name such as "Chase Sapphire Visa" or "Roth IRA", for accounts found in an import. */
  function guessAccountType(name, hint) {
    const s = `${name || ''} ${hint || ''}`.toLowerCase();
    if (/\b(credit|visa|mastercard|master card|amex|american express|discover|card|creditline)\b/.test(s)) return 'credit';
    if (/\b(401 ?k|403 ?b|457|ira|roth|retirement|pension|tsp|sep)\b/.test(s)) return 'retirement';
    if (/\b(brokerage|invest|investment|individual|stocks?|etrade|e\*trade|schwab one|fidelity account)\b/.test(s)) return 'brokerage';
    if (/\bmortgage\b/.test(s)) return 'mortgage';
    if (/\b(loan|lending|student)\b/.test(s)) return 'loan';
    if (/\b(sav|saver|savings|money market|mmda|cd|reserve)\b/.test(s)) return 'savings';
    if (/\bcash\b/.test(s) && !/cash ?back|cash rewards/.test(s)) return 'cash';
    return 'checking';
  }

  // ---- categories ------------------------------------------------------------------------------------

  /**
   * Category groups. `slot` is the group's fixed place in the categorical chart palette (1-8, styles.css --series-N):
   * a group keeps its colour whatever else is on the chart, and the groups with no slot draw in the "Other" grey.
   */
  const GROUPS = [
    { id: 'income', name: 'Income', kind: 'income', slot: 0 },
    { id: 'housing', name: 'Housing', kind: 'expense', slot: 2 },
    { id: 'bills', name: 'Bills & utilities', kind: 'expense', slot: 4 },
    { id: 'food', name: 'Food & dining', kind: 'expense', slot: 1 },
    { id: 'transport', name: 'Auto & transport', kind: 'expense', slot: 3 },
    { id: 'shopping', name: 'Shopping', kind: 'expense', slot: 5 },
    { id: 'health', name: 'Health & wellness', kind: 'expense', slot: 6 },
    { id: 'lifestyle', name: 'Travel & lifestyle', kind: 'expense', slot: 7 },
    { id: 'financial', name: 'Financial', kind: 'expense', slot: 8 },
    { id: 'children', name: 'Children', kind: 'expense', slot: 0 },
    { id: 'education', name: 'Education', kind: 'expense', slot: 0 },
    { id: 'gifts', name: 'Gifts & donations', kind: 'expense', slot: 0 },
    { id: 'business', name: 'Business', kind: 'expense', slot: 0 },
    { id: 'other', name: 'Other', kind: 'expense', slot: 0 },
    { id: 'transfer', name: 'Transfers', kind: 'transfer', slot: 0 },
  ];
  const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

  /**
   * The built-in categories. `budget` is the flex-budget bucket: fixed (the same every month), flexible (day-to-day,
   * pooled in flex mode), or nonmonthly (a few times a year, saved for monthly). `keywords` drive the suggestion:
   * a keyword matches at the start of a word, and one ending in '$' must also end the word ('bp$' is BP, not BPO).
   * `tax` names the worksheet line a purchase in the category most often belongs on, so a transaction can be sent to
   * the tax ledger with the line already chosen.
   */
  const C = (id, name, groupId, budget, keywords, extra) => Object.assign({ id, name, groupId, kind: GROUP_BY_ID[groupId].kind, budget, keywords: keywords || [] }, extra || {});
  const DEFAULT_CATEGORIES = [
    C('paycheck', 'Paychecks', 'income', 'fixed', ['payroll', 'direct dep', 'dir dep', 'salary', 'paycheck', 'adp$', 'gusto', 'paychex', 'pay roll']),
    C('business_income', 'Business income', 'income', 'flexible', ['stripe transfer', 'square inc', 'sq dep', 'invoice', 'client payment', 'jobber payments', 'shopify payout']),
    C('interest_income', 'Interest', 'income', 'flexible', ['interest paid', 'interest earned', 'int earned', 'interest payment', 'int pymt', 'credit interest']),
    C('dividends', 'Dividends & capital gains', 'income', 'flexible', ['dividend', 'div reinv', 'capital gain', 'cap gain']),
    C('other_income', 'Other income', 'income', 'flexible', ['tax refund', 'irs treas', 'treas 310', 'state tax refund', 'rebate', 'cashback', 'cash back reward', 'reimbursement']),

    C('rent', 'Rent', 'housing', 'fixed', ['rent$', 'apartments', 'property mgmt', 'property management', 'leasing office']),
    C('mortgage', 'Mortgage', 'housing', 'fixed', ['mortgage', 'mtg pmt', 'mtg payment', 'home loan', 'loan servicing', 'rocket mortgage', 'mr cooper', 'newrez']), // only the interest is deductible, and it comes from the lender's Form 1098, not the payments
    C('home_improvement', 'Home improvement', 'housing', 'nonmonthly', ['home depot', 'lowes', "lowe's", 'ace hardware', 'menards', 'true value', 'harbor freight', 'sherwin williams']),
    C('home_services', 'Home services', 'housing', 'flexible', ['pest', 'lawn', 'landscap', 'maid', 'cleaning service', 'plumbing', 'plumber', 'hvac', 'roto rooter', 'terminix', 'orkin', 'handyman']),

    C('electric_gas', 'Gas & electric', 'bills', 'fixed', ['duke energy', 'electric', 'energy', 'power co', 'piedmont natural', 'natural gas', 'pg&e', 'con ed', 'dominion', 'georgia power', 'fpl$', 'xcel']),
    C('water', 'Water & trash', 'bills', 'fixed', ['water', 'sewer', 'utilities dept', 'utility billing', 'waste', 'trash', 'republic services', 'garbage']),
    C('internet', 'Internet & cable', 'bills', 'fixed', ['comcast', 'xfinity', 'spectrum', 'charter comm', 'att internet', 'fios', 'cox comm', 'frontier comm', 'starlink', 'directv', 'dish network', 'optimum', 'google fiber']),
    C('phone', 'Phone', 'bills', 'fixed', ['verizon', 't mobile', 'tmobile', 'at&t', 'att wireless', 'mint mobile', 'visible', 'cricket', 'boost mobile', 'us cellular', 'google fi', 'consumer cellular']),
    C('subscriptions', 'Subscriptions', 'bills', 'fixed', ['netflix', 'spotify', 'hulu', 'disney plus', 'disneyplus', 'hbo', 'max com', 'apple com bill', 'icloud', 'youtube', 'amazon prime', 'prime video', 'paramount', 'peacock', 'audible', 'patreon', 'substack', 'dropbox', 'google storage', 'google one', 'openai', 'chatgpt', 'anthropic', 'claude ai', 'microsoft 365', 'adobe', 'nytimes', 'wsj', 'sirius', 'siriusxm', 'crunchyroll']),
    C('insurance', 'Insurance', 'bills', 'nonmonthly', ['geico', 'state farm', 'progressive', 'allstate', 'insurance', 'usaa', 'liberty mutual', 'nationwide', 'farmers ins', 'erie ins', 'travelers ins', 'lemonade']),

    C('groceries', 'Groceries', 'food', 'flexible', ['grocery', 'groceries', 'supermarket', 'harris teeter', 'food lion', 'kroger', 'publix', 'safeway', 'whole foods', 'wholefds', 'trader joe', 'aldi', 'wegmans', 'heb$', 'lidl', 'sprouts', 'piggly wiggly', 'costco', "sam's club", 'sams club', 'instacart', 'stop & shop', 'giant food', 'meijer', 'winn dixie', 'lowes foods', 'fresh market', 'food city', 'ingles', 'hy vee', 'albertsons', 'market basket']),
    C('restaurants', 'Restaurants & bars', 'food', 'flexible', ['restaurant', 'grill', 'pizza', 'taco', 'sushi', 'bbq', 'barbecue', 'diner', 'bistro', 'kitchen', 'tavern', 'pub$', 'brewing', 'brewery', 'chipotle', 'mcdonald', 'wendy', 'burger', 'chick fil a', 'chickfila', 'subway', 'panera', 'domino', 'papa john', 'five guys', 'kfc', 'popeyes', 'sonic drive', 'arby', 'doordash', 'uber eats', 'ubereats', 'grubhub', 'postmates', 'olive garden', 'applebee', 'cook out', 'cookout', 'bojangles', 'waffle house', 'ihop', 'denny', 'cracker barrel', 'texas roadhouse', 'outback', 'red robin', 'zaxby', 'jersey mike', 'jimmy john', 'wingstop', 'buffalo wild', 'seafood', 'oyster', 'crab', 'steakhouse', 'cantina', 'noodle', 'ramen', 'pho$', 'deli$', 'bakery', 'bagel', 'dairy queen', 'shake shack', 'in n out', 'whataburger', 'culvers', 'raising cane', 'sweetgreen', 'cava$', 'toast$']),
    C('coffee', 'Coffee shops', 'food', 'flexible', ['starbucks', 'dunkin', 'coffee', 'espresso', 'dutch bros', 'peets', 'caribou', 'tim hortons', 'roaster', 'cafe$', 'latte']),

    C('gas_fuel', 'Gas', 'transport', 'flexible', ['shell$', 'exxon', 'exxonmobil', 'chevron', 'bp$', 'marathon petro', 'sunoco', 'circle k', 'wawa', 'sheetz', 'speedway', 'valero', 'citgo', 'murphy usa', 'murphy express', 'racetrac', 'quiktrip', 'qt$', 'pilot travel', "love's travel", 'loves travel', 'fuel', 'gas station', 'mobil$', 'phillips 66', 'conoco', 'kangaroo', '7 eleven', 'casey', 'costco gas', 'sams fuel', 'kroger fuel', 'gate petro', 'speedway']),
    C('parking_tolls', 'Parking & tolls', 'transport', 'flexible', ['parking', 'parkmobile', 'park mobile', 'toll', 'e zpass', 'ezpass', 'sunpass', 'quick pass', 'spothero', 'pay by phone']),
    C('rideshare', 'Taxi & ride shares', 'transport', 'flexible', ['uber$', 'uber trip', 'lyft', 'taxi', 'cab$']),
    C('transit', 'Public transit', 'transport', 'flexible', ['transit', 'metro', 'amtrak', 'greyhound', 'mta$', 'bart$', 'septa', 'wmata', 'marta', 'go triangle']),
    C('auto_maintenance', 'Auto maintenance', 'transport', 'nonmonthly', ['jiffy lube', 'valvoline', 'oil change', 'autozone', 'advance auto', "o'reilly", 'oreilly auto', 'napa auto', 'firestone', 'goodyear', 'midas', 'pep boys', 'car wash', 'tire', 'mechanic', 'collision', 'body shop', 'auto repair', 'dmv$', 'vehicle registration', 'ncdmv', 'inspection']),
    C('auto_payment', 'Car payment', 'transport', 'fixed', ['auto loan', 'car payment', 'toyota financial', 'honda financial', 'ford credit', 'ally auto', 'carmax auto', 'gm financial', 'capital one auto', 'nissan motor accept', 'hyundai motor fin', 'santander consumer']),

    C('shopping', 'Shopping', 'shopping', 'flexible', ['amazon', 'amzn', 'target', 'walmart', 'wal mart', 'wm supercenter', 'etsy', 'ebay', 'kohls', 'marshalls', 'tj maxx', 'tjmaxx', 'ross stores', 'dollar general', 'dollar tree', 'family dollar', 'five below', 'shein', 'temu', 'wayfair', 'ikea', 'big lots', 'hobby lobby', 'michaels', 'joann', 'sporting goods', "dick's sporting", 'academy sports', 'bass pro', 'cabela']),
    C('clothing', 'Clothing', 'shopping', 'flexible', ['old navy', 'gap$', 'h&m', 'zara', 'nike', 'adidas', 'uniqlo', 'nordstrom', 'macys', "macy's", 'belk', 'foot locker', 'dsw$', 'lululemon', 'carters', 'clothing', 'apparel', 'shoes', 'banana republic', 'j crew', 'american eagle', 'abercrombie', 'columbia sportswear', 'patagonia']),
    C('electronics', 'Electronics & software', 'shopping', 'flexible', ['best buy', 'apple store', 'apple com us', 'newegg', 'b&h photo', 'micro center', 'gamestop', 'steam games', 'steampowered', 'playstation', 'xbox', 'nintendo', 'jetbrains', 'github']),
    C('home_goods', 'Home & garden', 'shopping', 'flexible', ['bed bath', 'homegoods', 'pottery barn', 'crate & barrel', 'williams sonoma', 'tractor supply', 'garden center', 'nursery', 'pier 1', 'kirklands', 'at home store']),

    C('medical', 'Medical', 'health', 'flexible', ['doctor', 'medical', 'clinic', 'hospital', 'health system', 'urgent care', 'physician', 'pediatric', 'labcorp', 'quest diag', 'radiology', 'orthopedic', 'dermatology', 'physical therapy', 'chiropract', 'healthcare', 'family practice', 'carolina east', 'atrium health', 'novant'], { tax: 'med.doctor' }),
    C('pharmacy', 'Pharmacy', 'health', 'flexible', ['cvs$', 'cvs pharmacy', 'walgreens', 'rite aid', 'pharmacy', 'rx$'], { tax: 'med.prescriptions' }),
    C('dentist', 'Dentist', 'health', 'nonmonthly', ['dental', 'dentist', 'orthodont', 'smile'], { tax: 'med.dental' }),
    C('vision', 'Vision', 'health', 'nonmonthly', ['optometr', 'eye care', 'eyecare', 'vision center', 'lenscrafters', 'warby parker', 'america s best'], { tax: 'med.glasses' }),
    C('fitness', 'Fitness', 'health', 'fixed', ['gym$', 'fitness', 'planet fitness', 'ymca', 'crossfit', 'yoga', 'peloton', 'orangetheory', 'la fitness', 'anytime fitness', 'pilates', 'gold s gym', 'equinox']),

    C('travel', 'Travel & vacation', 'lifestyle', 'nonmonthly', ['airline', 'airlines', 'delta air', 'american air', 'united air', 'southwest air', 'jetblue', 'spirit air', 'frontier air', 'alaska air', 'allegiant', 'hotel', 'marriott', 'hilton', 'hyatt', 'holiday inn', 'hampton inn', 'airbnb', 'vrbo', 'expedia', 'booking com', 'priceline', 'hertz', 'enterprise rent', 'avis$', 'budget rent', 'resort', 'cruise']),
    C('entertainment', 'Entertainment & recreation', 'lifestyle', 'flexible', ['cinema', 'theater', 'theatre', 'amc$', 'regal', 'ticketmaster', 'stubhub', 'live nation', 'bowling', 'golf', 'museum', 'concert', 'eventbrite', 'fandango', 'arcade', 'topgolf', 'aquarium', 'zoo$', 'state park', 'marina', 'bait & tackle']),
    C('personal_care', 'Personal care', 'lifestyle', 'flexible', ['salon', 'barber', 'spa$', 'nails', 'great clips', 'supercuts', 'sport clips', 'sephora', 'ulta']),
    C('pets', 'Pets', 'lifestyle', 'flexible', ['petco', 'petsmart', 'chewy', 'veterinary', 'vet$', 'animal hospital', 'pet supplies', 'banfield']),

    C('fees', 'Fees & charges', 'financial', 'flexible', ['fee$', 'service charge', 'overdraft', 'late fee', 'annual fee', 'atm fee', 'foreign transaction', 'interest charge', 'finance charge', 'maintenance fee']),
    C('taxes', 'Taxes', 'financial', 'nonmonthly', ['irs$', 'irs usataxpymt', 'usataxpymt', 'tax payment', 'franchise tax', 'dept of revenue', 'department of revenue', 'ncdor', 'nc dept rev', 'property tax', 'county tax', 'eftps'], { tax: 'tax.state_income' }), // the classifier picks real estate or state income tax; federal payments are never deductible
    C('cash_atm', 'Cash & ATM', 'financial', 'flexible', ['atm$', 'atm withdrawal', 'cash withdrawal', 'withdrawal at']),
    C('loan_payment', 'Loan payments', 'financial', 'fixed', ['student loan', 'navient', 'nelnet', 'mohela', 'sallie mae', 'great lakes', 'aidvantage', 'edfinancial', 'loan pmt', 'loan payment', 'sofi loan', 'lending club', 'upstart', 'prosper']),
    C('financial_services', 'Financial & legal services', 'financial', 'nonmonthly', ['h&r block', 'turbotax', 'intuit', 'cpa$', 'accounting', 'legal', 'attorney', 'law office', 'notary', 'credit karma']),

    C('childcare', 'Child care', 'children', 'fixed', ['daycare', 'day care', 'child care', 'childcare', 'preschool', 'babysit', 'kindercare', 'nanny', 'after school']), // a credit on Form 2441, not a line on the organizer
    C('kids_activities', 'Kids activities', 'children', 'flexible', ['kids', 'summer camp', 'little league', 'tutoring', 'scouts', 'dance studio', 'swim lessons', 'gymnastics']),

    C('tuition', 'Tuition', 'education', 'nonmonthly', ['tuition', 'university', 'college', 'bursar', 'community college', 'coursera', 'udemy', 'edx$', 'student account'], { tax: 'edu.tuition' }),
    C('books', 'Books & supplies', 'education', 'flexible', ['bookstore', 'barnes', 'textbook', 'chegg', 'kindle', 'school supplies'], { tax: 'edu.books' }),

    C('charity', 'Charity', 'gifts', 'flexible', ['donation', 'church', 'tithe', 'tithely', 'charity', 'foundation', 'red cross', 'salvation army', 'united way', 'st jude', 'ministry', 'ministries', 'gofundme', 'unicef', 'npr$', 'pbs$', 'food bank', 'habitat for humanity', 'humane society', 'givebutter', 'pushpay'], { tax: 'ch.org' }),
    C('gifts', 'Gifts', 'gifts', 'flexible', ['gift', 'flowers', '1 800 flowers', 'hallmark', 'edible arrangements', 'florist']),

    C('business_expense', 'Business expenses', 'business', 'flexible', ['quickbooks', 'jobber', 'google workspace', 'gsuite', 'godaddy', 'namecheap', 'squarespace', 'wix com', 'shopify', 'mailchimp', 'canva', 'zoom us', 'slack', 'aws$', 'amazon web services', 'digitalocean', 'cloudflare', 'vercel', 'office depot', 'officemax', 'staples', 'fedex', 'ups$', 'ups store', 'usps', 'postage', 'stamps com'], { tax: 'se.office' }),
    C('advertising', 'Advertising', 'business', 'flexible', ['facebook ads', 'facebk', 'meta ads', 'google ads', 'yelp ads', 'nextdoor ads', 'linkedin ads', 'vistaprint'], { tax: 'se.advertising' }),

    C('check', 'Checks', 'other', 'flexible', ['check$', 'check #', 'chk$', 'cheque']),
    C('misc', 'Miscellaneous', 'other', 'flexible', []),
    C('uncategorized', 'Uncategorized', 'other', 'flexible', []),

    C('transfer', 'Transfer', 'transfer', 'flexible', ['transfer', 'xfer', 'zelle to', 'zelle from', 'venmo', 'paypal transfer', 'online banking transfer', 'internal transfer', 'to savings', 'from savings', 'from checking', 'to checking', 'brokerage transfer', 'ach transfer']),
    C('cc_payment', 'Credit card payment', 'transfer', 'flexible', ['payment thank you', 'payment thankyou', 'autopay', 'auto pay', 'card payment', 'credit card payment', 'crd pmt', 'cardmember serv', 'epay', 'e payment', 'online payment', 'mobile payment', 'applecard', 'capital one mobile', 'discover e payment', 'chase credit crd', 'amex epayment', 'citi autopay', 'payment received']),
    C('balance_adj', 'Balance adjustment', 'transfer', 'flexible', []),
  ];
  const UNCATEGORIZED = 'uncategorized';
  const OTHER_INCOME = 'other_income';
  const TRANSFER = 'transfer';
  const CC_PAYMENT = 'cc_payment';
  const BUDGET_TYPES = [{ id: 'fixed', label: 'Fixed' }, { id: 'flexible', label: 'Flexible' }, { id: 'nonmonthly', label: 'Non-monthly' }];

  /**
   * The categories in force: the built-ins with the user's edits laid over them by id, then the user's own (rows with
   * `custom`). An edit can rename a category, move it to another group, change its budget bucket, turn on rollover,
   * or hide it. A built-in's keywords and tax line stay the built-in's.
   */
  function effectiveCategories(rows) {
    const over = new Map();
    for (const r of rows || []) if (r && r.id) over.set(r.id, r);
    const pick = (base, r) => {
      if (!r) return Object.assign({ hidden: false, rollover: false, custom: false }, base);
      const groupId = GROUP_BY_ID[r.groupId] && GROUP_BY_ID[r.groupId].kind === GROUP_BY_ID[base.groupId].kind ? r.groupId : base.groupId;
      return Object.assign({}, base, {
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : base.name,
        groupId, kind: GROUP_BY_ID[groupId].kind,
        budget: BUDGET_TYPES.some((b) => b.id === r.budget) ? r.budget : base.budget,
        rollover: !!r.rollover, rolloverStart: YM.test(r.rolloverStart || '') ? r.rolloverStart : null,
        hidden: !!r.hidden && base.id !== UNCATEGORIZED, custom: false,
      });
    };
    const out = DEFAULT_CATEGORIES.map((c) => pick(c, over.get(c.id)));
    for (const r of over.values()) {
      if (!r.custom || DEFAULT_CATEGORIES.some((c) => c.id === r.id)) continue;
      const g = GROUP_BY_ID[r.groupId] || GROUP_BY_ID.other;
      out.push({ id: r.id, name: String(r.name || 'Category').trim() || 'Category', groupId: g.id, kind: g.kind, budget: BUDGET_TYPES.some((b) => b.id === r.budget) ? r.budget : 'flexible', keywords: [], rollover: !!r.rollover, rolloverStart: YM.test(r.rolloverStart || '') ? r.rolloverStart : null, hidden: !!r.hidden, custom: true });
    }
    return out;
  }
  /** Lookups over a category list: by id, by group, the group of a category, and a stand-in for an id the list does not have. */
  function categoryIndex(categories) {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const fallback = byId.get(UNCATEGORIZED) || { id: UNCATEGORIZED, name: 'Uncategorized', groupId: 'other', kind: 'expense', budget: 'flexible' };
    const get = (id) => byId.get(id) || fallback;
    const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
    for (const c of categories) (byGroup.get(c.groupId) || byGroup.get('other')).push(c);
    return { list: categories, byId, get, groupOf: (id) => GROUP_BY_ID[get(id).groupId] || GROUP_BY_ID.other, kindOf: (id) => get(id).kind, byGroup, has: (id) => byId.has(id) };
  }

  /** Names other apps use for the same categories, so an export from one of them lands on the right line here. */
  const CATEGORY_ALIASES = {
    'paychecks': 'paycheck', 'paycheck': 'paycheck', 'salary': 'paycheck', 'income': 'other_income', 'other income': 'other_income', 'business income': 'business_income', 'interest': 'interest_income', 'interest income': 'interest_income', 'dividends & capital gains': 'dividends', 'dividends': 'dividends', 'reimbursement': 'other_income', 'bonus': 'paycheck',
    'rent': 'rent', 'mortgage': 'mortgage', 'mortgage & rent': 'mortgage', 'home improvement': 'home_improvement', 'home services': 'home_services', 'lawn & garden': 'home_services', 'home': 'home_improvement',
    'gas & electric': 'electric_gas', 'utilities': 'electric_gas', 'water': 'water', 'garbage': 'water', 'internet & cable': 'internet', 'internet': 'internet', 'television': 'internet', 'phone': 'phone', 'mobile phone': 'phone', 'subscriptions': 'subscriptions', 'music': 'subscriptions', 'insurance': 'insurance', 'auto insurance': 'insurance', 'home insurance': 'insurance', 'life insurance': 'insurance', 'health insurance': 'insurance',
    'groceries': 'groceries', 'restaurants & bars': 'restaurants', 'restaurants': 'restaurants', 'food & dining': 'restaurants', 'fast food': 'restaurants', 'alcohol & bars': 'restaurants', 'coffee shops': 'coffee', 'coffee': 'coffee',
    'gas': 'gas_fuel', 'gas & fuel': 'gas_fuel', 'fuel': 'gas_fuel', 'parking & tolls': 'parking_tolls', 'parking': 'parking_tolls', 'taxi & ride shares': 'rideshare', 'rental car & taxi': 'rideshare', 'public transit': 'transit', 'public transportation': 'transit', 'auto maintenance': 'auto_maintenance', 'service & parts': 'auto_maintenance', 'auto payment': 'auto_payment', 'car payment': 'auto_payment', 'auto & transport': 'auto_maintenance',
    'shopping': 'shopping', 'sporting goods': 'shopping', 'clothing': 'clothing', 'electronics': 'electronics', 'electronics & software': 'electronics', 'furniture & housewares': 'home_goods', 'furnishings': 'home_goods', 'home supplies': 'home_goods',
    'medical': 'medical', 'doctor': 'medical', 'healthcare': 'medical', 'health & fitness': 'fitness', 'pharmacy': 'pharmacy', 'dentist': 'dentist', 'eyecare': 'vision', 'vision': 'vision', 'fitness': 'fitness', 'gym': 'fitness',
    'travel & vacation': 'travel', 'travel': 'travel', 'air travel': 'travel', 'hotel': 'travel', 'vacation': 'travel', 'entertainment & recreation': 'entertainment', 'entertainment': 'entertainment', 'amusement': 'entertainment', 'movies & dvds': 'entertainment', 'fun money': 'entertainment', 'personal': 'personal_care', 'personal care': 'personal_care', 'hair': 'personal_care', 'pets': 'pets', 'pet food & supplies': 'pets', 'veterinary': 'pets',
    'financial fees': 'fees', 'bank fee': 'fees', 'atm fee': 'fees', 'late fee': 'fees', 'finance charge': 'fees', 'fees & charges': 'fees', 'taxes': 'taxes', 'federal tax': 'taxes', 'state tax': 'taxes', 'property tax': 'taxes', 'cash & atm': 'cash_atm', 'loan repayment': 'loan_payment', 'student loans': 'loan_payment', 'loan payments': 'loan_payment', 'financial & legal services': 'financial_services',
    'child care': 'childcare', 'babysitter & daycare': 'childcare', 'child activities': 'kids_activities', 'kids activities': 'kids_activities', 'education': 'tuition', 'tuition': 'tuition', 'books': 'books', 'books & supplies': 'books',
    'charity': 'charity', 'gifts & donations': 'charity', 'gifts': 'gifts', 'gift': 'gifts',
    'business expenses': 'business_expense', 'office supplies & expenses': 'business_expense', 'advertising & promotion': 'advertising', 'advertising': 'advertising',
    'check': 'check', 'checks': 'check', 'miscellaneous': 'misc', 'uncategorized': 'uncategorized',
    'transfer': 'transfer', 'transfers': 'transfer', 'credit card payment': 'cc_payment', 'balance adjustments': 'balance_adj', 'balance adjustment': 'balance_adj',
  };
  const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  /** The category a name from an export means: the user's own names first, then another app's names for the same thing. */
  function categoryByName(name, categories) {
    const n = normName(name);
    if (!n) return null;
    const own = categories.find((c) => normName(c.name) === n);
    if (own) return own.id;
    const alias = CATEGORY_ALIASES[n];
    return alias && categories.some((c) => c.id === alias) ? alias : null;
  }

  // ---- merchants -------------------------------------------------------------------------------------

  const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));
  // the processor and channel prefixes card statements put in front of the merchant
  const PREFIXES = [
    /^(?:purchase|recurring payment|recurring) authorized on \d{1,2}\/\d{1,2}\s+/i,
    /^(?:pos|dbt|debit|checkcard|check card|visa|ach|ach debit|ach credit|electronic|online|preauthorized|preauth|pos purchase|pos debit|debit card purchase|debit purchase|card purchase|purchase|withdrawal|deposit|bill pay|billpay|web pmt|ppd|ccd)\b[\s:-]*/i,
    /^(?:sq|tst|sp|py|bt|dd|in|ckp|cko|ztl|lsp|pp|paypal|pmt|wpy|fs|ec|gglpay|google|apple pay|applepay)\s?\*\s*/i,
    /^\d{2}\/\d{2}\s+/,
    /^(?:direct dep(?:osit)?|dir dep)\s+/i,
    /^\d{3,}\s+/,
    /^www\./i,
  ];
  // brand spellings statements use, mapped to the name people recognise
  const CANONICAL = [
    [/^(amazon|amzn)\s?prime(?!\s?video)|^amzn\s?prime/i, 'Amazon Prime'], [/^(amzn|amazon)(\s?mktp|\s?mktplace|\s?com|\s?digital|\s?prime|\.com)?\b/i, 'Amazon'], [/^(wal-?mart|wm supercenter|walmart\.com)/i, 'Walmart'],
    [/^mcdonald'?s/i, "McDonald's"], [/^chick-?fil-?a/i, 'Chick-fil-A'], [/^cvs/i, 'CVS'], [/^walgreens/i, 'Walgreens'], [/^target\b/i, 'Target'],
    [/^costco\s?(whse|wholesale|gas)?/i, 'Costco'], [/^starbucks/i, 'Starbucks'], [/^netflix/i, 'Netflix'], [/^spotify/i, 'Spotify'], [/^hulu/i, 'Hulu'],
    [/^apple\.com\/bill|^apple com bill/i, 'Apple'], [/^uber\s*\*?\s*eats/i, 'Uber Eats'], [/^uber\b/i, 'Uber'], [/^lyft/i, 'Lyft'], [/^doordash/i, 'DoorDash'],
    [/^harris teeter/i, 'Harris Teeter'], [/^food lion/i, 'Food Lion'], [/^trader joe/i, "Trader Joe's"], [/^whole ?foods|^wholefds/i, 'Whole Foods'],
    [/^home depot|^the home depot/i, 'The Home Depot'], [/^lowe'?s\b(?! foods)/i, "Lowe's"], [/^duke energy/i, 'Duke Energy'], [/^t-?mobile/i, 'T-Mobile'],
    [/^verizon|^vzwrlss|^vz ?wireless/i, 'Verizon'], [/^at&t|^att\b/i, 'AT&T'], [/^comcast|^xfinity/i, 'Xfinity'], [/^spectrum/i, 'Spectrum'], [/^geico/i, 'GEICO'], [/^usaa/i, 'USAA'],
    [/^shell\b/i, 'Shell'], [/^exxon/i, 'Exxon'], [/^bp\b/i, 'BP'], [/^dunkin/i, "Dunkin'"], [/^paypal/i, 'PayPal'], [/^venmo/i, 'Venmo'], [/^zelle/i, 'Zelle'],
    [/^google\s?\*?\s?(youtube|yt)/i, 'YouTube'], [/^openai|^chatgpt/i, 'OpenAI'], [/^anthropic|^claude\.ai/i, 'Anthropic'], [/^irs\b/i, 'IRS'],
  ];
  const KEEP_UPPER = new Set(['CVS', 'BP', 'ATM', 'IRS', 'USA', 'USPS', 'UPS', 'LLC', 'INC', 'NC', 'KFC', 'AMC', 'YMCA', 'HVAC', 'BBQ', 'ACH', 'DMV', 'CPA', 'TV', 'II', 'III', 'NY', 'LA', 'DC', 'HEB', 'TJ', 'QT', 'AAA', 'GEICO', 'USAA', 'IHOP']);
  function titleWord(w) {
    if (!w) return w;
    if (KEEP_UPPER.has(w.toUpperCase()) || /&/.test(w)) return w.toUpperCase();
    if (/^\d/.test(w)) return w.toLowerCase();
    return w.split(/(['-])/).map((p) => (/^['-]$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())).join('').replace(/'S\b/, "'s");
  }
  /**
   * A readable merchant name from a statement line: "SQ *BLUE OCEAN COFFEE 0042  MOREHEAD CITY NC" becomes
   * "Blue Ocean Coffee". Processor prefixes, store numbers, card masks, phone numbers, reference codes, and a trailing
   * city and state go; a name the statement wrote in capitals is title-cased. Nothing here guesses a business the line
   * does not name.
   */
  function cleanMerchant(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!s) return '';
    const original = s;
    for (let pass = 0; pass < 3; pass++) for (const re of PREFIXES) s = s.replace(re, '');
    // statements pad the merchant field and put the city and state after a run of spaces
    const runs = s.split(/\s{2,}/);
    if (runs.length > 1 && runs[0].trim().length >= 2 && /\b[A-Z]{2}$/.test(runs[runs.length - 1].trim()) && STATES.has(runs[runs.length - 1].trim().slice(-2))) s = runs[0];
    s = s.replace(/\s+/g, ' ').trim();
    for (const [re, name] of CANONICAL) if (re.test(s)) return name;
    s = s.replace(/\b(?:x{2,}|\*{2,})\d{2,}\b/gi, ' ') // card masks
      .replace(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, ' ') // phone numbers
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ') // dates
      .replace(/#\s?\d+/g, ' ') // store numbers
      .replace(/\b(?:store|str|ste|unit|loc)\s?\d+\b/gi, ' ')
      .replace(/\*[A-Z0-9]{4,}\b/gi, ' ') // reference codes after an asterisk
      .replace(/\b(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{6,}\b/gi, ' ') // mixed letter-and-digit reference codes
      .replace(/\b\d{4,}\b/g, ' ') // long numbers
      .replace(/\s*\*\s*/g, ' ')
      .replace(/\.(?:com|net|org|co)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    // a trailing state code, and the city in front of it when the line was padded that way
    let words = s.split(' ');
    if (words.length > 1 && STATES.has(words[words.length - 1].toUpperCase()) && /^[A-Z]{2}$/.test(words[words.length - 1])) words.pop();
    s = words.join(' ').replace(/[\s,.-]+$/, '').replace(/^[\s,.-]+/, '');
    if (!s) s = original;
    words = s.split(' ').filter(Boolean);
    const shouting = s === s.toUpperCase();
    const small = new Set(['to', 'of', 'and', 'the', 'for', 'from', 'at', 'on', 'in', 'a']);
    return (shouting ? words.map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : titleWord(w))) : words).join(' ').slice(0, 80);
  }
  /** The key a merchant is remembered under: lower-case letters and digits only, so "Food Lion" and "FOOD-LION" meet. */
  const merchantKey = (m) => String(m || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);

  // ---- categorizing ----------------------------------------------------------------------------------

  const normText = (s) => ` ${String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9&$#]+/g, ' ').trim()} `;
  const normKeyword = (k) => { const exact = k.endsWith('$'); const body = String(exact ? k.slice(0, -1) : k).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9&$#]+/g, ' ').trim(); return { body, exact }; };
  const KEYWORD_CACHE = new Map();
  function keywordsOf(cat) {
    if (!KEYWORD_CACHE.has(cat.id) || KEYWORD_CACHE.get(cat.id).src !== cat.keywords) KEYWORD_CACHE.set(cat.id, { src: cat.keywords, list: (cat.keywords || []).map(normKeyword).filter((k) => k.body) });
    return KEYWORD_CACHE.get(cat.id).list;
  }
  /** Score every category against the text: a keyword is worth its length, so "uber eats" beats "uber". */
  function keywordScores(text, categories) {
    const t = normText(text);
    const out = [];
    for (const c of categories) {
      if (c.hidden) continue;
      let best = 0, hit = '';
      for (const k of keywordsOf(c)) {
        const at = t.indexOf(' ' + k.body);
        if (at < 0) continue;
        if (k.exact && t.charAt(at + 1 + k.body.length) !== ' ') continue;
        const score = k.body.length + (k.exact ? 1 : 0);
        if (score > best) { best = score; hit = k.body; }
      }
      if (best) out.push({ id: c.id, score: best, keyword: hit });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** How often each merchant was filed under each category, from transactions the user has looked at. */
  function buildHistory(transactions) {
    const h = new Map();
    for (const t of transactions || []) {
      if (!t || !t.categoryId || t.categoryId === UNCATEGORIZED || (t.splits && t.splits.length)) continue;
      if (t.sample) continue;
      const k = merchantKey(t.merchant);
      if (!k) continue;
      if (!h.has(k)) h.set(k, new Map());
      const m = h.get(k);
      m.set(t.categoryId, (m.get(t.categoryId) || 0) + (t.reviewed ? 3 : 1));
    }
    return h;
  }

  // ---- rules -----------------------------------------------------------------------------------------

  const RULE_FIELDS = ['merchant', 'original', 'any'];
  const RULE_OPS = ['contains', 'is', 'starts'];
  /** True when a rule's conditions all hold for a transaction. */
  function ruleMatches(rule, tx) {
    if (!rule || !rule.when || !tx) return false;
    const w = rule.when;
    const text = String(w.text || '').toLowerCase().trim();
    if (!text) return false;
    const fields = w.field === 'original' ? [tx.original] : w.field === 'merchant' ? [tx.merchant] : [tx.merchant, tx.original];
    const op = RULE_OPS.includes(w.op) ? w.op : 'contains';
    const hit = fields.some((f) => {
      const v = String(f || '').toLowerCase().trim();
      return op === 'is' ? v === text : op === 'starts' ? v.startsWith(text) : v.includes(text);
    });
    if (!hit) return false;
    const amt = Number(tx.amount) || 0;
    if (w.sign === 'in' && amt <= 0) return false;
    if (w.sign === 'out' && amt >= 0) return false;
    if (w.accountId && w.accountId !== tx.accountId) return false;
    const a = Math.abs(amt);
    if (w.min != null && w.min !== '' && a < Number(w.min)) return false;
    if (w.max != null && w.max !== '' && a > Number(w.max)) return false;
    return true;
  }
  /** What the rules change on a transaction, the first matching rule winning each field; and the rules that fired. */
  function applyRules(tx, rules) {
    const patch = {};
    const fired = [];
    for (const r of (rules || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))) {
      if (!ruleMatches(r, tx)) continue;
      const t = r.then || {};
      let used = false;
      if (t.categoryId && !('categoryId' in patch)) { patch.categoryId = t.categoryId; used = true; }
      if (t.merchant && !('merchant' in patch)) { patch.merchant = String(t.merchant).slice(0, 80); used = true; }
      if (Array.isArray(t.addTags) && t.addTags.length) { patch.tags = Array.from(new Set((patch.tags || tx.tags || []).concat(t.addTags))); used = true; }
      if (t.hide && !('hidden' in patch)) { patch.hidden = true; used = true; }
      if (t.review && !('reviewed' in patch)) { patch.reviewed = true; used = true; }
      if (used) fired.push(r.id);
    }
    return { patch, fired };
  }

  /**
   * A category for a transaction, and why: a rule the user wrote, then what this merchant was filed under before, then
   * the keywords, then the sign. `ctx`: { categories, rules, history, account }.
   */
  function suggestCategory(tx, ctx) {
    ctx = ctx || {};
    const cats = (ctx.categories || DEFAULT_CATEGORIES).filter((c) => !c.hidden);
    const has = (id) => cats.some((c) => c.id === id);
    const amt = Number(tx.amount) || 0;
    const { patch } = applyRules(tx, ctx.rules);
    if (patch.categoryId && has(patch.categoryId)) return { categoryId: patch.categoryId, source: 'rule', because: 'a rule you set' };
    const hist = ctx.history && ctx.history.get(merchantKey(tx.merchant));
    if (hist && hist.size) {
      const [id, n] = Array.from(hist.entries()).sort((a, b) => b[1] - a[1])[0];
      const kind = (cats.find((c) => c.id === id) || {}).kind;
      // a refund is filed where the purchase was; income is never filed against a purchase-only merchant the other way round
      if (has(id) && !(kind === 'income' && amt < 0)) return { categoryId: id, source: 'history', because: `${tx.merchant || 'this merchant'} was filed here ${n >= 3 ? 'before' : 'last time'}` };
    }
    const scored = keywordScores(`${tx.merchant || ''} ${tx.original || ''}`, cats).filter((s) => {
      const kind = cats.find((c) => c.id === s.id).kind;
      if (kind === 'income') return amt > 0; // a purchase never lands in income
      if (kind === 'expense') return amt < 0 || s.score >= 6; // money in under an expense needs a strong match: a refund from a named shop
      return true;
    });
    const account = ctx.account;
    if (scored.length) {
      let top = scored[0];
      // a payment landing on a credit card is a card payment, whatever words came with it
      if (account && account.type === 'credit' && amt > 0 && cats.find((c) => c.id === top.id).kind !== 'expense' && has(CC_PAYMENT)) top = { id: CC_PAYMENT, keyword: 'payment' };
      return { categoryId: top.id, source: 'keyword', because: `"${top.keyword}" in the description` };
    }
    if (account && account.type === 'credit' && amt > 0 && has(CC_PAYMENT)) return { categoryId: CC_PAYMENT, source: 'default', because: 'money in on a credit card' };
    if (amt > 0 && has(OTHER_INCOME)) return { categoryId: OTHER_INCOME, source: 'default', because: 'money in' };
    return { categoryId: UNCATEGORIZED, source: 'default', because: 'nothing matched yet' };
  }

  // ---- transactions ----------------------------------------------------------------------------------

  /** The pieces a transaction counts as: its splits when it has them, otherwise itself. */
  function linesOf(tx) {
    if (tx.splits && tx.splits.length) return tx.splits.map((s) => ({ categoryId: s.categoryId || UNCATEGORIZED, amount: Number(s.amount) || 0, notes: s.notes || '' }));
    return [{ categoryId: tx.categoryId || UNCATEGORIZED, amount: Number(tx.amount) || 0 }];
  }
  /** Splits that add up to the transaction, to the cent. */
  const splitsBalance = (tx, splits) => Math.round(sum(splits, (s) => Number(s.amount) || 0) * 100) === Math.round((Number(tx.amount) || 0) * 100);
  /** The key two copies of one transaction share: the account, the day, the signed amount in cents, and the merchant. */
  const importKey = (accountId, date, amount, merchant) => `${accountId || '-'}|${date}|${Math.round((Number(amount) || 0) * 100)}|${merchantKey(merchant).slice(0, 16)}`;

  /**
   * Pairs of transactions that are one transfer seen from both ends: the same amount out of one account and into
   * another within a few days. Each transaction pairs at most once, with the nearest date. Returns [outId, inId] pairs.
   */
  function findTransferPairs(transactions, opts) {
    const days = (opts && opts.days) || 4;
    const eligible = (t) => t && !t.hidden && !(t.splits && t.splits.length) && t.accountId;
    const ins = new Map();
    for (const t of transactions) if (eligible(t) && Number(t.amount) > 0) { const k = Math.round(Number(t.amount) * 100); if (!ins.has(k)) ins.set(k, []); ins.get(k).push(t); }
    const used = new Set();
    const out = [];
    const outs = transactions.filter((t) => eligible(t) && Number(t.amount) < 0).sort((a, b) => a.date.localeCompare(b.date));
    for (const t of outs) {
      const cands = (ins.get(Math.round(-Number(t.amount) * 100)) || []).filter((u) => !used.has(u.id) && u.accountId !== t.accountId && Math.abs(daysBetween(t.date, u.date)) <= days);
      if (!cands.length) continue;
      cands.sort((a, b) => Math.abs(daysBetween(t.date, a.date)) - Math.abs(daysBetween(t.date, b.date)));
      used.add(cands[0].id); used.add(t.id);
      out.push([t.id, cands[0].id]);
    }
    return out;
  }

  // ---- balances and net worth ---------------------------------------------------------------------------

  /**
   * A balance history for one account: `at(date)` gives the balance at the end of that day.
   * Transaction accounts walk from the nearest balance snapshot through the transactions in between (back in time by
   * taking them off, forward by adding them); with no snapshot at all the account starts from zero. Manual accounts
   * are the latest snapshot on or before the day, and before the first one the first one. `current` (the holdings'
   * value today) stands as a snapshot for today.
   */
  function makeLedger(account, transactions, snapshots, opts) {
    const mode = balanceModeOf(account);
    const today = (opts && opts.today) || todayISO();
    const snaps = (snapshots || []).filter((s) => s && ISO_DAY.test(s.date) && Number.isFinite(Number(s.balance))).map((s) => ({ date: s.date, balance: Number(s.balance) })).sort((a, b) => a.date.localeCompare(b.date));
    if (opts && opts.current != null && Number.isFinite(Number(opts.current))) {
      const i = snaps.findIndex((s) => s.date === today);
      if (i >= 0) snaps[i] = { date: today, balance: Number(opts.current) }; else { snaps.push({ date: today, balance: Number(opts.current) }); snaps.sort((a, b) => a.date.localeCompare(b.date)); }
    }
    const txs = mode === 'transactions' ? (transactions || []).filter((t) => t && ISO_DAY.test(t.date)).map((t) => ({ date: t.date, amount: Number(t.amount) || 0 })).sort((a, b) => a.date.localeCompare(b.date)) : [];
    const cum = [0];
    for (const t of txs) cum.push(cum[cum.length - 1] + t.amount);
    // the number of transactions on or before a date
    const upTo = (date) => { let lo = 0, hi = txs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (txs[mid].date <= date) lo = mid + 1; else hi = mid; } return lo; };
    const sumThrough = (date) => cum[upTo(date)];
    const snapOnOrBefore = (date) => { let best = null; for (const s of snaps) { if (s.date <= date) best = s; else break; } return best; };
    function at(date) {
      if (mode === 'manual') { const s = snapOnOrBefore(date) || snaps[0]; return s ? s.balance : 0; }
      const before = snapOnOrBefore(date);
      if (before) return cents(before.balance + sumThrough(date) - sumThrough(before.date));
      const after = snaps.find((s) => s.date > date);
      if (after) return cents(after.balance - (sumThrough(after.date) - sumThrough(date)));
      return cents(sumThrough(date));
    }
    const first = [snaps[0] && snaps[0].date, txs[0] && txs[0].date].filter(Boolean).sort()[0] || null;
    return { at, mode, firstDate: first, snapshots: snaps, current: at(today) };
  }

  /** Assets, liabilities, and net worth on each of `dates`, from one ledger per account. Hidden and excluded accounts are left out. */
  function netWorthSeries(accounts, ledgers, dates) {
    const counted = accounts.filter((a) => !a.excludeFromNetWorth && ledgers[a.id]);
    return dates.map((date) => {
      let assets = 0, liabilities = 0;
      for (const a of counted) {
        const ledger = ledgers[a.id];
        // an account opened later than this day was worth nothing to the owner on it
        if (a.openedOn && a.openedOn > date) continue;
        if (a.closedOn && a.closedOn < date) continue;
        const b = ledger.at(date);
        if (b >= 0) assets += b; else liabilities += -b;
      }
      return { date, assets: cents(assets), liabilities: cents(liabilities), net: cents(assets - liabilities) };
    });
  }
  /** The last day of each of the `n` months ending with today's, with today itself standing in for this month's end. */
  function monthEndDates(today, n) {
    const ym = monthOf(today);
    const out = [];
    for (let i = n - 1; i >= 1; i--) out.push(monthEnd(addMonthsYM(ym, -i)));
    out.push(today);
    return out;
  }

  // ---- cash flow ---------------------------------------------------------------------------------------

  /**
   * Income, spending, and saving between two dates (inclusive). A refund filed under a spending category lowers that
   * category's spending; transfers and hidden transactions are not cash flow. `opts.accountIds` limits it to accounts.
   */
  function cashFlow(transactions, index, from, to, opts) {
    const accountIds = opts && opts.accountIds ? new Set(opts.accountIds) : null;
    let income = 0, expenses = 0, count = 0;
    const byCategory = new Map(), byGroup = new Map(), byMerchant = new Map(), byTag = new Map();
    const bump = (map, key, field, v) => { if (!map.has(key)) map.set(key, { income: 0, spend: 0, count: 0 }); const o = map.get(key); o[field] += v; o.count++; };
    for (const t of transactions) {
      if (!t || t.hidden || t.date < from || t.date > to) continue;
      if (accountIds && !accountIds.has(t.accountId)) continue;
      let counted = false;
      for (const l of linesOf(t)) {
        const cat = index.get(l.categoryId);
        if (cat.kind === 'transfer') continue;
        counted = true;
        const field = cat.kind === 'income' ? 'income' : 'spend';
        const v = cat.kind === 'income' ? l.amount : -l.amount;
        if (field === 'income') income += v; else expenses += v;
        bump(byCategory, cat.id, field, v);
        bump(byGroup, cat.groupId, field, v);
        bump(byMerchant, t.merchant || '(no merchant)', field, v);
        for (const tag of t.tags || []) bump(byTag, tag, field, v);
      }
      if (counted) count++;
    }
    const round = (map) => { for (const o of map.values()) { o.income = cents(o.income); o.spend = cents(o.spend); } return map; };
    income = cents(income); expenses = cents(expenses);
    const net = cents(income - expenses);
    return { from, to, income, expenses, net, savingsRate: income > 0 ? net / income : null, count, byCategory: round(byCategory), byGroup: round(byGroup), byMerchant: round(byMerchant), byTag: round(byTag) };
  }
  /** One cash-flow summary per month, oldest first. */
  function monthlyFlow(transactions, index, months, opts) {
    return months.map((ym) => Object.assign({ month: ym }, cashFlow(transactions, index, monthStart(ym), monthEnd(ym), opts)));
  }
  /**
   * Spending added up day by day through a month: entry d-1 is what was spent by the end of day d. Days after `upTo`
   * are null, so this month's line stops at today. Transfers, income, and hidden transactions do not count.
   */
  function cumulativeSpend(transactions, index, ym, upTo) {
    const n = daysInMonth(ym);
    const daily = new Array(n).fill(0);
    const start = monthStart(ym), end = monthEnd(ym);
    for (const t of transactions) {
      if (!t || t.hidden || t.date < start || t.date > end) continue;
      for (const l of linesOf(t)) { const k = index.kindOf(l.categoryId); if (k === 'expense') daily[Number(t.date.slice(8, 10)) - 1] += -l.amount; }
    }
    const out = [];
    let run = 0;
    for (let d = 1; d <= n; d++) {
      run += daily[d - 1];
      out.push(upTo && `${ym}-${pad2(d)}` > upTo ? null : cents(run));
    }
    return out;
  }

  // ---- budgets -----------------------------------------------------------------------------------------

  /** Budget rows by category, oldest month first, for budgetFor. */
  function budgetIndex(rows) {
    const m = new Map();
    for (const r of rows || []) {
      if (!r || !YM.test(r.month) || !r.categoryId) continue;
      if (!m.has(r.categoryId)) m.set(r.categoryId, []);
      m.get(r.categoryId).push({ month: r.month, amount: Number(r.amount) || 0 });
    }
    for (const list of m.values()) list.sort((a, b) => a.month.localeCompare(b.month));
    return m;
  }
  /**
   * A category's budget for a month: the amount set for that month, or else the most recent month before it that had
   * one, so a budget set once carries on until it is changed. A month set to 0 stops it. `source` says which.
   */
  function budgetFor(index, categoryId, ym) {
    const list = index.get(categoryId);
    if (!list) return { amount: 0, source: 'none' };
    let best = null;
    for (const r of list) { if (r.month <= ym) best = r; else break; }
    if (!best) return { amount: 0, source: 'none' };
    return { amount: best.amount, source: best.month === ym ? 'set' : 'carried', from: best.month };
  }
  /** Spending (or for income categories, income) per category in a month, transfers left out. */
  function actualsFor(transactions, index, ym) {
    const flow = cashFlow(transactions, index, monthStart(ym), monthEnd(ym));
    const out = new Map();
    for (const [id, o] of flow.byCategory) out.set(id, index.kindOf(id) === 'income' ? o.income : o.spend);
    return out;
  }
  /**
   * The month's budget, laid out the way the Budget view shows it.
   *   income: planned and actual, per income category
   *   expense: planned, actual, and what is left, per category within each group; a category with rollover carries
   *            what was left (or overspent) in each month since rollover started
   *   flex: the three buckets (fixed, flexible, non-monthly) when the budget is kept that way; the flexible bucket has
   *         one pooled figure (category '__flexible') and non-monthly categories always roll over
   */
  function budgetMonth(input) {
    const { month, index, budgets, transactions } = input;
    const flex = input.mode === 'flex';
    const bIndex = budgetIndex(budgets);
    const actual = actualsFor(transactions, index, month);
    const actualCache = new Map([[month, actual]]);
    const actualIn = (ym) => { if (!actualCache.has(ym)) actualCache.set(ym, actualsFor(transactions, index, ym)); return actualCache.get(ym); };
    const firstBudgetMonth = (id) => { const l = bIndex.get(id); return l && l.length ? l[0].month : null; };
    const rolls = (c) => c.rollover || (flex && c.budget === 'nonmonthly');
    function carried(c) {
      if (!rolls(c)) return 0;
      const start = c.rolloverStart || firstBudgetMonth(c.id);
      if (!start || start >= month) return 0;
      let total = 0;
      // at most three years back, so a rollover begun long ago stays quick to work out
      const from = monthsBetween(start, month) > 36 ? addMonthsYM(month, -36) : start;
      for (const ym of monthRange(from, addMonthsYM(month, -1))) total += budgetFor(bIndex, c.id, ym).amount - (actualIn(ym).get(c.id) || 0);
      return cents(total);
    }
    const visible = (c) => !c.hidden || (actual.get(c.id) || 0) !== 0 || budgetFor(bIndex, c.id, month).amount !== 0;
    const incomeRows = index.list.filter((c) => c.kind === 'income' && visible(c)).map((c) => {
      const b = budgetFor(bIndex, c.id, month);
      return { category: c, planned: b.amount, source: b.source, actual: cents(actual.get(c.id) || 0) };
    });
    const groups = [];
    for (const g of GROUPS) {
      if (g.kind !== 'expense') continue;
      const rows = (index.byGroup.get(g.id) || []).filter(visible).map((c) => {
        const b = budgetFor(bIndex, c.id, month);
        const inFlexPool = flex && c.budget === 'flexible';
        const planned = inFlexPool ? 0 : b.amount;
        const rollover = inFlexPool ? 0 : carried(c);
        const spent = cents(actual.get(c.id) || 0);
        const available = cents(planned + rollover);
        return { category: c, planned, source: b.source, rollover, actual: spent, available, remaining: cents(available - spent), bucket: c.budget };
      });
      if (!rows.length) continue;
      groups.push({ group: g, rows, planned: cents(sum(rows, (r) => r.planned)), actual: cents(sum(rows, (r) => r.actual)), available: cents(sum(rows, (r) => r.available)) });
    }
    const allRows = groups.flatMap((g) => g.rows);
    const flexPool = flex ? budgetFor(bIndex, '__flexible', month) : null;
    const bucket = (id) => allRows.filter((r) => r.bucket === id);
    const flexOut = flex ? {
      fixed: { planned: cents(sum(bucket('fixed'), (r) => r.planned)), actual: cents(sum(bucket('fixed'), (r) => r.actual)) },
      flexible: { planned: flexPool.amount, source: flexPool.source, actual: cents(sum(bucket('flexible'), (r) => r.actual)) },
      nonmonthly: { planned: cents(sum(bucket('nonmonthly'), (r) => r.planned)), actual: cents(sum(bucket('nonmonthly'), (r) => r.actual)), available: cents(sum(bucket('nonmonthly'), (r) => r.available)) },
    } : null;
    if (flexOut) flexOut.flexible.remaining = cents(flexOut.flexible.planned - flexOut.flexible.actual);
    const incomePlanned = cents(sum(incomeRows, (r) => r.planned));
    const expensePlanned = cents(sum(allRows, (r) => r.planned) + (flexOut ? flexOut.flexible.planned : 0));
    const expenseActual = cents(sum(allRows, (r) => r.actual));
    return {
      month, mode: flex ? 'flex' : 'category',
      income: { planned: incomePlanned, actual: cents(sum(incomeRows, (r) => r.actual)), rows: incomeRows },
      expense: { planned: expensePlanned, actual: expenseActual, groups },
      flex: flexOut,
      leftToBudget: cents(incomePlanned - expensePlanned),
      remaining: cents(expensePlanned - expenseActual),
      hasBudget: allRows.some((r) => r.planned > 0) || incomePlanned > 0 || !!(flexOut && flexOut.flexible.planned > 0),
    };
  }
  /** A budget figure from what was actually spent: the average of the last `n` full months before `ym`, rounded to a tidy number. */
  function suggestBudget(transactions, index, categoryId, ym, n) {
    n = n || 3;
    let total = 0;
    for (let i = 1; i <= n; i++) total += actualsFor(transactions, index, addMonthsYM(ym, -i)).get(categoryId) || 0;
    const avg = total / n;
    if (avg <= 0) return 0;
    const step = avg >= 1000 ? 50 : avg >= 100 ? 10 : 5;
    return Math.round(avg / step) * step || step;
  }

  // ---- recurring ---------------------------------------------------------------------------------------

  const CADENCES = [
    { id: 'weekly', label: 'Weekly', days: 7, tol: 2, min: 4, perMonth: 52 / 12 },
    { id: 'biweekly', label: 'Every 2 weeks', days: 14, tol: 3, min: 3, perMonth: 26 / 12 },
    { id: 'monthly', label: 'Monthly', days: 30.44, tol: 5, min: 3, months: 1, perMonth: 1 },
    { id: 'quarterly', label: 'Quarterly', days: 91.3, tol: 12, min: 3, months: 3, perMonth: 1 / 3 },
    { id: 'semiannual', label: 'Twice a year', days: 182.6, tol: 20, min: 2, months: 6, perMonth: 1 / 6 },
    { id: 'annual', label: 'Yearly', days: 365.25, tol: 25, min: 2, months: 12, perMonth: 1 / 12 },
  ];
  const cadenceById = (id) => CADENCES.find((c) => c.id === id) || null;
  const nthDate = (anchor, cadence, k) => (cadence.months ? addMonths(anchor, k * cadence.months) : addDays(anchor, Math.round(k * cadence.days)));
  const STREAM_STATUS = { overdue: 0, due: 1, upcoming: 2, lapsed: 3 };
  const streamKey = (merchant, sign) => `${merchantKey(merchant)}|${sign}`;

  /**
   * Bills, subscriptions, and paychecks that come round on a steady cadence. A merchant recurs when its charges keep
   * to one interval and one amount: a monthly bill may wander a few days and a utility bill may vary, but the weekly
   * grocery run never counts, because its amount is all over the place. Two identical charges a month apart are
   * enough to call a subscription; anything else needs three.
   * `opts`: { today, overrides: Map(key -> row), index }
   */
  function detectRecurring(transactions, opts) {
    const today = opts.today || todayISO();
    const overrides = opts.overrides || new Map();
    const index = opts.index;
    const groups = new Map();
    for (const t of transactions) {
      if (!t || t.hidden || !t.merchant || !ISO_DAY.test(t.date) || t.date > today) continue;
      // moving money between your own accounts is not a bill; paying the card is, but the card's side of it is not income
      if (index && index.kindOf(t.categoryId) === 'transfer' && !(t.categoryId === CC_PAYMENT && Number(t.amount) < 0)) continue;
      const sign = Number(t.amount) >= 0 ? 'in' : 'out';
      const k = streamKey(t.merchant, sign);
      if (!merchantKey(t.merchant)) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const out = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date));
      const occ = [];
      for (const t of list) { const last = occ[occ.length - 1]; if (last && last.date === t.date) { last.amount += Math.abs(Number(t.amount)); last.ids.push(t.id); } else occ.push({ date: t.date, amount: Math.abs(Number(t.amount)), ids: [t.id], tx: t }); }
      if (occ.length < 2) continue;
      const intervals = [];
      for (let i = 1; i < occ.length; i++) intervals.push(daysBetween(occ[i - 1].date, occ[i].date));
      const med = median(intervals);
      const amounts = occ.map((o) => o.amount);
      const recent = amounts.slice(-6);
      const mean = sum(recent) / recent.length;
      const sd = Math.sqrt(sum(recent, (a) => (a - mean) ** 2) / recent.length);
      const cv = mean > 0 ? sd / mean : 1;
      const identical = recent.every((a) => Math.round(a * 100) === Math.round(recent[0] * 100));
      let cadence = null;
      for (const c of CADENCES) {
        if (Math.abs(med - c.days) > c.tol) continue;
        const min = identical && c.months ? 2 : c.min;
        if (occ.length < min) continue;
        const misses = intervals.slice(-8).filter((iv) => Math.abs(iv - c.days) > c.tol).length;
        if (misses > (occ.length >= 6 ? 1 : 0)) continue;
        cadence = c; break;
      }
      if (!cadence) continue;
      const sign = key.endsWith('|in') ? 'in' : 'out';
      // an amount that varies this much is a habit, not a bill: weekly and every-two-weeks charges have to hold steady
      const limit = sign === 'in' ? 0.35 : cadence.days <= 14 ? 0.12 : 0.4;
      if (cv > limit) continue;
      const last = occ[occ.length - 1];
      const ov = overrides.get(key) || null;
      const chosen = ov && cadenceById(ov.cadence) ? cadenceById(ov.cadence) : cadence;
      let next = nthDate(last.date, chosen, 1);
      const overdueBy = daysBetween(next, today);
      const lapseAfter = Math.max(chosen.days + 2 * chosen.tol, 45);
      let status = 'upcoming';
      if (overdueBy > lapseAfter) status = 'lapsed';
      else if (overdueBy > chosen.tol) status = 'overdue';
      else if (overdueBy >= -2) status = 'due';
      // a steady charge whose latest amount moved is a price change: the next one is expected at the new price. A bill that
      // always varies (power, water) is expected at the middle of its last three.
      const before = recent.slice(0, -1);
      const steadyBefore = before.length >= 1 && before.every((a) => Math.abs(a - before[before.length - 1]) <= Math.max(0.01, 0.02 * a));
      const prev = before.length ? cents(median(before.slice(-3))) : cents(recent[0]);
      const typical = steadyBefore ? cents(recent[recent.length - 1]) : cents(median(recent.slice(-3)));
      const lastTx = last.tx;
      out.push({
        key, merchant: (ov && ov.name) || lastTx.merchant, sign, categoryId: lastTx.categoryId || UNCATEGORIZED, accountId: lastTx.accountId,
        cadence: chosen.id, cadenceLabel: chosen.label, perMonth: chosen.perMonth,
        amount: ov && Number.isFinite(Number(ov.amount)) && Number(ov.amount) > 0 ? cents(Number(ov.amount)) : typical,
        lastAmount: cents(last.amount), previousAmount: prev, varies: !steadyBefore && !identical && cv > 0.02, count: occ.length,
        lastDate: last.date, nextDate: next, status, overdueBy, ignored: !!(ov && ov.status === 'ignored'), confirmed: !!(ov && ov.status === 'confirmed'),
        occurrences: occ.map((o) => ({ date: o.date, amount: cents(o.amount), ids: o.ids })),
      });
    }
    out.sort((a, b) => STATUS_ORDER(a) - STATUS_ORDER(b) || a.nextDate.localeCompare(b.nextDate));
    return out;
  }
  const STATUS_ORDER = (s) => (s.ignored ? 9 : STREAM_STATUS[s.status]);
  /** The dates each live stream is expected between two days (inclusive), soonest first; overdue streams are expected today. */
  function upcoming(streams, from, to) {
    const out = [];
    for (const s of streams) {
      if (s.ignored || s.status === 'lapsed') continue;
      const c = cadenceById(s.cadence);
      if (s.status === 'overdue' && from <= to) out.push({ date: from, stream: s, amount: s.amount, overdue: true });
      for (let k = 1; k < 400; k++) {
        const d = nthDate(s.lastDate, c, k);
        if (d > to) break;
        if (d < from) continue;
        out.push({ date: d, stream: s, amount: s.amount, overdue: false });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  }
  /** What the live recurring streams cost (or bring in) in a typical month. */
  function recurringMonthly(streams) {
    let out = 0, inn = 0;
    for (const s of streams) { if (s.ignored || s.status === 'lapsed') continue; const v = s.amount * s.perMonth; if (s.sign === 'in') inn += v; else out += v; }
    return { out: cents(out), in: cents(inn) };
  }

  // ---- goals -------------------------------------------------------------------------------------------

  /**
   * Where a goal stands. A savings goal counts the balances of the accounts tied to it, or, with none, the starting
   * amount and the contributions logged against it. A payoff goal counts how much of the debt on its accounts is gone
   * since `startAmount` (what was owed when it began). `ctx.balanceOn(accountId, date)`.
   */
  function goalProgress(goal, ctx, today) {
    today = today || todayISO();
    const target = Math.max(0, Number(goal.target) || 0);
    const accounts = (goal.accountIds || []).filter(Boolean);
    const contributions = (goal.contributions || []).filter((c) => c && ISO_DAY.test(c.date) && Number.isFinite(Number(c.amount)));
    const debt = goal.kind === 'debt';
    const savedOn = (date) => {
      if (accounts.length && ctx && ctx.balanceOn) {
        const total = sum(accounts, (id) => ctx.balanceOn(id, date) || 0);
        return debt ? (Number(goal.startAmount) || 0) - Math.max(0, -total) : total;
      }
      return (Number(goal.startAmount) || 0) + sum(contributions.filter((c) => c.date <= date), (c) => Number(c.amount));
    };
    const goalTarget = debt ? Math.max(target, Number(goal.startAmount) || 0) : target;
    const saved = cents(Math.max(0, savedOn(today)));
    const ago = addDays(today, -90);
    const pace = cents(Math.max(0, (savedOn(today) - savedOn(ago)) / 3)); // a month's progress, averaged over the last three
    const remaining = cents(Math.max(0, goalTarget - saved));
    const done = goalTarget > 0 && remaining <= 0;
    const monthsLeft = goal.targetDate && ISO_DAY.test(goal.targetDate) ? Math.max(0, monthsBetween(monthOf(today), monthOf(goal.targetDate))) : null;
    const monthlyNeeded = done ? 0 : monthsLeft != null ? cents(remaining / Math.max(1, monthsLeft)) : null;
    const projected = done ? today : pace > 0 ? addMonths(today, Math.ceil(remaining / pace)) : null;
    let status = 'no_date';
    if (done) status = 'done';
    else if (goal.targetDate) status = projected && projected <= goal.targetDate ? 'on_track' : 'behind';
    return { saved, target: goalTarget, remaining, pct: goalTarget > 0 ? Math.min(1, saved / goalTarget) : 0, monthsLeft, monthlyNeeded, pace, projected, status };
  }

  // ---- investments ---------------------------------------------------------------------------------------

  const ASSET_CLASSES = [
    { id: 'us_stock', label: 'US stocks', slot: 1 },
    { id: 'intl_stock', label: 'International stocks', slot: 2 },
    { id: 'bond', label: 'Bonds', slot: 3 },
    { id: 'cash', label: 'Cash', slot: 4 },
    { id: 'real_estate', label: 'Real estate', slot: 5 },
    { id: 'crypto', label: 'Crypto', slot: 7 },
    { id: 'other', label: 'Other', slot: 0 },
  ];
  /** A first guess at a holding's asset class from its symbol and name; the user can change it. */
  function guessAssetClass(symbol, name) {
    const s = `${symbol || ''} ${name || ''}`.toLowerCase();
    if (/\b(btc|eth|bitcoin|ethereum|crypto|sol|doge)\b/.test(s)) return 'crypto';
    if (/money market|\bspaxx\b|\bvmfxx\b|\bswvxx\b|\bfdrxx\b|\bcash\b|sweep|treasury bill|t-bill/.test(s)) return 'cash';
    if (/\b(bnd|agg|bndx|vbtlx|fxnax|tlt|ief|shy|bil|lqd|hyg|vgit|vglt|bsv|biv|blv|schz)\b|bond|fixed income|treasury|municipal/.test(s)) return 'bond';
    if (/\b(vnq|vnqi|schh|iyr|xlre|fsrnx)\b|reit|real estate/.test(s)) return 'real_estate';
    if (/\b(vxus|vtiax|ixus|efa|vea|vwo|iemg|ftihx|fspsx|swiss|schf|iefa|acwx)\b|international|intl|emerging|developed markets|ex-us|ex us|global ex/.test(s)) return 'intl_stock';
    return 'us_stock';
  }
  const holdingValue = (h) => cents((Number(h.shares) || 0) * (Number(h.price) || 0));
  /** The portfolio's value, cost, gain, and mix by asset class and by account. */
  function portfolio(holdings) {
    const list = (holdings || []).filter(Boolean);
    let value = 0, cost = 0, costKnown = 0;
    const byClass = new Map(), byAccount = new Map();
    for (const h of list) {
      const v = holdingValue(h);
      value += v;
      if (h.costBasis != null && h.costBasis !== '' && Number.isFinite(Number(h.costBasis))) { cost += Number(h.costBasis); costKnown += v; }
      const cls = ASSET_CLASSES.some((c) => c.id === h.assetClass) ? h.assetClass : guessAssetClass(h.symbol, h.name);
      byClass.set(cls, (byClass.get(cls) || 0) + v);
      byAccount.set(h.accountId, (byAccount.get(h.accountId) || 0) + v);
    }
    const classes = ASSET_CLASSES.map((c) => ({ id: c.id, label: c.label, slot: c.slot, value: cents(byClass.get(c.id) || 0), share: value > 0 ? (byClass.get(c.id) || 0) / value : 0 })).filter((c) => c.value !== 0);
    const gain = cents(costKnown - cost);
    return { value: cents(value), cost: cents(cost), gain, gainPct: cost > 0 ? gain / cost : null, costCovered: value > 0 ? costKnown / value : 0, classes, byAccount: new Map(Array.from(byAccount, ([k, v]) => [k, cents(v)])), count: list.length };
  }

  // ---- insights ------------------------------------------------------------------------------------------

  /**
   * Things worth saying about the money, newest first in importance. Each has an id (for dismissing), a level (act,
   * warn, good, info, as on the tax side), a title, a sentence that says why, and the view that deals with it.
   * `ctx`: { today, transactions, index, budget (budgetMonth for this month), streams, goals: [{goal, progress}],
   *          cashAccounts: [{account, balance}], reviewCount }
   */
  function insights(ctx) {
    const out = [];
    const { today, transactions, index } = ctx;
    const ym = monthOf(today);
    const day = Number(today.slice(8, 10));
    const dim = daysInMonth(ym);
    // spending pace against last month by the same day
    const thisMonth = cumulativeSpend(transactions, index, ym, today);
    const lastYm = addMonthsYM(ym, -1);
    const lastMonth = cumulativeSpend(transactions, index, lastYm);
    const nowSpent = thisMonth[day - 1] || 0;
    const thenSpent = lastMonth[Math.min(day, lastMonth.length) - 1] || 0;
    if (thenSpent > 100 && nowSpent > thenSpent * 1.15 && nowSpent - thenSpent > 100) {
      out.push({ id: `pace:${ym}`, level: 'warn', title: `Spending is ${money(nowSpent - thenSpent)} ahead of last month`, body: `${money(nowSpent)} so far this month against ${money(thenSpent)} by the same day of ${monthLabel(lastYm, { long: true, noYear: true })}.`, view: 'cashflow' });
    } else if (thenSpent > 100 && nowSpent < thenSpent * 0.85 && day >= 7) {
      out.push({ id: `pace:${ym}`, level: 'good', title: `Spending is ${money(thenSpent - nowSpent)} behind last month`, body: `${money(nowSpent)} so far this month against ${money(thenSpent)} by the same day of ${monthLabel(lastYm, { long: true, noYear: true })}.`, view: 'cashflow' });
    }
    // budget categories already over
    if (ctx.budget && ctx.budget.hasBudget) {
      const over = ctx.budget.expense.groups.flatMap((g) => g.rows).filter((r) => r.available > 0 && r.remaining < 0).sort((a, b) => a.remaining - b.remaining);
      for (const r of over.slice(0, 3)) out.push({ id: `over:${ym}:${r.category.id}`, level: 'warn', title: `${r.category.name} is ${money(-r.remaining)} over budget`, body: `${money(r.actual)} spent against ${money(r.available)} for ${monthLabel(ym, { long: true, noYear: true })}.`, view: 'budget' });
      const f = ctx.budget.flex;
      if (f && f.flexible.planned > 0 && f.flexible.remaining < 0) out.push({ id: `over:${ym}:__flexible`, level: 'warn', title: `Flexible spending is ${money(-f.flexible.remaining)} over`, body: `${money(f.flexible.actual)} spent against ${money(f.flexible.planned)} for day-to-day categories this month.`, view: 'budget' });
      const pace = day / dim;
      const near = ctx.budget.expense.groups.flatMap((g) => g.rows).filter((r) => r.available >= 50 && r.remaining >= 0 && r.actual / r.available > Math.max(0.9, pace + 0.25) && r.category.budget === 'flexible');
      for (const r of near.slice(0, 2)) out.push({ id: `near:${ym}:${r.category.id}`, level: 'act', title: `${money(r.remaining)} left for ${r.category.name}`, body: `${pct(r.actual / r.available)} of the ${monthLabel(ym, { long: true, noYear: true })} budget is gone with ${dim - day} ${dim - day === 1 ? 'day' : 'days'} to go.`, view: 'budget' });
    }
    // a category running well above its own average
    const avgOf = (id) => { let t = 0; for (let i = 1; i <= 3; i++) { const f = cashFlow(transactions, index, monthStart(addMonthsYM(ym, -i)), monthEnd(addMonthsYM(ym, -i))); t += (f.byCategory.get(id) || { spend: 0 }).spend; } return t / 3; };
    const flowNow = cashFlow(transactions, index, monthStart(ym), today);
    const spikes = [];
    for (const [id, o] of flowNow.byCategory) {
      if (index.kindOf(id) !== 'expense' || id === UNCATEGORIZED || o.spend < 150) continue;
      const avg = avgOf(id);
      if (avg >= 50 && o.spend > avg * 1.5 && o.spend - avg > 100) spikes.push({ id, spend: o.spend, avg });
    }
    spikes.sort((a, b) => (b.spend - b.avg) - (a.spend - a.avg));
    for (const s of spikes.slice(0, 2)) out.push({ id: `spike:${ym}:${s.id}`, level: 'info', title: `${index.get(s.id).name} is running high`, body: `${money(s.spend)} so far this month; the last three months averaged ${money(s.avg)}.`, view: 'cashflow' });
    // bills in the next week, and whether checking covers them
    const soon = upcoming((ctx.streams || []).filter((s) => s.sign === 'out'), today, addDays(today, 7));
    if (soon.length) {
      const total = cents(sum(soon, (u) => u.amount));
      out.push({ id: `bills:${today}`, level: 'info', title: `${soon.length} ${soon.length === 1 ? 'bill' : 'bills'} due in the next 7 days`, body: `${soon.slice(0, 3).map((u) => `${u.stream.merchant} ${money(u.amount, { cents: u.amount < 100 })} ${u.overdue ? '(overdue)' : dayLabel(u.date)}`).join(', ')}${soon.length > 3 ? ', and more' : ''}: ${money(total)} in all.`, view: 'recurring' });
      const cash = sum(ctx.cashAccounts || [], (c) => c.balance);
      if ((ctx.cashAccounts || []).length && cash < total) out.push({ id: `short:${today}`, level: 'warn', title: 'Upcoming bills are more than the cash on hand', body: `${money(total)} is due this week and checking and savings hold ${money(cash)}.`, view: 'accounts' });
    }
    // a subscription that went up
    for (const s of ctx.streams || []) {
      if (s.ignored || s.status === 'lapsed' || s.sign !== 'out' || s.varies || s.count < 3) continue;
      const rise = s.lastAmount - s.previousAmount;
      if (rise >= 1 && rise / Math.max(s.previousAmount, 1) >= 0.05 && daysBetween(s.lastDate, today) <= 40) out.push({ id: `rise:${s.key}:${s.lastDate}`, level: 'act', title: `${s.merchant} went up to ${money(s.lastAmount, { cents: true })}`, body: `It was ${money(s.previousAmount, { cents: true })} ${s.cadenceLabel.toLowerCase()} before the charge on ${dayLabel(s.lastDate)}: ${money(rise * 12 * s.perMonth)} a year more.`, view: 'recurring' });
    }
    // a charge far outside what the category usually sees
    const recentStart = addDays(today, -10);
    const histStart = addDays(today, -180);
    const byCat = new Map();
    for (const t of transactions) {
      if (t.hidden || t.date < histStart || t.date > today || Number(t.amount) >= 0 || (t.splits && t.splits.length)) continue;
      if (index.kindOf(t.categoryId) !== 'expense') continue;
      if (!byCat.has(t.categoryId)) byCat.set(t.categoryId, []);
      byCat.get(t.categoryId).push(t);
    }
    for (const [id, list] of byCat) {
      if (list.length < 6) continue;
      const med = median(list.map((t) => -Number(t.amount)));
      for (const t of list) if (t.date >= recentStart && -t.amount >= 250 && -t.amount > med * 3) out.push({ id: `big:${t.id}`, level: 'info', title: `A large ${index.get(id).name.toLowerCase()} charge: ${money(-t.amount)}`, body: `${t.merchant || 'A charge'} on ${dayLabel(t.date)}; ${index.get(id).name} purchases are usually about ${money(med)}.`, view: 'transactions', params: { q: t.merchant || '' } });
    }
    // goals behind
    for (const g of ctx.goals || []) {
      if (g.progress.status === 'behind' && g.progress.monthlyNeeded) out.push({ id: `goal:${g.goal.id}:${ym}`, level: 'act', title: `${g.goal.name} needs ${money(g.progress.monthlyNeeded)} a month`, body: `${money(g.progress.remaining)} to go by ${dayLabel(g.goal.targetDate, true)}${g.progress.pace > 0 ? `; the last three months averaged ${money(g.progress.pace)}` : ''}.`, view: 'goals' });
      else if (g.progress.status === 'done') out.push({ id: `goaldone:${g.goal.id}`, level: 'good', title: `${g.goal.name} is fully funded`, body: `${money(g.progress.saved)} of ${money(g.progress.target)}.`, view: 'goals' });
    }
    if (ctx.reviewCount) out.push({ id: `review:${today}`, level: 'act', title: `${ctx.reviewCount} ${ctx.reviewCount === 1 ? 'transaction' : 'transactions'} to review`, body: 'Check the category on each new transaction once; what you confirm teaches the suggestions.', view: 'transactions', params: { filter: 'review' } });
    // the month so far
    if (flowNow.income > 0 && day >= 20) {
      if (flowNow.net < 0) out.push({ id: `neg:${ym}`, level: 'warn', title: `${money(-flowNow.net)} more went out than came in this month`, body: `${money(flowNow.income)} in and ${money(flowNow.expenses)} out since ${dayLabel(monthStart(ym))}.`, view: 'cashflow' });
      else if (flowNow.savingsRate >= 0.2) out.push({ id: `save:${ym}`, level: 'good', title: `${pct(flowNow.savingsRate)} of this month's income saved so far`, body: `${money(flowNow.net)} kept from ${money(flowNow.income)} in.`, view: 'cashflow' });
    }
    const rank = { warn: 0, act: 1, info: 2, good: 3 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  // ---- example data ----------------------------------------------------------------------------------------

  /** A small seeded generator, so the example household is the same every time it is loaded and in every test. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /**
   * An example household: a checking and savings account, a rewards card, a brokerage and a 401(k), a house with its
   * mortgage, a car with its loan, and seven months of ordinary life up to `today`. Every row carries `sample: true` so
   * the whole set can be taken away again, and nothing is dated after today.
   */
  function sampleData(today) {
    today = today || todayISO();
    const r = rng(20261014);
    const between = (lo, hi) => cents(lo + (hi - lo) * r());
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const now = new Date().toISOString();
    const acct = (id, name, type, extra) => Object.assign({ id: `sample-acct-${id}`, name, type, institution: '', mask: '', balanceMode: accountType(type).mode, hidden: false, closed: false, excludeFromNetWorth: false, sample: true, createdAt: now, updatedAt: now }, extra || {});
    const accounts = [
      acct('checking', 'Everyday Checking', 'checking', { institution: 'Coastal Federal', mask: '4821' }),
      acct('savings', 'High-Yield Savings', 'savings', { institution: 'Coastal Federal', mask: '9930' }),
      acct('card', 'Rewards Visa', 'credit', { institution: 'Harbor Bank', mask: '1177' }),
      acct('brokerage', 'Brokerage', 'brokerage', { institution: 'Index Brokerage', mask: '6402' }),
      acct('401k', '401(k)', 'retirement', { institution: 'Employer plan' }),
      acct('home', 'Home', 'property'),
      acct('mortgage', 'Mortgage', 'mortgage', { institution: 'Harbor Bank', mask: '0071' }),
      acct('car', 'Car', 'vehicle'),
      acct('autoloan', 'Auto loan', 'loan', { institution: 'Coastal Federal', mask: '5530' }),
    ];
    const A = Object.fromEntries(accounts.map((a) => [a.id.replace('sample-acct-', ''), a.id]));
    const start = monthStart(addMonthsYM(monthOf(today), -6));
    const txs = [];
    let n = 0;
    const tx = (accountId, date, amount, merchant, categoryId, extra) => {
      if (date > today || date < start) return;
      txs.push(Object.assign({ id: `sample-tx-${++n}`, accountId, date, amount: cents(amount), merchant, original: merchant.toUpperCase(), categoryId, notes: '', tags: [], reviewed: true, hidden: false, source: 'sample', sample: true, createdAt: now, updatedAt: now }, extra || {}));
    };
    const months = monthRange(monthOf(start), monthOf(today));
    // paychecks every other Friday
    let pay = start;
    while (new Date(Date.UTC(...pay.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))).getUTCDay() !== 5) pay = addDays(pay, 1);
    for (; pay <= today; pay = addDays(pay, 14)) tx(A.checking, pay, 2412.5, 'Coastal Logistics Payroll', 'paycheck', { original: 'COASTAL LOGISTICS DIR DEP PAYROLL' });
    for (const ym of months) {
      const d = (day) => `${ym}-${pad2(Math.min(day, daysInMonth(ym)))}`;
      tx(A.checking, d(1), -1684.22, 'Harbor Bank Mortgage', 'mortgage', { original: 'HARBOR BANK MTG PMT' });
      tx(A.checking, d(5), -389.4, 'Coastal Federal Auto Loan', 'auto_payment', { original: 'COASTAL FCU AUTO LOAN PMT' });
      tx(A.checking, d(8), between(-178, -96), 'Duke Energy', 'electric_gas', { original: 'DUKE ENERGY PAYMENT' });
      tx(A.checking, d(12), -64.99, 'Spectrum', 'internet', { original: 'SPECTRUM 855-707-7328 NC' });
      tx(A.checking, d(15), -600, 'Transfer to High-Yield Savings', 'transfer', { original: 'ONLINE TRANSFER TO SAV ...9930' });
      tx(A.savings, d(15), 600, 'Transfer from Everyday Checking', 'transfer', { original: 'ONLINE TRANSFER FROM CHK ...4821' });
      tx(A.savings, d(28), between(38, 46), 'Interest Paid', 'interest_income', { original: 'INTEREST PAID' });
      tx(A.checking, d(20), -40, 'First Baptist Church', 'charity', { original: 'TITHELY FIRST BAPTIST' });
      tx(A.card, d(3), -15.49, 'Netflix', 'subscriptions', { original: 'NETFLIX.COM' });
      tx(A.card, d(9), -11.99, 'Spotify', 'subscriptions', { original: 'SPOTIFY USA' });
      tx(A.card, d(14), -71.38, 'Verizon', 'phone', { original: 'VZWRLSS*APOCC VISE' });
      tx(A.card, d(2), -34.99, 'Planet Fitness', 'fitness', { original: 'PLANET FITNESS MOREHEAD' });
      tx(A.card, d(22), -20, 'Anthropic', 'subscriptions', { original: 'ANTHROPIC CLAUDE.AI' });
      // weekly groceries, coffee, takeout, and gas on the card
      for (let day = 1; day <= daysInMonth(ym); day++) {
        const date = d(day);
        const wd = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, day)).getUTCDay();
        if (wd === 6) tx(A.card, date, between(-182, -96), pick(['Harris Teeter', 'Food Lion', 'Food Lion']), 'groceries');
        if (wd === 3 && r() < 0.6) tx(A.card, date, between(-48, -22), pick(['Food Lion', 'Harris Teeter']), 'groceries');
        if ((wd === 1 || wd === 4) && r() < 0.7) tx(A.card, date, between(-7.5, -4.25), pick(['Starbucks', 'Morning Tide Coffee']), 'coffee');
        if ((wd === 5 || wd === 6) && r() < 0.55) tx(A.card, date, between(-68, -24), pick(['El Zarape', 'Ruddy Duck Tavern', 'Cook Out', 'Chick-fil-A', 'Captain Bill’s Waterfront']), 'restaurants');
        if (wd === 2 && r() < 0.8) tx(A.card, date, between(-54, -36), pick(['Shell', 'Wawa', 'Circle K']), 'gas_fuel');
        if (r() < 0.07) tx(A.card, date, between(-86, -12), 'Amazon', 'shopping');
        if (r() < 0.025) tx(A.card, date, between(-140, -40), pick(['Target', 'Old Navy', 'The Home Depot']), pick(['shopping', 'clothing', 'home_improvement']));
      }
      if (r() < 0.6) tx(A.card, d(11), between(-28, -14), 'CVS', 'pharmacy', { original: 'CVS/PHARMACY #07741' });
    }
    // the year's occasional ones
    const m = (k) => addMonthsYM(monthOf(today), -k);
    tx(A.card, `${m(5)}-18`, -45, 'Carolina East Family Medicine', 'medical', { original: 'CAROLINA EAST MED CTR' });
    tx(A.card, `${m(3)}-07`, -210, 'Crystal Coast Dental', 'dentist');
    tx(A.checking, `${m(4)}-02`, -612, 'GEICO', 'insurance', { original: 'GEICO *AUTO' });
    tx(A.card, `${m(2)}-16`, -486.2, 'Delta Air Lines', 'travel', { notes: 'Thanksgiving flights' });
    tx(A.card, `${m(2)}-21`, -138, 'Jiffy Lube', 'auto_maintenance');
    tx(A.card, `${m(1)}-09`, -139, 'Amazon Prime', 'subscriptions', { original: 'AMAZON PRIME*2K4LL1' });
    tx(A.checking, `${m(4)}-27`, 1180, 'IRS Treas 310 Tax Refund', 'other_income', { original: 'IRS TREAS 310 TAX REF' });
    tx(A.checking, `${m(1)}-03`, 350, 'Zelle from J. Rivera', 'other_income', { notes: 'Boat trailer sale', original: 'ZELLE FROM J RIVERA' });
    // two from this week that still need a look
    tx(A.card, addDays(today, -1), -23.4, 'Blue Ocean Coffee', 'coffee', { reviewed: false, original: 'SQ *BLUE OCEAN COFFEE 0042  MOREHEAD CITY NC' });
    tx(A.card, addDays(today, -2), -64.12, 'Ace Hardware', 'home_improvement', { reviewed: false, original: 'ACE HDWE #11823' });
    // the card bill, paid from checking on the 25th: the first month pays off the balance the card started with, and
    // each month after it pays everything charged the month before
    for (const ym of months) {
      const prev = addMonthsYM(ym, -1);
      const owed = ym === months[0] ? 1046.17 : cents(-sum(txs.filter((t) => t.accountId === A.card && monthOf(t.date) === prev && t.amount < 0), (t) => t.amount));
      if (owed > 0) {
        tx(A.checking, `${ym}-25`, -owed, 'Harbor Bank Card Payment', 'cc_payment', { original: 'HARBOR BANK CRD PMT' });
        tx(A.card, `${ym}-25`, owed, 'Payment \u2014 Thank You', 'cc_payment', { original: 'PAYMENT THANK YOU' });
      }
    }
    // balances: the cash accounts walk from a known figure; the rest are valued now and then
    const balances = [];
    const snap = (accountId, date, balance, source) => { if (date <= today) balances.push({ id: `${accountId}:${date}`, accountId, date, balance: cents(balance), source: source || 'manual', sample: true }); };
    snap(A.checking, addDays(start, -1), 3150);
    snap(A.savings, addDays(start, -1), 8600);
    snap(A.card, addDays(start, -1), -1046.17);
    months.forEach((ym, i) => {
      const end = ym === monthOf(today) ? today : monthEnd(ym);
      snap(A['401k'], end, 61250 + i * 1340 + between(-900, 900));
      snap(A.home, end, 412000 + i * 900);
      snap(A.mortgage, end, -(287400 - i * 512));
      snap(A.car, end, 21800 - i * 260);
      snap(A.autoloan, end, -(14260 - i * 322));
    });
    const holdings = [
      { id: 'sample-hold-vti', accountId: A.brokerage, symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', assetClass: 'us_stock', shares: 64.2, price: 318.4, priceDate: today, costBasis: 15120, sample: true, updatedAt: now },
      { id: 'sample-hold-vxus', accountId: A.brokerage, symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', assetClass: 'intl_stock', shares: 88, price: 67.15, priceDate: today, costBasis: 5280, sample: true, updatedAt: now },
      { id: 'sample-hold-bnd', accountId: A.brokerage, symbol: 'BND', name: 'Vanguard Total Bond Market ETF', assetClass: 'bond', shares: 52, price: 73.02, priceDate: today, costBasis: 3900, sample: true, updatedAt: now },
      { id: 'sample-hold-spaxx', accountId: A.brokerage, symbol: 'SPAXX', name: 'Money market', assetClass: 'cash', shares: 1840.55, price: 1, priceDate: today, costBasis: 1840.55, sample: true, updatedAt: now },
    ];
    // the brokerage was worth a little less in each earlier month
    months.forEach((ym, i) => { if (ym !== monthOf(today)) snap(A.brokerage, monthEnd(ym), 30200 + i * 520 + between(-700, 700), 'holdings'); });
    const B = (categoryId, amount) => ({ id: `sample-budget-${categoryId}`, month: m(3), categoryId, amount, sample: true });
    const budgets = [
      B('paycheck', 5225), B('interest_income', 40), B('mortgage', 1685), B('auto_payment', 390), B('electric_gas', 150), B('internet', 65), B('phone', 72), B('subscriptions', 60),
      B('insurance', 105), B('groceries', 650), B('restaurants', 220), B('coffee', 45), B('gas_fuel', 180), B('shopping', 200), B('fitness', 35), B('pharmacy', 30), B('charity', 40), B('travel', 150), B('auto_maintenance', 40), B('home_improvement', 75), B('clothing', 50),
    ];
    budgets.push({ id: 'sample-budget-__flexible', month: m(3), categoryId: '__flexible', amount: 1450, sample: true });
    for (const b of budgets) b.id = `${b.month}:${b.categoryId}`;
    const goals = [
      { id: 'sample-goal-emergency', name: 'Emergency fund', kind: 'save', target: 15000, targetDate: `${Number(today.slice(0, 4)) + 1}-06-30`, accountIds: [A.savings], startAmount: 0, contributions: [], sample: true, createdAt: now },
      { id: 'sample-goal-trip', name: 'Outer Banks trip', kind: 'save', target: 2400, targetDate: `${Number(today.slice(0, 4)) + 1}-05-15`, accountIds: [], startAmount: 300, contributions: months.slice(-4).map((ym) => ({ date: `${ym}-01` <= today ? `${ym}-01` : today, amount: 150 })), sample: true, createdAt: now },
      { id: 'sample-goal-car', name: 'Pay off the car', kind: 'debt', target: 16200, targetDate: `${Number(today.slice(0, 4)) + 3}-12-31`, accountIds: [A.autoloan], startAmount: 16200, contributions: [], sample: true, createdAt: now },
    ];
    return { accounts, transactions: txs, balances, holdings, budgets, goals };
  }

  return {
    // dates and numbers
    todayISO, addDays, addMonths, addMonthsYM, daysBetween, monthOf, monthStart, monthEnd, daysInMonth, monthsBetween, monthRange, monthLabel, dayLabel, monthEndDates,
    cents, money, moneyCompact, pct, median,
    // accounts
    ACCOUNT_TYPES, ACCOUNT_GROUPS, accountType, isLiability, balanceModeOf, guessAccountType,
    // categories
    GROUPS, GROUP_BY_ID, DEFAULT_CATEGORIES, BUDGET_TYPES, UNCATEGORIZED, OTHER_INCOME, TRANSFER, CC_PAYMENT, CATEGORY_ALIASES,
    effectiveCategories, categoryIndex, categoryByName,
    // merchants, suggestions, rules
    cleanMerchant, merchantKey, keywordScores, buildHistory, suggestCategory, RULE_FIELDS, RULE_OPS, ruleMatches, applyRules,
    // transactions
    linesOf, splitsBalance, importKey, findTransferPairs,
    // balances, flow, budgets
    makeLedger, netWorthSeries, cashFlow, monthlyFlow, cumulativeSpend, budgetIndex, budgetFor, budgetMonth, suggestBudget,
    // recurring, goals, investments
    CADENCES, cadenceById, nthDate, streamKey, detectRecurring, upcoming, recurringMonthly, goalProgress, ASSET_CLASSES, guessAssetClass, holdingValue, portfolio,
    insights, sampleData,
  };
});

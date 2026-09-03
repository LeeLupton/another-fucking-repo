# Itemizer

A deductible-expense tracker built from the paper organizer sheet tax preparers hand out, the one headed **"Keep track of your expenses. List amounts for items you have. Save receipts for your deductions."** Every line on that sheet is here (Medical, Education, Self-Employed, Charitable Contributions, Volunteer Work, Taxes, Mortgage & Other Interest, Gambling Losses, Casualty Losses), plus the arithmetic the sheet leaves to you, the geography behind deductible miles, and a recommender that works for the person whose data it is.

It runs entirely in the browser, stores everything on the device, installs to a phone home screen, and works offline. No server, no accounts, no tracking.

**Use it:** https://leelupton.github.io/another-fucking-repo/ (deployed from `main` by GitHub Actions once Pages is enabled for the repository) or download the single file `dist/itemizer.html` from the latest CI run and open it anywhere.

## What it does

**Capture.** Type an expense the way you'd say it: `$42.13 CVS prescription 3/14`, `18 miles to physical therapy on Aug 3`, `$300 tithe yesterday`. The parser pulls out amount, miles, and date; the categorizer suggests the worksheet line and says why. Corrections are remembered per payee. Snap a receipt from the camera; it is downscaled and stored with the entry. Log a bill at its business-use share, repeat monthly premiums in one go, compute a simplified-method home office, or value a bag of donated goods item by item from a catalog of typical thrift-shop ranges; the itemized list is saved with the entry as the record the IRS expects.

**Trips.** Deductible miles need date, destination, purpose, and miles. Save home and the places you drive to; a place's category (medical, business, charity) picks the worksheet line. Measure between places (road routing when online, straight line × 1.25 when not), or record a drive with GPS: the recorder filters noise, keeps the screen awake, sketches the track, and keeps positions on the device. Every trip becomes an entry on the right mileage line and a row in a mileage log that exports the way the IRS expects.

**Import.** Drop in a bank or card CSV. It works out the columns (and remembers the layout per bank), flags payments, refunds, rows already in the ledger, and things that are never deductible, suggests a line per row, and adds only what you tick.

**Ledger.** Search, section and attention filters, a date range, and a select mode for bulk moves, marking paper receipts, and deleting, with a few seconds to undo any delete.

**Insights.** What your entries turn into on the return after the 7.5%-of-AGI medical floor, the state-and-local-tax cap, and gift limits, against your standard deduction by filing status, age, and blindness, and a year-over-year comparison once last year's entries exist. Nudges for the rules that cost people money: gifts of $250+ without an acknowledgment, Form 8283 over $500, meals at 50%, standard-mileage versus actual-expense conflicts, missing total miles, gambling losses without winnings, casualty losses outside a federal disaster, self-employed premiums that belong above the line, private-lender TIN requirements, duplicates, and payments that are never deductible.

**Advisor.** A recommendation engine over your own ledger, on your own device. It finds recurring payees and their cadence, so a missed month shows up with a one-tap "Log it"; projects Schedule A to year end through the same tax engine; tells you whether bunching deductible bills into December gets you over the standard deduction, or when to stop chasing Schedule A receipts; spots doctor visits without a logged drive, lines that usually travel together, and amounts far outside a payee's usual range. Every recommendation says why and can be dismissed. The "Your data" panel shows the only thing that could ever leave the device, a coarse summary with no payees, notes, dates, receipts, exact amounts, or exact income, and it leaves only if you send it.

**Worksheet.** The organizer sheet, filled in with your totals, section by section, with notes for the preparer. It names the taxpayer, keeps the paper's two-column layout (Self-Employed continues at the foot of the right column), always prints the lender's Name and Address lines, and shows the mileage rate beside converted miles. Print it, save it as a PDF, or copy it as text; the text carries the same notes. A receipts sheet puts every receipt photo on a printable contact sheet with the paper receipts listed underneath.

**Settings.** Filing status, AGI, age and vision, gambling winnings, state (typed or from your location; a no-income-tax state gets the sales-tax note instead), a FEMA declaration lookup for the casualty line, editable rates and thresholds per tax year, backup and restore including receipts, places, and trips.

## Experiments

Three ways the app studies its own judgement and checks it later, all on the device, all switchable in Settings, all expiring:

- **Forecast snapshots.** Once a month the advisor's year-end forecast is written down. When the year closes, every snapshot is compared with the final figure on the Advisor page (how far off, whether the itemize call was right) and the advisor calibrates the "expected to come" part of future forecasts from the median of what actually came. Snapshots older than 24 months are dropped.
- **Correction learning.** Override a suggested line and the keywords behind the wrong suggestion lose weight for you, while the keywords behind your choice gain some. Weights drift back to neutral and are forgotten; the current ones are listed in Settings.
- **Session nudges.** Right after a save, at most one follow-up based only on what was just logged: add the drive to that visit, log the year's total miles, attach the acknowledgment for a gift of $250 or more. Nothing about it is stored.

## Audit hardening

A multi-lens review (tax rules, parser, classifier, advisor, importer, geo, storage, security, accessibility, mobile) produced 83 verified findings; all are fixed here, each with a regression test where the code is testable under `node --test`. The user-visible changes:

- **Tax engine.** State and local income tax withheld from pay (W-2 boxes 17 and 19) can be entered in Settings and counts toward the state-and-local deduction; a qualifying surviving spouse no longer gets a spouse add-on, the joint student-loan range, or the $2,000 non-itemizer gift cap; the 2026 student-loan phase-out is built in; charitable gifts above the 60%-of-AGI limit carry forward instead of inflating the total; a "qualified disaster loss" option applies the $500 floor with no AGI reduction and counts on top of the standard deduction; education credits are withheld from married-filing-separately; mortgage insurance premiums are flagged as deductible again from 2026; a missing AGI is called out wherever an income-based limit could not be checked.
- **Classifier.** Maryland statement lines are no longer doctor visits, personal gifts, vets, K-12 tuition, life insurance, car-loan interest, and IRS payments warn instead of being filed, brand collisions (Caliber Collision, Frontier, Delta) are resolved, apostrophes are ignored, learned short words no longer hijack later entries, and the section fallback only offers a real catch-all line.
- **Parser.** "on sunscreen" is not a weekday, a sentence-ending period no longer hides an amount or date, Feb 29 is handled, tokens are removed by position, one- and three-decimal amounts behave, a four-digit year is not taken as the amount when anything else could be, and "bill"/"cost" stay in descriptions.
- **Advisor.** Payees that stopped are marked lapsed and no longer projected; dismissing a recurrence also stops its projection; a re-spelled payee still satisfies an expected date; state estimated payments follow the IRS calendar; every-four-weeks payees are recognised; month-end anchors never drift; no "stop chasing receipts" advice while medical costs wait on AGI; a closed year gets a past-tense summary; the shareable aggregate no longer reveals age or blindness.
- **Import.** Debit/credit indicator columns set each row's sign; day-first dates are detected and can be forced; a header below a preamble is found; semicolon and tab exports and European decimals parse; the amount column is chosen by its cells rather than position; only strong matches are pre-ticked, and Schedule C lines only when the ledger already shows a business; duplicates require the payee to match.
- **Trips.** GPS jitter while parked no longer accumulates miles, a stale first fix is re-anchored, a pause breaks the track, the wake lock is re-acquired when the screen returns, a denied permission stops the recorder, lookup errors say what went wrong, and the FEMA lookup filters by county on the server and matches county names exactly.
- **Storage.** One object store per kind of record with row-level writes (see Storage above); a blocked or failing IndexedDB open no longer forks data into localStorage; backups are validated before they are stored and receipts are decoded locally; a failed save is reported and leaves the form intact; the browser is asked to protect the data from eviction; backups are built as a Blob; CSV exports defuse spreadsheet formulas in free text.
- **Accessibility and mobile.** Dialogs trap focus, make the page behind them inert, and return focus on close; the ledger search keeps its caret; selects and icons have names; muted text meets AA contrast; worksheet labels wrap instead of being cut off.
- **Tests.** The follow-up lenses added regression tests for what the first pass left untested: the GPS trip recorder's state machine and permission denial, FEMA lookups against a stubbed fetch, the advisor's co-occurrence and receipt-habit rules, weekly through yearly cadences with same-day merging and a tolerated miss, the year plan's three outcomes, the Schedule C mileage guards, the date-gated year-end checklist, the appraisal, escrow, casualty and tuition insights, the CSV export, withdrawal/deposit and type-column statements with the sign override, relative-date aliases and date sources, and the classifier's limit and key; three assertions that could pass by accident were tightened.
- **Worksheet.** The sheet names the taxpayer (Settings → About you); Self-Employed continues at the foot of the right column as on paper, so a full sheet fits one page; the lender's Name and Address lines are always printed; mileage rows show the rate applied; the Education section has no total (its lines go to different forms); totals and notes never split across a page; the text copy carries the lender lines and the full preparer notes.

## Run it locally

No install, no build.

```bash
npx serve -l 4173 .        # then open http://localhost:4173
npm test                    # node --test: parser, categorizer, tax engine, advisor, geo, importer
npm run build               # dist/itemizer.html, the whole app in one file
```

Opening `index.html` straight from disk also works in Chromium-based browsers. The service worker and the install prompt need http(s).

## Storage

Everything is on the device, in the browser's IndexedDB, as a small database rather than a document: one object store per kind of record, each row under its own key, and every change writes or deletes just the row it concerns.

| store | key | one row is |
|---|---|---|
| `entries` | `id` | a ledger entry, referencing its worksheet line by `lineId` |
| `receipts` | `id` | a receipt photo (Blob) |
| `places` | `id` | a saved place |
| `trips` | `id` | a mileage-log row, referencing its places and entry by id |
| `settings` | `key` | the one row of scalar configuration (`main`) |
| `learned` | `key` | a payee key and the line it was filed on |
| `weights` | `keyword` | a classifier keyword and its learned multiplier |
| `dismissals` | `id` | a dismissed recommendation and the date |
| `layouts` | `signature` | a statement header and the column layout chosen for it |
| `snapshots` | `taxYear:month` | one month's year-end forecast |
| `overrides` | `taxYear:path` | one overridden tax parameter |

Rows carry ids, not display labels: a line is `med.doctor`, never "Doctor"; labels come from the schema when shown. Database version 3 split the old settings document, which carried the last six collections as one JSON value, into those stores; the upgrade runs in place and keeps every row. JSON is used only for the backup file (version 3: the settings row plus each store as an array of rows; version 2 files still import). Without IndexedDB the same stores are kept in localStorage, one key per store.

## How it's put together

```
index.html            shell: header, six views, tab bar, camera/file inputs
styles.css            design tokens (light + dark), layout, components, print sheet
js/schema.js          the worksheet as data: sections, lines, tax treatment, hints, keywords
js/rules.js           tax-year parameters and the computation: Schedule A/C, verdict, insights
js/parse.js           quick-capture parser (amount, miles, absolute and relative dates)
js/classify.js        line suggestions with explanations; learned payee map
js/advisor.js         the recommender: recurrences, projection, gaps, anomalies, bunching, habits
js/geo.js             distances, GPS trip recorder, track sketch, geocoding/routing/FEMA lookups
js/importer.js        CSV statement parsing, column detection, dedupe, line suggestions
js/valuation.js       donated-goods catalog, condition-based values, itemized record
js/store.js           IndexedDB, one object store per kind of record; row-level writes; backup, CSV
js/app.js             the UI
sw.js                 offline cache for the app shell
manifest.webmanifest  installable web app metadata
test/                 node:test suites for the pure modules
build.js              single-file bundler (no dependencies)
.github/workflows     CI (syntax, tests, build) and the Pages deploy from main
```

The pure modules use a small UMD wrapper so the same files run in the browser as globals and in Node for tests. There are no dependencies, at build time or at run time.

## Privacy

Data never leaves the device. There is no server, no analytics, and no usage tracking. The only network calls are the fonts and the lookups you trigger yourself: an address search, a road distance, a disaster-declaration check. Each sends just the query it needs to OpenStreetMap or FEMA, and each works without a connection by falling back or asking you. GPS positions are recorded only while you have pressed Start, and they stay with the trip on the device. Back up from Settings before clearing browser data or switching phones.

## Tax figures and disclaimer

Built-in parameters follow IRS Revenue Procedures 2023-34, 2024-40, and 2025-32 (inflation adjustments), the annual IRS standard-mileage notices, and Public Law 119-21 (2025) for the standard deduction, the state-and-local-tax cap and phase-down, the 2026 charitable floor and non-itemizer deduction, and the 2026 gambling-loss limitation. They are planning figures. Verify against current IRS publications (Schedule A instructions; Publications 502, 526, 529, 970) or your preparer before filing. Itemizer is not tax advice.

## License

MIT. See `LICENSE`.

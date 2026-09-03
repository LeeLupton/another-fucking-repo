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

**Worksheet.** The organizer sheet, filled in with your totals, section by section, with notes for the preparer. Print it, save it as a PDF, or copy it as text. A receipts sheet puts every receipt photo on a printable contact sheet with the paper receipts listed underneath.

**Settings.** Filing status, AGI, age and vision, gambling winnings, state (typed or from your location; a no-income-tax state gets the sales-tax note instead), a FEMA declaration lookup for the casualty line, editable rates and thresholds per tax year, backup and restore including receipts, places, and trips.

## Run it locally

No install, no build.

```bash
npx serve -l 4173 .        # then open http://localhost:4173
npm test                    # node --test: parser, categorizer, tax engine, advisor, geo, importer
npm run build               # dist/itemizer.html, the whole app in one file
```

Opening `index.html` straight from disk also works in Chromium-based browsers. The service worker and the install prompt need http(s).

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
js/store.js           IndexedDB persistence (entries, receipts, places, trips, settings), backup, CSV
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

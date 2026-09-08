/*
 * schema.js — the paper worksheet, as data.
 *
 * Every line on the "Keep track of your expenses" organizer is modelled here:
 * where it lands on the return (treatment), whether it is dollars or miles,
 * what the IRS needs to see for it, and the words people actually type when
 * they log it (used by classify.js).
 *
 * UMD-style so the same file runs in the browser (global ItemizerSchema) and
 * under `node --test` (module.exports) with no build step.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerSchema = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Treatments — how a line enters the return.
  const TREATMENTS = {
    // No figures in these labels: the floors and caps behind them are editable in Settings and change by
    // year, so the app quotes the rate in force rather than the one that was true when this was written.
    'A-medical':  { schedule: 'Schedule A', label: 'Medical (above the AGI floor)' },
    'A-tax':      { schedule: 'Schedule A', label: 'State & local taxes (capped)' },
    'A-interest': { schedule: 'Schedule A', label: 'Interest you paid' },
    'A-charity':  { schedule: 'Schedule A', label: 'Gifts to charity' },
    'A-other':    { schedule: 'Schedule A', label: 'Other itemized deductions' },
    'A-casualty': { schedule: 'Schedule A', label: 'Casualty & theft (declared disasters)' },
    'adj':        { schedule: 'Schedule 1', label: 'Adjustment to income (no itemizing needed)' },
    'credit':     { schedule: 'Form 8863', label: 'Feeds an education credit' },
    'C':          { schedule: 'Schedule C', label: 'Self-employed business expense' },
    'info':       { schedule: '—',          label: 'Information for your preparer' },
  };

  const SECTIONS = [
    {
      id: 'medical',
      title: 'Medical Expenses',
      column: 'left',
      treatment: 'A-medical',
      hint: 'Out-of-pocket only — anything reimbursed by insurance, an HSA, or an FSA does not count.',
      lines: [
        { id: 'med.doctor', label: 'Doctor', keywords: ['doctor', 'doctors', 'physician', 'physicians', 'copay', 'copays', 'co-pay', 'co-pays', 'copayment', 'coinsurance', 'co-insurance', 'clinic', 'office visit', 'urgent care', 'pediatrician', 'dermatologist', 'cardiologist', 'specialist', 'checkup', 'check-up', 'telehealth', 'primary care', 'pcp', 'family practice', 'obgyn', 'ob/gyn', 'allergist', 'podiatrist', 'gp', 'doctors office', 'doctor office', 'dr office', 'drs office', 'pediatrics', 'dermatology', 'cardiology', 'orthopedic', 'orthopedics', 'orthopaedic', 'neurology', 'oncology', 'gastroenterology', 'urology', 'internal medicine', 'family medicine', 'medical group', 'medical associates', 'medical clinic', 'md pa', 'md pc'] },
        { id: 'med.operations', label: 'Operations', keywords: ['surgery', 'surgeon', 'operation', 'surgical', 'procedure', 'anesthesia', 'anesthesiologist', 'outpatient surgery'] },
        { id: 'med.prescriptions', label: 'Prescription Drugs', keywords: ['prescription', 'prescriptions', 'rx', 'pharmacy', 'cvs', 'walgreens', 'rite aid', 'medication', 'meds', 'insulin', 'refill', 'goodrx', 'express scripts', 'optumrx', 'caremark'] },
        { id: 'med.insurance', label: 'Medical/Dental Insurance', hint: 'After-tax premiums only. Premiums taken pre-tax from a paycheck are already excluded from income and cannot be deducted again. Medicare Part B/D premiums count.', keywords: ['health insurance', 'health insurance premium', 'medical insurance', 'medical premium', 'health premium', 'dental insurance', 'dental premium', 'vision insurance', 'delta dental', 'blue cross', 'bcbs', 'aetna', 'cigna', 'unitedhealthcare', 'united healthcare', 'kaiser', 'humana', 'anthem', 'tricare', 'fehb', 'medicare part b', 'medicare part d', 'medicare premium', 'medigap', 'cobra'] },
        { id: 'med.ltc', label: 'Long-term Care Insurance', hint: 'Deductible only up to an annual limit set by your age at the end of the year. There are five age bands, and the limit belongs to each insured person, so on a joint return each spouse\'s policy has its own. This worksheet holds back only an amount above the highest limit, so tell your preparer the age of everyone insured and let them apply the right limit to each policy.', keywords: ['long-term care', 'long term care', 'ltc', 'ltci', 'genworth', 'fltcip'] },
        { id: 'med.hospital', label: 'Hospital & Emergency', keywords: ['hospital', 'emergency room', 'emergency dept', 'emergency department', 'er visit', 'er', 'inpatient', 'hospital admission', 'trauma', 'medical center', 'health system'] },
        { id: 'med.lab', label: 'Lab & X-Ray', keywords: ['lab', 'labs', 'labcorp', 'quest diagnostics', 'x-ray', 'xray', 'mri', 'ct scan', 'imaging', 'ultrasound', 'blood test', 'bloodwork', 'radiology', 'mammogram', 'biopsy', 'colonoscopy', 'ekg', 'echocardiogram'] },
        { id: 'med.nurses', label: 'Visiting Nurses/In-home Care', keywords: ['nurse', 'nursing', 'home health', 'in-home care', 'in home care', 'caregiver', 'home care', 'hospice', 'aide', 'respite care'] },
        { id: 'med.dental', label: 'Dental', keywords: ['dentist', 'dental', 'teeth cleaning', 'dental filling', 'tooth filling', 'crown', 'root canal', 'oral surgeon', 'periodontist', 'extraction', 'fluoride', 'implant', 'aspen dental', 'dds', 'dmd', 'dentistry', 'family dentistry'] },
        { id: 'med.dentures', label: 'Dentures & Braces', keywords: ['dentures', 'denture', 'braces', 'orthodontist', 'orthodontic', 'orthodontics', 'invisalign', 'orthodontic retainer', 'dental retainer', 'teeth retainer', 'smile direct'] },
        { id: 'med.glasses', label: 'Glasses & Contact Lenses', keywords: ['glasses', 'eyeglasses', 'contact lens', 'contact lenses', 'contacts', 'optometrist', 'ophthalmologist', 'eye exam', 'eye doctor', 'lenscrafters', 'warby parker', '1-800 contacts', 'eyeglass frames', 'glasses frames', 'lenses', 'lasik', 'america\'s best', 'visionworks', 'pearle', 'optical', 'vision center', 'eyecare', 'eye care', 'optometry'] },
        { id: 'med.supplies', label: 'Supplies', keywords: ['medical supplies', 'cpap', 'nebulizer', 'test strips', 'glucose monitor', 'blood pressure monitor', 'bp monitor', 'bp cuff', 'syringes', 'incontinence', 'compression socks', 'medical equipment', 'dme', 'oxygen', 'lancets', 'ostomy'] },
        { id: 'med.hearing', label: 'Hearing Aids & Batteries', keywords: ['hearing aid', 'hearing aids', 'audiologist', 'hearing test', 'hearing aid batteries', 'miracle-ear', 'cochlear'] },
        { id: 'med.ortho_shoes', label: 'Orthopedic Shoes', keywords: ['orthopedic shoes', 'orthotics', 'orthotic', 'insoles', 'diabetic shoes', 'custom insoles'] },
        { id: 'med.therapy', label: 'Therapy Treatments', keywords: ['therapy', 'physical therapy', 'pt session', 'chiropractor', 'chiropractic', 'counseling', 'counselor', 'therapist', 'psychologist', 'psychiatrist', 'mental health', 'acupuncture', 'occupational therapy', 'speech therapy', 'rehab', 'rehabilitation', 'betterhelp', 'talkspace'] },
        { id: 'med.canes', label: 'Canes/Crutches/Braces', keywords: ['cane', 'crutches', 'crutch', 'knee brace', 'back brace', 'wrist brace', 'ankle brace', 'rollator', 'wheeled walker', 'walking frame', 'splint', 'arm sling', 'shoulder sling', 'boot cast'] },
        { id: 'med.wheelchairs', label: 'Wheelchairs', keywords: ['wheelchair', 'wheel chair', 'mobility scooter', 'power chair', 'hoyer lift'] },
        { id: 'med.ac', label: 'Air Conditioning', group: 'On Doctor\'s Advice', hint: 'Only when prescribed for a medical condition; the deductible amount is the cost over any increase to home value.', keywords: ['air conditioner', 'air conditioning', 'ac unit', 'dehumidifier', 'air purifier'] },
        { id: 'med.vaporizers', label: 'Vaporizers', group: 'On Doctor\'s Advice', keywords: ['vaporizer', 'humidifier'] },
        { id: 'med.thermometers', label: 'Thermometers & Bandages', group: 'On Doctor\'s Advice', keywords: ['thermometer', 'bandages', 'bandage', 'first aid', 'first-aid', 'gauze', 'band-aid', 'band aids'] },
        { id: 'med.other', label: 'Other', group: 'On Doctor\'s Advice', keywords: ['medical other', 'weight loss program', 'smoking cessation', 'service animal', 'guide dog', 'fertility', 'ivf', 'lead paint removal', 'medical alert'] },
        { id: 'med.miles', label: 'Medical Miles Driven', unit: 'miles', rate: 'medical', hint: 'Round trips to doctors, pharmacies, hospitals, therapy. Log the date and destination.', keywords: ['medical miles', 'miles to doctor', 'drove to doctor', 'medical trip', 'medical mileage', 'miles to hospital', 'miles to pharmacy', 'miles to therapy'] },
        { id: 'med.transport', label: 'Other Medical Transportation', keywords: ['ambulance', 'medical transport', 'uber to doctor', 'lyft to doctor', 'taxi to hospital', 'hospital parking', 'parking at hospital', 'parking at clinic', 'medical parking', 'tolls to hospital', 'bus to clinic', 'airfare for treatment', 'lodging for treatment'] },
      ],
    },
    {
      id: 'education',
      title: 'Education Expenses',
      column: 'left',
      treatment: 'credit',
      hint: 'Most education costs are worth more as a credit (American Opportunity or Lifetime Learning) than as a deduction. Student loan interest is its own above-the-line deduction.',
      lines: [
        { id: 'edu.expenses', label: 'Education Expenses', treatment: 'info', hint: 'General education or training costs. A course at an eligible school may support the Lifetime Learning Credit; training for a business you run is a Schedule C expense; job-related training for an employee is not deductible. Insights shows what a K-12 educator can deduct for classroom expenses this year.', keywords: ['education', 'classroom', 'educator', 'teacher supplies', 'continuing education', 'certification', 'exam fee', 'training course', 'seminar', 'ceu', 'cme', 'workshop', 'bootcamp'] },
        { id: 'edu.loan_interest', label: 'Student Loan Interest', treatment: 'adj', hint: 'Deductible up to $2,500 whether or not you itemize; phases out at higher incomes. Your servicer issues Form 1098-E.', keywords: ['student loan', 'student loans', 'student loan interest', 'navient', 'nelnet', 'mohela', 'sallie mae', 'aidvantage', 'great lakes', 'edfinancial', '1098-e', '1098e', 'sofi loan', 'earnest', 'studentaid.gov', 'fedloan', 'dept of education', 'department of education', 'student ln', 'studentaid', 'student loan servicing'] },
        { id: 'edu.tuition', label: 'Post-secondary, Tuition & Fees', keywords: ['tuition', 'university', 'college tuition', 'community college', 'semester', 'enrollment fee', 'registration fee', '1098-t', '1098t', 'bursar', 'grad school', 'graduate school', 'technical school', 'trade school', 'course fee'] },
        { id: 'edu.books', label: 'Books and Programs', keywords: ['textbook', 'textbooks', 'course materials', 'books', 'chegg', 'pearson', 'mcgraw', 'cengage', 'access code', 'software for class', 'course software'] },
        { id: 'edu.lab', label: 'Lab Fees', keywords: ['lab fee', 'lab fees', 'laboratory fee', 'studio fee'] },
        { id: 'edu.supplies', label: 'Other Supplies', keywords: ['school supplies', 'notebooks', 'calculator', 'backpack', 'laptop for school', 'school laptop', 'art supplies for class'] },
      ],
    },
    {
      id: 'selfemp',
      title: 'Self-Employed Expenses',
      column: 'left',
      treatment: 'C',
      hint: 'Ordinary and necessary costs of a business you run (Schedule C). These reduce business profit directly — no itemizing required.',
      lines: [
        { id: 'se.advertising', label: 'Advertising', keywords: ['advertising', 'ads', 'facebook ads', 'meta ads', 'google ads', 'instagram ads', 'marketing', 'flyers', 'business cards', 'promo', 'promotion', 'sponsorship', 'signage', 'yelp', 'seo', 'domain', 'hosting', 'squarespace', 'wix', 'website', 'mailchimp'] },
        { id: 'se.car', label: 'Car & Trucking Expenses', hint: 'Actual expenses method. Use EITHER actual expenses OR the standard mileage rate for a vehicle, not both. Parking and tolls on a business trip count under either method, so log those on the Other line.', keywords: ['gas', 'fuel', 'gasoline', 'diesel', 'oil change', 'tires', 'tire', 'car repair', 'auto repair', 'mechanic', 'car wash', 'auto insurance', 'car insurance', 'geico', 'truck', 'trucking', 'jiffy lube', 'shell', 'exxon', 'chevron', 'bp', 'pilot', 'love\'s', 'wawa', 'sheetz', 'buc-ee\'s'] },
        { id: 'se.professional', label: 'Professional Services', keywords: ['lawyer', 'attorney', 'legal fees', 'legal', 'attorney retainer', 'lawyer retainer', 'legal retainer', 'retainer fee', 'accountant', 'cpa', 'bookkeeper', 'bookkeeping', 'tax prep', 'tax preparer', 'consultant', 'contractor', 'freelancer', 'graphic designer', 'web designer', 'ux designer', 'payroll service', 'notary', 'legalzoom', 'gusto', 'adp'] },
        { id: 'se.office', label: 'Office Expenses', keywords: ['office supplies', 'home office', 'office chair', 'office desk', 'office furniture', 'office equipment', 'printer', 'ink', 'toner', 'printer paper', 'copy paper', 'staples', 'office depot', 'officemax', 'pens', 'postage', 'stamps', 'usps', 'shipping', 'ups store', 'fedex', 'quickbooks', 'software subscription', 'adobe', 'microsoft 365', 'office 365', 'zoom', 'dropbox', 'google workspace', 'envelopes', 'canva', 'notion', 'slack'] },
        { id: 'se.rent', label: 'Rent or Lease Payments', keywords: ['rent', 'lease', 'office rent', 'coworking', 'co-working', 'wework', 'regus', 'storage unit', 'equipment lease', 'booth rent', 'chair rent', 'studio rent', 'warehouse rent', 'warehouse lease'] },
        { id: 'se.utilities', label: 'Utilities/Telephone', keywords: ['phone', 'cell phone', 'telephone', 'verizon', 'at&t', 'att', 't-mobile', 'tmobile', 'internet', 'comcast', 'xfinity', 'spectrum', 'cox', 'electric', 'electricity', 'gas bill', 'water bill', 'utility', 'utilities', 'power bill', 'duke energy', 'southwest gas', 'mint mobile', 'visible', 'starlink', 'frontier communications', 'frontier internet'] },
        { id: 'se.miles', label: 'Business Miles', unit: 'miles', rate: 'business', hint: 'Standard mileage method. Log date, destination, and business purpose for each trip.', keywords: ['business miles', 'client miles', 'drove to client', 'work miles', 'business mileage', 'job site miles', 'miles to job', 'miles to client', 'miles for work', 'delivery miles', 'doordash miles', 'uber miles', 'rideshare miles'] },
        // the paper continues this section at the foot of the right column, from Repairs & Maintenance to Total Miles
        { id: 'se.repairs', label: 'Repairs & Maintenance', column: 'right', keywords: ['repair', 'repairs', 'maintenance', 'fix', 'fixed', 'service call', 'handyman', 'plumber', 'electrician', 'equipment repair', 'computer repair', 'hvac service', 'geek squad'] },
        { id: 'se.supplies', label: 'Supplies', column: 'right', keywords: ['supplies', 'materials', 'tools', 'hardware', 'home depot', 'lowe\'s', 'lowes', 'harbor freight', 'amazon business', 'parts', 'cleaning supplies', 'uline', 'grainger', 'consumables', 'packaging'] },
        { id: 'se.taxes', label: 'Taxes & Licenses', column: 'right', keywords: ['license', 'licenses', 'permit', 'business license', 'llc fee', 'annual report fee', 'franchise tax', 'sales tax paid', 'professional license', 'certification fee', 'secretary of state', 'occupational license', 'business registration', 'dba filing'] },
        { id: 'se.travel', label: 'Travel', column: 'right', hint: 'Overnight travel away from your tax home: transportation, lodging, incidentals. Meals go on the Meals line.', keywords: ['flight', 'airfare', 'airline', 'delta air', 'delta airlines', 'delta air lines', 'united airlines', 'american airlines', 'southwest airlines', 'southwest air', 'jetblue', 'alaska airlines', 'spirit airlines', 'frontier airlines', 'hotel', 'motel', 'airbnb', 'vrbo', 'marriott', 'hilton', 'hyatt', 'holiday inn', 'hampton inn', 'lodging', 'rental car', 'hertz', 'enterprise', 'avis', 'budget rent', 'national car', 'turo', 'train', 'amtrak', 'baggage fee', 'per diem', 'travel', 'conference trip', 'expedia', 'kayak', 'priceline'] },
        { id: 'se.meals', label: 'Meals', column: 'right', hint: 'Business meals are generally 50% deductible. Note who you met and why.', keywords: ['meal', 'meals', 'lunch', 'dinner', 'breakfast', 'restaurant', 'client lunch', 'client dinner', 'coffee', 'starbucks', 'dunkin', 'business meal', 'catering', 'doordash', 'uber eats', 'grubhub', 'chipotle', 'panera', 'olive garden', 'applebee\'s', 'chili\'s', 'outback', 'texas roadhouse', 'mcdonald\'s', 'wendy\'s', 'chick-fil-a', 'subway', 'pizza'] },
        { id: 'se.other', label: 'Other', column: 'right', hint: 'Business costs that do not fit another line. Parking and tolls on a business trip belong here: they count on top of either vehicle method.', keywords: ['parking for work', 'business parking', 'client parking', 'parking at client', 'tolls for work', 'business tolls', 'toll pass', 'bank fees', 'merchant fees', 'square fees', 'stripe fees', 'paypal fees', 'processing fees', 'business loan interest', 'professional dues', 'union dues', 'membership dues', 'liability insurance', 'e&o', 'business insurance', 'bond', 'trade association', 'chamber of commerce', 'contract labor', 'commissions', 'bad debt', 'uniforms', 'safety gear', 'ppe'] },
        { id: 'se.total_miles', label: 'Total Miles', unit: 'miles', treatment: 'info', column: 'right', hint: 'Total miles the vehicle was driven this year for ALL purposes (odometer Dec 31 minus Jan 1). Needed to compute the business-use percentage.', keywords: ['total miles', 'odometer', 'annual miles', 'all miles', 'odometer reading', 'total mileage'] },
      ],
    },
    {
      id: 'charity',
      title: 'Charitable Contributions',
      column: 'right',
      treatment: 'A-charity',
      hint: 'Gifts to qualified 501(c)(3) organizations. Gifts to individuals, crowdfunding for a person, raffle tickets, and political contributions never count.',
      lines: [
        { id: 'ch.worship', label: 'Place of Worship', keywords: ['church', 'tithe', 'tithes', 'tithing', 'offering', 'offertory', 'parish', 'chapel', 'synagogue', 'temple', 'mosque', 'masjid', 'ministry', 'congregation', 'diocese', 'lds', 'ward', 'stake', 'cathedral', 'zakat', 'gurdwara', 'building fund', 'faith promise', 'pushpay', 'tithe.ly', 'givelify', 'episcopal', 'baptist', 'lutheran', 'methodist', 'presbyterian', 'catholic', 'pentecostal', 'assembly of god', 'adventist', 'orthodox', 'evangelical', 'community church', 'bible church', 'fellowship', 'calvary', 'church of christ', 'umc', 'archdiocese', 'chabad', 'islamic center', 'vineyard church', 'anglican', 'nazarene', 'mennonite', 'quaker meeting', 'friends meeting'] },
        { id: 'ch.college', label: 'College', hint: 'Gifts to a college or university (not tuition). Payments that buy athletic seating rights are not deductible.', keywords: ['alumni', 'alumni fund', 'alumni association', 'university foundation', 'college fund', 'booster club', 'endowment', 'annual fund', 'scholarship fund', 'university gift', 'college donation'] },
        { id: 'ch.org', label: 'Charity Organization', hint: 'A gift to a donor-advised fund (Fidelity Charitable, Schwab Charitable, Vanguard Charitable) is a deductible gift when you itemize, but it does not count toward the cash-gift deduction you can take without itemizing.', keywords: ['donation', 'donate', 'donated', 'charity', 'charitable', 'nonprofit', 'non-profit', 'red cross', 'united way', 'st. jude', 'st jude', 'humane society', 'aspca', 'wounded warrior', 'food bank', 'habitat for humanity', 'doctors without borders', 'unicef', 'fundraiser', '501c3', '501(c)(3)', 'shriners', 'toys for tots', 'march of dimes', 'american cancer society', 'heart association', 'fisher house', 'uso', 'npr', 'public radio', 'pbs', 'wikipedia', 'wikimedia', 'salvation army', 'goodwill', 'rescue mission', 'animal shelter', 'planned parenthood', 'sierra club foundation', 'nature conservancy', 'special olympics', 'make-a-wish', 'ymca', 'boys and girls club', 'library foundation', 'hospital foundation', 'meals on wheels', 'donations'] },
        { id: 'ch.cfc', label: 'CFC', hint: 'Combined Federal Campaign payroll pledges. Keep your pledge confirmation and final pay statement of the year.', keywords: ['cfc', 'combined federal campaign', 'cfc pledge', 'payroll pledge', 'givecfc', 'cfc payroll'] },
        { id: 'ch.other', label: 'Other', keywords: ['other charity', 'benefit dinner', 'gala', 'charity auction', 'charity golf', 'charity run', 'walkathon', 'walk-a-thon', 'memorial fund', 'in memory of', 'in lieu of flowers', 'benevolence fund'] },
        { id: 'ch.noncash', label: 'Value of furniture/clothing donated', hint: 'Fair-market (thrift-shop) value of items in good used condition or better. Over $500 total requires Form 8283; over $5,000 for one item or group requires a qualified appraisal.', keywords: ['clothing donation', 'clothes donated', 'donated clothes', 'furniture donated', 'donated furniture', 'goodwill drop', 'goodwill drop-off', 'goodwill dropoff', 'salvation army drop-off', 'thrift donation', 'household items', 'donated items', 'non-cash', 'noncash', 'in-kind', 'in kind', 'bags of clothes', 'purple heart pickup', 'vietnam veterans of america', 'vva pickup', 'amvets', 'habitat restore', 'car donation', 'vehicle donation', 'kars4kids', 'donated books', 'donated toys', 'donated a couch', 'donated tv'] },
      ],
    },
    {
      id: 'volunteer',
      title: 'Volunteer Work Expenses',
      column: 'right',
      treatment: 'A-charity',
      hint: 'Unreimbursed out-of-pocket costs of volunteering count as gifts to charity. The value of your time never does.',
      lines: [
        { id: 'vol.expenses', label: 'Place of Worship, Scouts, School, etc', keywords: ['volunteer', 'volunteering', 'volunteer supplies', 'scouts', 'boy scouts', 'girl scouts', 'cub scouts', 'scouts bsa', 'troop', 'pta', 'pto', 'den meeting', 'supplies for church', 'vbs', 'vacation bible school', 'youth group', 'mission trip', 'volunteer uniform', 'bake sale supplies', 'coaching supplies', 'team snacks', 'sunday school supplies', 'food pantry supplies', 'shelter supplies', 'blood drive'] },
        { id: 'vol.miles', label: 'Auto Miles Driven', unit: 'miles', rate: 'charity', hint: 'Miles driven in service of a charity — delivering meals, driving to scout events, church errands.', keywords: ['volunteer miles', 'charity miles', 'miles for church', 'drove for scouts', 'volunteering mileage', 'charitable miles', 'miles for food bank', 'meals on wheels', 'miles delivering meals', 'delivering meals', 'mission miles', 'drove for church', 'drove for the food bank', 'habitat build'] },
      ],
    },
    {
      id: 'taxes',
      title: 'Taxes',
      column: 'right',
      treatment: 'A-tax',
      hint: 'State and local taxes actually paid during the year. Federal income tax, Social Security, and Medicare tax never count.',
      lines: [
        { id: 'tax.real_estate', label: 'Real Estate Tax', hint: 'Property tax on your home and land you own. If paid through escrow, use the amount your lender actually disbursed (Form 1098 box 10 or the escrow statement).', keywords: ['property tax', 'property taxes', 'real estate tax', 'real estate taxes', 'county tax', 'school tax', 'town tax', 'city tax', 'tax collector', 'county treasurer', 'escrow tax', 'land tax', 'parcel tax', 'millage'] },
        { id: 'tax.personal_property', label: 'Personal Property Tax', hint: 'Only the portion of a vehicle, boat, or RV fee that is based on the item\'s VALUE (ad valorem) counts — flat registration fees do not.', keywords: ['personal property tax', 'vehicle tax', 'car tax', 'excise tax', 'ad valorem', 'vehicle property tax', 'dmv', 'car registration', 'tag renewal', 'boat tax', 'rv tax', 'motor vehicle tax', 'wheel tax'] },
        { id: 'tax.state_income', label: 'State Income Tax', hint: 'Estimated payments made during the year, plus any balance due on last year\'s state return paid this year. Do not enter tax withheld from your pay here — put the amounts from W-2 boxes 17 and 19 in Settings, where they count toward the state and local deduction.', keywords: ['state income tax', 'state tax', 'state taxes', 'state estimated tax', 'state estimated payment', 'state estimated payments', 'state quarterly', 'department of revenue', 'dept of revenue', 'dor', 'comptroller', 'franchise tax board', 'ftb', 'state balance due', 'state estimated', 'local income tax', 'city income tax', 'school district income tax', 'rita', 'state extension payment'] },
      ],
    },
    {
      id: 'interest',
      title: 'Mortgage and Other Interest Expenses',
      column: 'right',
      treatment: 'A-interest',
      hint: 'Interest on up to $750,000 of acquisition debt on a main or second home. Your lender reports it on Form 1098.',
      lines: [
        { id: 'int.mortgage', label: 'Home Mortgage Interest', hint: 'Form 1098 box 1. From 2026, mortgage insurance premiums (box 5) count here too, subject to an income phase-out.', keywords: ['mortgage', 'mortgage interest', '1098', 'home loan', 'wells fargo home mortgage', 'rocket mortgage', 'quicken loans', 'mr. cooper', 'mr cooper', 'chase mortgage', 'pennymac', 'freedom mortgage', 'loancare', 'navy federal mortgage', 'usaa mortgage', 'va loan', 'lakeview', 'newrez', 'shellpoint', 'carrington', 'guild mortgage', 'caliber home loans', 'mortgage payment', 'mtg', 'home mtg', 'mtg pymt', 'mtg payment'] },
        { id: 'int.second', label: '2nd Mortgage/Home Equity', hint: 'Counts only if the loan proceeds were used to buy, build, or substantially improve the home that secures it.', keywords: ['heloc', 'home equity', 'second mortgage', '2nd mortgage', 'equity line', 'equity loan', 'home equity line', 'home equity loan'] },
        { id: 'int.individual', label: 'Home Mortgage to Individual', hint: 'Seller or private financing with no Form 1098. Schedule A requires the lender\'s name, address, and SSN or EIN — record them in the note.', keywords: ['owner financing', 'owner-financed', 'owner financed', 'seller financing', 'seller-financed', 'private mortgage', 'land contract', 'contract for deed', 'private lender', 'mortgage to individual', 'paid mortgage to'] },
        { id: 'int.points', label: 'Points Paid at Closing', hint: 'Points on a purchase of your main home are deductible in full the year paid; refinance points are spread over the loan term.', keywords: ['points', 'discount points', 'origination', 'loan origination', 'origination fee', 'closing costs', 'closing disclosure', 'refinance points', 'refi points', 'buydown'] },
        { id: 'int.investment', label: 'Investment Interest', hint: 'Interest on money borrowed to buy taxable investments (margin interest). It is deductible only up to your net investment income for the year, and the rest carries forward — Form 4952. This worksheet counts what you paid without applying that limit, so tell your preparer your investment income.', keywords: ['margin interest', 'investment interest', 'brokerage interest', 'margin loan', 'schwab margin', 'fidelity margin', 'interactive brokers interest', 'form 4952', 'robinhood margin', 'etrade margin'] },
      ],
    },
    {
      id: 'other',
      title: 'Other Expenses',
      column: 'right',
      treatment: 'A-other',
      lines: [
        { id: 'oth.gambling', label: 'Gambling Losses', hint: 'Deductible only up to gambling winnings you report as income. Keep a diary: date, place, game, amounts won and lost. From 2026 only 90% of losses count.', keywords: ['casino', 'gambling', 'lottery', 'lotto', 'scratch-off', 'scratch off', 'scratchers', 'slots', 'slot machine', 'poker', 'blackjack', 'sportsbook', 'draftkings', 'fanduel', 'betmgm', 'caesars casino', 'caesars sportsbook', 'caesars palace casino', 'mgm', 'bet365', 'wager', 'bets', 'bet', 'bingo', 'keno', 'horse racing', 'racetrack', 'powerball', 'mega millions', 'hard rock casino', 'borgata', 'parlay'] },
      ],
    },
    {
      id: 'casualty',
      title: 'Casualty Losses',
      column: 'right',
      treatment: 'A-casualty',
      lines: [
        { id: 'cas.loss', label: 'Accident/Fire/Theft/Natural Disasters', hint: 'Personal losses count only when the loss came from a declared disaster: federal, and from 2026 a state or governor declaration as well (Form 4684). Reduce the loss by any insurance reimbursement and by the per-event floor; most losses are then reduced by 10% of AGI, but a qualified disaster loss is not. Keep the declaration number.', keywords: ['house fire', 'fire damage', 'fire loss', 'flood damage', 'flood loss', 'flooded', 'flooding', 'theft', 'stolen', 'burglary', 'hurricane', 'tornado', 'storm damage', 'wildfire', 'earthquake', 'disaster', 'fema', 'casualty', 'vandalism', 'hail damage', 'tree fell', 'wind damage', 'accident damage', 'totaled', 'water damage', 'mudslide', 'landslide', 'derecho', 'ice storm'] },
      ],
    },
  ];

  // Words that hint at a whole section — they nudge scores toward that section's lines
  // when the description is otherwise ambiguous ("donation to college" vs. "college tuition").
  const CONTEXT = [
    { sections: ['charity', 'volunteer'], words: ['donation', 'donate', 'donated', 'gift', 'gave', 'contribution', 'contributed', 'tithe', 'pledge', 'offering', 'charity'] },
    { sections: ['selfemp'], words: ['business', 'client', 'clients', 'work', 'job', 'invoice', 'customer', 'gig', 'side hustle', 'side-hustle', '1099', 'llc', 'shop', 'store', 'contract', 'freelance', 'consulting', 'etsy', 'ebay', 'uber', 'lyft', 'doordash', 'instacart'] },
    { sections: ['medical'], words: ['medical', 'health', 'doctor', 'hospital', 'prescription', 'patient', 'appointment', 'appt', 'clinic', 'treatment'] },
    { sections: ['education'], words: ['school', 'class', 'course', 'semester', 'student', 'college', 'university', 'campus', 'degree'] },
    { sections: ['taxes'], words: ['tax', 'taxes', 'county', 'assessor', 'treasurer'] },
    { sections: ['interest'], words: ['interest', 'loan', 'lender', 'mortgage'] },
  ];

  // Payments people often log that are NOT deductible — the tracker warns rather than silently filing them.
  const NON_DEDUCTIBLE = [
    { words: ['gofundme', 'go fund me', 'venmo to', 'zelle to', 'cashapp to', 'cash app to', 'gift for', 'gift card', 'gift cards', 'birthday', 'wedding gift', 'christmas gift', 'holiday gift', 'baby shower'], reason: 'Gifts to individuals (including crowdfunding for a person) are not deductible — only gifts to qualified organizations count.' },
    { words: ['raffle', 'raffle ticket', 'raffle tickets', '50/50'], reason: 'Raffle and lottery tickets bought from a charity are not deductible contributions.' },
    { words: ['girl scout cookies', 'girl scouts cookies', 'scout cookies', 'cookie sale', 'popcorn sale', 'wrapping paper sale', 'candy sale'], reason: 'Buying cookies, popcorn, or wrapping paper from a youth group is a purchase at fair value, not a gift. Only an amount above the value of what you received counts, as do cookies you pay for and leave with the troop.', suppress: ['vol.expenses', 'ch.org'] },
    { words: ['sierra club'], reason: 'Dues and gifts to the Sierra Club are not deductible because it is a 501(c)(4) advocacy group. Gifts to the Sierra Club Foundation are deductible.' },
    { words: ['political', 'campaign donation', 'candidate', 'pac', 'actblue', 'winred', 'super pac', 'dnc', 'rnc'], reason: 'Political contributions are never deductible.' },
    { words: ['federal tax', 'federal income tax', 'irs', 'irs payment', 'irs estimated', 'irs direct pay', 'usataxpymt', 'us treasury', 'eftps', 'federal estimated', '1040-es', '1040es', '1040 es', 'social security tax', 'medicare tax'], reason: 'Federal income tax, Social Security, and Medicare taxes are not deductible.', suppress: ['tax.state_income'] },
    { words: ['cosmetic', 'botox', 'teeth whitening', 'hair transplant', 'gym membership', 'vitamins', 'supplements', 'toothpaste', 'diet food'], reason: 'Cosmetic procedures, general health items, gym memberships, and vitamins are not medical deductions unless prescribed for a diagnosed condition.' },
    { words: ['hoa', 'hoa dues', 'homeowners association', 'homeowner\'s insurance', 'homeowners insurance', 'renters insurance', 'flood insurance', 'fire insurance', 'hazard insurance', 'windstorm insurance', 'hurricane insurance', 'earthquake insurance'], reason: 'HOA dues and insurance on a personal residence — homeowner\'s, renter\'s, flood, fire, windstorm — are not deductible. The Casualty line is for an actual loss from a declared disaster, not for the premium that covers it.', suppress: ['cas.loss'] },
    { words: ['animal hospital', 'pet hospital', 'veterinary', 'veterinarian', 'vet clinic', 'vca', 'banfield', 'petsmart', 'petco', 'chewy'], reason: 'Pet and veterinary costs are not deductible unless they are for a service animal.' },
    { words: ['personal loan interest', 'personal loan', 'credit card interest'], reason: 'Interest on credit cards and personal loans is not deductible.', suppress: ['edu.loan_interest'] },
    { words: ['car loan interest', 'auto loan interest', 'car loan', 'auto loan', 'car payment', 'auto payment', 'truck payment'], reason: 'A car payment is mostly loan principal, which is never deductible. The interest is a different matter: for 2025 through 2028, up to $10,000 a year of interest on a loan taken out after 2024 to buy a new personal-use vehicle (under 14,000 pounds, assembled in the United States) is deductible whether or not you itemize, phasing out above $100,000 of income ($200,000 on a joint return). Keep the lender\'s year-end interest statement and the purchase date, and tell your preparer. Interest on a vehicle used for your business belongs under Car & Trucking Expenses.', suppress: ['edu.loan_interest'] },
    { words: ['private school', 'k-12', 'k12', 'preschool', 'pre-k', 'pre k', 'kindergarten', 'montessori', 'parochial school', 'catholic school', 'christian academy', 'prep school', 'elementary school tuition', 'middle school tuition', 'high school tuition'], reason: 'K-12 and preschool tuition is not deductible on the federal return (some states allow it, and preschool may count toward the child care credit) — track it separately and tell your preparer.' },
    { words: ['life insurance', 'term life', 'whole life'], reason: 'Personal life insurance premiums are never deductible.' },
    { words: ['netflix', 'spotify', 'hulu', 'disney+', 'sling tv', 'youtube tv', 'hbo max', 'peacock', 'paramount+', 'paramount plus', 'apple tv+', 'directv', 'dish network', 'amazon prime', 'costco membership', 'sam\'s club membership', 'house cleaning', 'maid service'], reason: 'Personal subscriptions, memberships, and household services are not deductible.' },
    { words: ['commute', 'commuting', 'miles to work', 'drove to work', 'parking at work'], reason: 'Commuting between home and a regular workplace is never deductible mileage.' },
    { words: ['child care', 'childcare', 'daycare', 'day care', 'babysitter', 'nanny', 'au pair', 'after school care', 'after-school care', 'kindercare', 'bright horizons'], reason: 'Child care is a credit (Form 2441), not an expense on this worksheet — track it separately and tell your preparer.' },
  ];

  // ---- lookups --------------------------------------------------------------

  const LINES = [];
  const LINE_BY_ID = {};
  const SECTION_BY_ID = {};
  for (const s of SECTIONS) {
    SECTION_BY_ID[s.id] = s;
    for (const l of s.lines) {
      const line = Object.assign({ unit: 'usd', treatment: s.treatment, group: null, hint: null, rate: null, keywords: [], column: s.column }, l, { sectionId: s.id, sectionTitle: s.title });
      LINES.push(line);
      LINE_BY_ID[line.id] = line;
    }
  }

  function getLine(id) { return LINE_BY_ID[id] || null; }
  function getSection(id) { return SECTION_BY_ID[id] || null; }
  function linesForSection(sectionId) { return LINES.filter((l) => l.sectionId === sectionId); }
  function isMiles(lineOrId) {
    const l = typeof lineOrId === 'string' ? getLine(lineOrId) : lineOrId;
    return !!l && l.unit === 'miles';
  }

  return { TREATMENTS, SECTIONS, LINES, CONTEXT, NON_DEDUCTIBLE, getLine, getSection, linesForSection, isMiles };
});

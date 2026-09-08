/*
 * classify.js — suggests the worksheet line for a free-text description.
 *
 * Scoring is transparent: every suggestion carries the keywords that produced
 * it, so the UI can say "Prescription Drugs — because 'cvs', 'pharmacy'".
 * Corrections are learned per payee (a plain object the caller persists) and
 * outrank keyword matches the next time that payee shows up.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema.js'));
  else root.ItemizerClassify = factory(root.ItemizerSchema);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Schema) {
  'use strict';

  const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'at', 'on', 'in', 'and', 'or', 'with', 'from', 'my', 'our', 'paid', 'payment', 'bill', 'fee', 'fees', 'inc', 'llc', 'co', 'corp', 'store', 'online']);

  /** lower-case, strip punctuation that never carries meaning, collapse whitespace, pad with spaces */
  function normalize(text) {
    return ' ' + String(text || '')
      .toLowerCase()
      .replace(/[’`']/g, '')
      .replace(/[.,;:!?()[\]{}"#*_~<>|\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() + ' ';
  }
  /** a variant with hyphens and slashes turned to spaces, so "co-pay" also matches "co pay" */
  function loosen(norm) { return norm.replace(/[-\/]/g, ' ').replace(/\s+/g, ' '); }
  /** a variant with a plural ending dropped from each longer word, so "dentists" also matches "dentist" */
  function singularize(hay) { return hay.replace(/(\w{3,})(?:es|s)(?= )/g, '$1'); }

  // Pre-normalize keyword index once.
  const INDEX = Schema.LINES.map((line) => ({
    line,
    keywords: line.keywords.map((k) => {
      const n = normalize(k);
      return { raw: k, norm: n, loose: loosen(n), words: n.trim().split(' ').length, weight: 1 + 0.6 * (n.trim().split(' ').length - 1) + Math.min(n.trim().length, 14) / 28 };
    }),
  }));
  const CONTEXT = Schema.CONTEXT.map((c) => ({ sections: c.sections, words: c.words.map((w) => normalize(w)) }));
  const NON_DEDUCTIBLE = Schema.NON_DEDUCTIBLE.map((n) => ({ reason: n.reason, suppress: n.suppress || [], words: n.words.map((w) => normalize(w)) }));
  // The catch-all line each section falls back to when only context words matched. Taxes and interest have no safe catch-all.
  const FALLBACK = { medical: 'med.other', education: 'edu.expenses', selfemp: 'se.other', charity: 'ch.other', volunteer: 'vol.expenses' };

  function containsPhrase(hayNorm, hayLoose, needle) {
    return hayNorm.includes(needle.norm) || hayLoose.includes(needle.loose);
  }

  // "Dr" on its own was the weakest keyword in the schema, so any surname that happened to be a
  // keyword elsewhere ("Dr Ward", "Dr Cox") beat it. A title followed by a name is scored here
  // instead — except for the brands that begin with it, and for a street address ending in Dr.
  const HONORIFIC = /(^| )(dr|drs|doctor) ([a-z]{2,})/;
  const DR_BRANDS = new Set(['pepper', 'martens', 'marten', 'seuss', 'scholl', 'scholls', 'squatch', 'bronner', 'bronners', 'teals', 'horton', 'oz']);
  const STREET_DR = /\d+ [a-z]+ dr /;

  /** Key under which a description is remembered: lower-case, store numbers, statement dates and standalone amounts removed (tokens like 1098e stay). */
  function keyFor(description) {
    let k = normalize(description).replace(/#\d[\d,.\-]*/g, ' ').replace(/(^| )\d{1,2}\/\d{1,2}(\/\d{2,4})?(?= |$)/g, ' ').replace(/(^| )[$#]?\d[\d,.\-]*(?= |$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length > 48) k = k.slice(0, 48).trim();
    return k;
  }

  /**
   * @param {string} text          description / payee typed by the user
   * @param {object} [opts]        { learned: {key: lineId}, weights: {keyword: multiplier}, miles: boolean, limit: number,
   *                                 description: the payee on its own when `text` also carries the raw input, so a learned key still matches exactly }
   * @returns {{ suggestions: Array<{lineId, score, because: string[], learned?: boolean}>, nonDeductible: Array<{reason, matched}> }}
   */
  function classify(text, opts) {
    opts = opts || {};
    const limit = opts.limit || 4;
    const norm = normalize(text);
    const loose = loosen(norm);
    const stem = singularize(norm), stemLoose = singularize(loose);
    const scores = new Map(); // lineId -> { score, because:Set, learned, best }
    const bump = (lineId, amount, why, learned, matchLength) => {
      const cur = scores.get(lineId) || { score: 0, because: new Set(), learned: false, best: 0 };
      cur.score += amount;
      if (why) cur.because.add(why);
      if (learned) cur.learned = true;
      cur.best = Math.max(cur.best, matchLength || 0);
      scores.set(lineId, cur);
    };

    if (norm.trim()) {
      // 1. keyword matches
      for (const { line, keywords } of INDEX) {
        for (const kw of keywords) {
          if (containsPhrase(norm, loose, kw) || containsPhrase(stem, stemLoose, kw)) bump(line.id, kw.weight * ((opts.weights && opts.weights[kw.raw] > 0) ? opts.weights[kw.raw] : 1), kw.raw, false, kw.norm.trim().length);
        }
      }
      const title = HONORIFIC.exec(norm);
      if (title && !DR_BRANDS.has(title[3]) && !STREET_DR.test(norm)) bump('med.doctor', 1.3, 'title and name', false, title[0].trim().length);
      // 2. section context
      const activeSections = new Set();
      for (const c of CONTEXT) {
        for (const w of c.words) {
          if (norm.includes(w) || loose.includes(loosen(w))) { c.sections.forEach((sid) => activeSections.add(sid)); break; }
        }
      }
      if (activeSections.size) {
        for (const [lineId, rec] of scores) {
          const line = Schema.getLine(lineId);
          if (activeSections.has(line.sectionId)) rec.score += 0.7;
        }
        if (scores.size === 0) {
          // Nothing specific matched, but the context tells us the section: offer its catch-all line.
          for (const sid of activeSections) {
            if (FALLBACK[sid] && Schema.getLine(FALLBACK[sid])) bump(FALLBACK[sid], 0.4, 'section context');
          }
        }
      }
      // 3. learned payees outrank everything
      const learned = opts.learned || {};
      const keys = new Set([keyFor(text)]);
      if (opts.description) keys.add(keyFor(opts.description));
      for (const lk of Object.keys(learned)) {
        if (!lk || !Schema.getLine(learned[lk])) continue;
        const lkn = lk.replace(/['’`]/g, ''); // keys learned before apostrophes were stripped still match
        if (keys.has(lkn)) bump(learned[lk], 8, 'you filed this here before', true);
        // a partial match only counts for distinctive keys: a short generic word ("gas", "amazon") must not hijack every later entry
        else if ((lkn.includes(' ') || lkn.length >= 6) && norm.includes(' ' + lkn + ' ')) bump(learned[lk], 5, `"${lk}" filed here before`, true);
      }
    }

    // 4. miles vs dollars
    let list = [...scores.entries()].map(([lineId, rec]) => ({ lineId, score: rec.score, because: [...rec.because], learned: rec.learned, best: rec.best }));
    if (opts.miles) {
      const milesLines = Schema.LINES.filter((l) => l.unit === 'miles');
      const scoredMiles = list.filter((s) => Schema.isMiles(s.lineId));
      if (scoredMiles.length) list = scoredMiles;
      else {
        // infer the mileage line from whatever section the words point to
        const sectionHits = new Map();
        for (const s of list) { const sid = Schema.getLine(s.lineId).sectionId; sectionHits.set(sid, (sectionHits.get(sid) || 0) + s.score); }
        list = milesLines.filter((l) => l.treatment !== 'info').map((l) => {
          const related = { 'med.miles': 'medical', 'se.miles': 'selfemp', 'vol.miles': ['charity', 'volunteer'] }[l.id];
          const rel = Array.isArray(related) ? related : [related];
          const sc = rel.reduce((a, sid) => a + (sectionHits.get(sid) || 0), 0);
          return { lineId: l.id, score: 0.5 + sc, because: sc ? ['miles + ' + Schema.getSection(rel[0]).title.toLowerCase()] : ['miles'], learned: false, best: 0 };
        });
        if (/\b(odometer|total miles|all miles|annual miles)\b/.test(norm)) list.unshift({ lineId: 'se.total_miles', score: 9, because: ['odometer / total miles'], learned: false, best: 0 });
      }
    } else {
      // dollars typed: mileage lines only make sense if the words say "miles"
      list = list.filter((s) => !Schema.isMiles(s.lineId) || /\bmile|\bmi\b|mileage/.test(norm));
    }

    list.sort((a, b) => b.score - a.score || (b.best || 0) - (a.best || 0) || b.because.length - a.because.length || a.lineId.localeCompare(b.lineId));

    const nonDeductible = [];
    const suppressed = new Set();
    for (const nd of NON_DEDUCTIBLE) {
      const hit = nd.words.find((w) => norm.includes(w) || loose.includes(loosen(w)));
      if (hit) { nonDeductible.push({ reason: nd.reason, matched: hit.trim() }); nd.suppress.forEach((id) => suppressed.add(id)); }
    }
    // an IRS payment must not be offered as State Income Tax, a car loan not as Student Loan Interest
    if (suppressed.size) list = list.filter((s) => !suppressed.has(s.lineId));

    return { suggestions: list.slice(0, limit), nonDeductible, key: keyFor(text) };
  }

  /** Remember that this description belongs on lineId. Returns the (mutated) map. */
  function learn(map, description, lineId) {
    map = map || {};
    const key = keyFor(description);
    if (key && key.length >= 3 && Schema.getLine(lineId)) map[key] = lineId;
    return map;
  }
  function forget(map, key) { if (map) delete map[key]; return map; }

  return { classify, learn, forget, keyFor, normalize };
});

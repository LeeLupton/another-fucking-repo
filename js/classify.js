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
      .replace(/[’`]/g, '\'')
      .replace(/[.,;:!?()[\]{}"#*_~<>|\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() + ' ';
  }
  /** a variant with hyphens and slashes turned to spaces, so "co-pay" also matches "co pay" */
  function loosen(norm) { return norm.replace(/[-\/]/g, ' ').replace(/\s+/g, ' '); }

  // Pre-normalize keyword index once.
  const INDEX = Schema.LINES.map((line) => ({
    line,
    keywords: line.keywords.map((k) => {
      const n = normalize(k);
      return { raw: k, norm: n, loose: loosen(n), words: n.trim().split(' ').length, weight: 1 + 0.6 * (n.trim().split(' ').length - 1) + Math.min(n.trim().length, 14) / 28 };
    }),
  }));
  const CONTEXT = Schema.CONTEXT.map((c) => ({ sections: c.sections, words: c.words.map((w) => normalize(w)) }));
  const NON_DEDUCTIBLE = Schema.NON_DEDUCTIBLE.map((n) => ({ reason: n.reason, words: n.words.map((w) => normalize(w)) }));

  function containsPhrase(hayNorm, hayLoose, needle) {
    return hayNorm.includes(needle.norm) || hayLoose.includes(needle.loose);
  }

  /** Key under which a description is remembered: lower-case, digits and store numbers removed. */
  function keyFor(description) {
    let k = normalize(description).replace(/#?\d[\d,.\-]*/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length > 48) k = k.slice(0, 48).trim();
    return k;
  }

  /**
   * @param {string} text          description / payee typed by the user
   * @param {object} [opts]        { learned: {key: lineId}, miles: boolean, limit: number }
   * @returns {{ suggestions: Array<{lineId, score, because: string[], learned?: boolean}>, nonDeductible: Array<{reason, matched}> }}
   */
  function classify(text, opts) {
    opts = opts || {};
    const limit = opts.limit || 4;
    const norm = normalize(text);
    const loose = loosen(norm);
    const scores = new Map(); // lineId -> { score, because:Set, learned }
    const bump = (lineId, amount, why, learned) => {
      const cur = scores.get(lineId) || { score: 0, because: new Set(), learned: false };
      cur.score += amount;
      if (why) cur.because.add(why);
      if (learned) cur.learned = true;
      scores.set(lineId, cur);
    };

    if (norm.trim()) {
      // 1. keyword matches
      for (const { line, keywords } of INDEX) {
        for (const kw of keywords) {
          if (containsPhrase(norm, loose, kw)) bump(line.id, kw.weight * ((opts.weights && opts.weights[kw.raw] > 0) ? opts.weights[kw.raw] : 1), kw.raw);
        }
      }
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
            const lines = Schema.linesForSection(sid);
            const fallback = lines.find((l) => /other/i.test(l.label) && l.unit === 'usd') || lines[0];
            bump(fallback.id, 0.4, 'section context');
          }
        }
      }
      // 3. learned payees outrank everything
      const learned = opts.learned || {};
      const key = keyFor(text);
      for (const lk of Object.keys(learned)) {
        if (!lk || !Schema.getLine(learned[lk])) continue;
        if (lk === key) bump(learned[lk], 8, 'you filed this here before', true);
        else if (lk.length >= 3 && norm.includes(' ' + lk + ' ')) bump(learned[lk], 5, `"${lk}" filed here before`, true);
      }
    }

    // 4. miles vs dollars
    let list = [...scores.entries()].map(([lineId, rec]) => ({ lineId, score: rec.score, because: [...rec.because], learned: rec.learned }));
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
          return { lineId: l.id, score: 0.5 + sc, because: sc ? ['miles + ' + Schema.getSection(rel[0]).title.toLowerCase()] : ['miles'], learned: false };
        });
        if (/\b(odometer|total miles|all miles|annual miles)\b/.test(norm)) list.unshift({ lineId: 'se.total_miles', score: 9, because: ['odometer / total miles'], learned: false });
      }
    } else {
      // dollars typed: mileage lines only make sense if the words say "miles"
      list = list.filter((s) => !Schema.isMiles(s.lineId) || /\bmile|\bmi\b|mileage/.test(norm));
    }

    list.sort((a, b) => b.score - a.score || a.lineId.localeCompare(b.lineId));

    const nonDeductible = [];
    for (const nd of NON_DEDUCTIBLE) {
      const hit = nd.words.find((w) => norm.includes(w) || loose.includes(loosen(w)));
      if (hit) nonDeductible.push({ reason: nd.reason, matched: hit.trim() });
    }

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

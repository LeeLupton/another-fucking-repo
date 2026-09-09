/*
 * valuation.js — what donated goods are worth.
 *
 * The "Value of furniture/clothing donated" line is the one people guess at.
 * The IRS wants fair market value for items in good used condition or better,
 * and a record of what was given. This module carries a catalog of typical
 * thrift-shop value ranges (the kind published by Goodwill and The Salvation
 * Army), suggests a value by condition, totals an itemized list, and writes the
 * record that goes in the entry note. Values are starting points; the donor
 * decides and can override every one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerValuation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // [name, category, low, high, aliases] — typical value range in dollars for one item in good used
  // condition or better. Aliases are the words people type for the same thing ("couch", "fridge").
  // The large appliances are worth the most and are the ones people forget; many charities will not take a mattress.
  const RAW = [
    ['Shirt or blouse', 'Clothing', 2.5, 12], ['T-shirt', 'Clothing', 1, 6], ['Sweater', 'Clothing', 3.75, 15], ['Sweatshirt or hoodie', 'Clothing', 3, 12],
    ['Pants or jeans', 'Clothing', 3.5, 12, ['trousers', 'slacks']], ['Shorts', 'Clothing', 2, 8], ['Dress', 'Clothing', 4, 20], ['Skirt', 'Clothing', 3, 8],
    ['Suit', 'Clothing', 15, 60], ['Sport coat or blazer', 'Clothing', 7.5, 40], ['Winter coat', 'Clothing', 10, 60], ['Light jacket', 'Clothing', 5, 20],
    ['Pajamas or robe', 'Clothing', 2, 10], ['Swimsuit', 'Clothing', 2, 8], ['Hat, scarf, or gloves', 'Clothing', 1, 8], ['Belt or tie', 'Clothing', 1, 8],
    ['Shoes (pair)', 'Clothing', 2.5, 25], ['Boots (pair)', 'Clothing', 5, 40], ['Sneakers (pair)', 'Clothing', 3, 25], ['Handbag or purse', 'Clothing', 2, 20],
    ["Child's shirt or top", 'Children', 1, 6], ["Child's pants or jeans", 'Children', 1.5, 8], ["Child's dress", 'Children', 2, 12], ["Child's coat", 'Children', 3, 20],
    ["Child's shoes (pair)", 'Children', 1.5, 8], ['Baby clothing (each)', 'Children', 0.5, 4], ['Stroller', 'Children', 10, 75], ['Crib', 'Children', 25, 100], ['High chair', 'Children', 10, 40],
    ['Sofa', 'Furniture', 35, 200, ['couch']], ['Loveseat', 'Furniture', 25, 150], ['Upholstered chair', 'Furniture', 25, 100], ['Recliner', 'Furniture', 25, 150],
    ['Dining table', 'Furniture', 35, 135], ['Dining chair', 'Furniture', 5, 35], ['Kitchen table', 'Furniture', 25, 100], ['Coffee table', 'Furniture', 15, 65], ['End table', 'Furniture', 10, 50],
    ['Dresser', 'Furniture', 20, 100], ['Chest of drawers', 'Furniture', 25, 95], ['Nightstand', 'Furniture', 10, 50], ['Bed frame', 'Furniture', 20, 120], ['Headboard', 'Furniture', 10, 60],
    ['Bookcase', 'Furniture', 15, 75], ['Desk', 'Furniture', 25, 140], ['Office chair', 'Furniture', 10, 60], ['Lamp', 'Household', 4, 50], ['Rug', 'Household', 10, 90], ['Mirror', 'Household', 5, 40],
    ['Dishes (set)', 'Household', 5, 35], ['Glassware (set)', 'Household', 3, 20], ['Pot or pan', 'Household', 1, 10], ['Silverware (set)', 'Household', 5, 30], ['Small kitchen appliance', 'Household', 4, 25],
    ['Microwave', 'Household', 10, 50], ['Vacuum cleaner', 'Household', 15, 65], ['Bedding (set)', 'Household', 3, 25], ['Blanket or comforter', 'Household', 3, 25], ['Pillow', 'Household', 1, 5],
    ['Towel', 'Household', 0.5, 4], ['Curtains (pair)', 'Household', 1.5, 12], ['Picture or wall art', 'Household', 2, 25], ['Holiday decorations (box)', 'Household', 2, 15],
    ['Flat-screen TV', 'Electronics', 75, 225, ['television']], ['Computer or laptop (working)', 'Electronics', 50, 300], ['Computer monitor', 'Electronics', 10, 60], ['Printer', 'Electronics', 5, 75],
    ['Stereo or speaker', 'Electronics', 15, 75], ['Smartphone (working)', 'Electronics', 20, 150], ['Tablet (working)', 'Electronics', 20, 120], ['Video game console', 'Electronics', 20, 100],
    ['Hardcover book', 'Books & media', 1, 3], ['Paperback book', 'Books & media', 0.75, 1.5], ["Children's book", 'Books & media', 0.5, 2], ['DVD or Blu-ray', 'Books & media', 0.5, 3], ['CD or record', 'Books & media', 0.5, 3],
    ['Board game or puzzle', 'Toys & sports', 1, 5], ['Toy', 'Toys & sports', 0.5, 5], ['Stuffed animal', 'Toys & sports', 0.5, 3], ['Bicycle', 'Toys & sports', 5, 80, ['bike']], ['Golf clubs (set)', 'Toys & sports', 25, 150],
    ['Exercise equipment (large)', 'Toys & sports', 25, 200], ['Sports gear (each)', 'Toys & sports', 2, 25], ['Luggage (piece)', 'Toys & sports', 5, 25], ['Tools (hand tool)', 'Toys & sports', 1, 15], ['Power tool', 'Toys & sports', 10, 60],
    ['Refrigerator', 'Household', 50, 250, ['fridge']], ['Washing machine', 'Household', 40, 150, ['washer']], ['Clothes dryer', 'Household', 45, 90, ['dryer']], ['Stove or range', 'Household', 75, 150, ['oven']],
    ['Dishwasher', 'Household', 25, 100], ['Window air conditioner', 'Household', 20, 90], ['Mattress', 'Household', 20, 100], ['Blender or mixer', 'Household', 4, 25],
  ];
  const CATALOG = RAW.map(([name, category, low, high, aliases], i) => ({ id: 'v' + i, name, category, low, high, aliases: aliases || [] }));
  const CATEGORIES = [...new Set(CATALOG.map((c) => c.category))];
  const CONDITIONS = [
    { id: 'good', label: 'Good', factor: 0, note: 'worn but sound; the IRS minimum for clothing and household goods' },
    { id: 'very-good', label: 'Very good', factor: 0.5, note: 'lightly used, no flaws' },
    { id: 'excellent', label: 'Excellent', factor: 1, note: 'like new, complete, current' },
  ];
  const CONDITION_BY_ID = Object.fromEntries(CONDITIONS.map((c) => [c.id, c]));

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const roundQuarter = (n) => Math.round(n * 4) / 4;
  const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /** Catalog rows matching a query, best first. */
  function find(query, limit) {
    const q = norm(query);
    if (!q) return CATALOG.slice(0, limit || 10);
    const words = q.split(' ');
    const scored = CATALOG.map((c) => {
      const n = norm(c.name);
      let score = 0;
      if (n === q) score += 10;
      if (n.startsWith(q)) score += 5;
      if (n.includes(q)) score += 3;
      for (const w of words) if (w.length >= 2 && n.includes(w)) score += 1;
      // an alias scores a point below the same kind of name hit, so a real name always sorts first
      for (const a of c.aliases) {
        if (a === q) score += 9;
        if (a.startsWith(q)) score += 4;
        if (a.includes(q)) score += 2;
        for (const w of words) if (w.length >= 2 && a.includes(w)) score += 0.5;
      }
      return { c, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, limit || 10).map((x) => x.c);
  }
  function byName(name) { const n = norm(name); return CATALOG.find((c) => norm(c.name) === n) || CATALOG.find((c) => c.aliases.includes(n)) || null; }

  /** Suggested value for one item in the given condition. */
  function suggestValue(catalogItem, conditionId) {
    if (!catalogItem) return null;
    const cond = CONDITION_BY_ID[conditionId] || CONDITIONS[0];
    return roundQuarter(catalogItem.low + (catalogItem.high - catalogItem.low) * cond.factor);
  }

  /** items: [{ name, qty, condition, value }] */
  function lineTotal(item) { return cents((Number(item.qty) || 0) * (Number(item.value) || 0)); }
  function total(items) { return cents((items || []).reduce((a, it) => a + lineTotal(it), 0)); }
  function count(items) { return (items || []).reduce((a, it) => a + (Number(it.qty) || 0), 0); }

  function summarize(items) {
    const n = count(items);
    const parts = (items || []).slice(0, 4).map((it) => `${it.qty}× ${it.name}`);
    return `${n} ${n === 1 ? 'item' : 'items'}${parts.length ? ': ' + parts.join(', ') : ''}${(items || []).length > 4 ? ', …' : ''}`;
  }

  /** The record the IRS expects you to keep for a non-cash gift. Goes in the entry note. */
  function recordText(items, charity, date) {
    const lines = [`Donated to ${charity || 'charity'}${date ? ' on ' + date : ''}. Items in good used condition or better; values are fair-market (thrift-shop) estimates.`];
    for (const it of items || []) {
      const cond = CONDITION_BY_ID[it.condition] ? CONDITION_BY_ID[it.condition].label.toLowerCase() : it.condition;
      lines.push(`${it.qty}× ${it.name} (${cond}) @ $${Number(it.value).toFixed(2)} = $${lineTotal(it).toFixed(2)}`);
    }
    lines.push(`Total $${total(items).toFixed(2)}.`);
    return lines.join('\n');
  }

  function thresholds(totalValue, params) {
    const p = Object.assign({ nonCashForm8283: 500, nonCashAppraisal: 5000 }, params || {});
    return { form8283: totalValue > p.nonCashForm8283, appraisal: totalValue > p.nonCashAppraisal };
  }

  return { CATALOG, CATEGORIES, CONDITIONS, find, byName, suggestValue, lineTotal, total, count, summarize, recordText, thresholds };
});

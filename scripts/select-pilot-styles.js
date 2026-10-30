'use strict';

/**
 * Trims the full brand/category-matched catalog down to a curated first
 * import (~100-150 products), since "everything matching the pilot
 * brands/categories" turned out to be 1,400+ products — far more than the
 * originally scoped curated pilot.
 *
 * There's no sales data to rank "bestsellers" from a static product file,
 * so this curates deterministically instead: proportional representation
 * across categories, and round-robin across brands within each category so
 * no single vendor (Port Authority dominates the raw counts) crowds out
 * the rest. Writes the resulting SanMar STYLE# list to PILOT_STYLES in
 * .env, which epdd-parser.js's filter chain then respects automatically —
 * every downstream script (mapper.js, csv-converter.js) picks it up with
 * no further changes.
 *
 * Usage: node scripts/select-pilot-styles.js [--target 120] [--file path]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buildShopifyProducts } = require('../src/mapper');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const TARGET_TOTAL = targetIdx !== -1 ? parseInt(args[targetIdx + 1], 10) : 120;
const fileIdx = args.indexOf('--file');
const INPUT_FILE = fileIdx !== -1 ? args[fileIdx + 1] : path.join(__dirname, '../data/raw/SanMar_SDL_N.csv');

function curate(products, targetTotal) {
  const byCategory = new Map();
  for (const p of products) {
    if (!byCategory.has(p.product_type)) byCategory.set(p.product_type, new Map());
    const byVendor = byCategory.get(p.product_type);
    if (!byVendor.has(p.vendor)) byVendor.set(p.vendor, []);
    byVendor.get(p.vendor).push(p);
  }
  for (const byVendor of byCategory.values()) {
    for (const arr of byVendor.values()) arr.sort((a, b) => a.style.localeCompare(b.style));
  }

  const totalAvailable = products.length;
  const categoryTargets = new Map();
  for (const [cat, byVendor] of byCategory) {
    let count = 0;
    for (const arr of byVendor.values()) count += arr.length;
    const proportional = Math.round((targetTotal * count) / totalAvailable);
    categoryTargets.set(cat, Math.max(5, Math.min(proportional, count)));
  }

  const selected = [];
  for (const [cat, byVendor] of byCategory) {
    const vendors = [...byVendor.keys()];
    const cursors = new Map(vendors.map((v) => [v, 0]));
    const target = categoryTargets.get(cat);
    let picked = 0;

    while (picked < target) {
      let madeProgress = false;
      for (const v of vendors) {
        if (picked >= target) break;
        const arr = byVendor.get(v);
        const cursor = cursors.get(v);
        if (cursor < arr.length) {
          selected.push(arr[cursor]);
          cursors.set(v, cursor + 1);
          picked++;
          madeProgress = true;
        }
      }
      if (!madeProgress) break; // every vendor in this category is exhausted
    }
  }

  return selected;
}

async function main() {
  console.log(`Loading full brand/category-matched catalog from ${INPUT_FILE}...`);
  const allProducts = await buildShopifyProducts(INPUT_FILE);
  console.log(`  ${allProducts.length} products available before curation\n`);

  const curated = curate(allProducts, TARGET_TOTAL);
  const styles = curated.map((p) => p.style);

  console.log(`Curated selection: ${curated.length} products, target was ~${TARGET_TOTAL}`);

  const byVendor = {};
  const byCategory = {};
  for (const p of curated) {
    byVendor[p.vendor] = (byVendor[p.vendor] || 0) + 1;
    byCategory[p.product_type] = (byCategory[p.product_type] || 0) + 1;
  }
  console.log('\nBy vendor:');
  for (const [v, c] of Object.entries(byVendor).sort((a, b) => b[1] - a[1])) console.log(`  ${v}: ${c}`);
  console.log('\nBy category:');
  for (const [t, c] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${c}`);

  const totalVariants = curated.reduce((sum, p) => sum + p.variants.length, 0);
  console.log(`\nTotal variants: ${totalVariants}`);

  // Persist the selection to .env's PILOT_STYLES so every downstream script
  // (mapper.js, csv-converter.js) picks it up automatically.
  const envPath = path.join(__dirname, '../.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  const line = `PILOT_STYLES=${styles.join(',')}`;
  if (/^PILOT_STYLES=.*$/m.test(envContent)) {
    envContent = envContent.replace(/^PILOT_STYLES=.*$/m, line);
  } else {
    envContent = envContent.trimEnd() + `\n\n# Curated pilot style numbers (set by scripts/select-pilot-styles.js)\n${line}\n`;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`\nWrote PILOT_STYLES (${styles.length} style numbers) to .env`);

  const outPath = path.join(__dirname, '../data/processed/pilot_selection.json');
  fs.writeFileSync(outPath, JSON.stringify(curated.map((p) => ({
    style: p.style, title: p.title, vendor: p.vendor, category: p.product_type, variants: p.variants.length,
  })), null, 2));
  console.log(`Wrote review list to ${outPath}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

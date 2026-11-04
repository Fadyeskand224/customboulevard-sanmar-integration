'use strict';

/**
 * Report of every product live on the storefront: whether it came from the
 * client's price list, and its price on the site. Writes a CSV (opens in Excel)
 * and prints a summary.
 *
 *   node scripts/live-products-report.js [outfile.csv]
 *
 * Source column:
 *   Price list          created from the client's price list (tag priced-batch-2026-10)
 *   Added tee           extra best-selling t-shirt styles added later (not on the price list)
 *   Not on price list   older store products that were kept
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const shopify = require('../src/shopify');

const ADDED_TEES = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/processed/price-map-tees-2026-10-30.json'), 'utf8'))));
const styleOf = (t) => (t.trim().match(/([A-Z0-9][A-Z0-9-]+)\s*$/) || [])[1] || '';
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

let token = null;
async function gql(query, variables) {
  token = token || (await shopify.getAccessToken());
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`,
        { query, variables }, { headers: { 'X-Shopify-Access-Token': token }, timeout: 60000 });
      if (res.data.errors) throw new Error(JSON.stringify(res.data.errors).slice(0, 300));
      return res.data.data;
    } catch (err) { if (attempt === 5) throw err; await shopify.sleep(1500 * attempt); }
  }
  return null;
}

async function main() {
  const out = process.argv[2] || path.join(__dirname, `../docs/live-products-${new Date().toISOString().slice(0, 10)}.csv`);
  const rows = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($a: String) { products(first: 50, after: $a, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { title handle tags publishedAt onlineStoreUrl productType
        priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
        variantsCount { count } collections(first: 10) { nodes { title ruleSet { appliedDisjunctively } } } } } }`, { a: after });
    for (const p of d.products.nodes) {
      if (!p.publishedAt) continue;
      const style = styleOf(p.title);
      const batch = p.tags.includes('priced-batch-2026-10');
      const source = batch ? (ADDED_TEES.has(style) ? 'Added tee' : 'Price list') : 'Not on price list';
      const min = parseFloat(p.priceRangeV2.minVariantPrice.amount);
      const max = parseFloat(p.priceRangeV2.maxVariantPrice.amount);
      const cats = p.collections.nodes.filter((c) => !c.ruleSet).map((c) => c.title).join(' / ');
      rows.push({
        source, style: batch ? style : '', title: p.title.replace(/\s+/g, ' ').trim().replace(/\.\s*[A-Z0-9-]+$/, ''),
        price: min === max ? min.toFixed(2) : `${min.toFixed(2)}-${max.toFixed(2)}`, min, variants: p.variantsCount.count, cats, url: p.onlineStoreUrl,
      });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const order = { 'Price list': 0, 'Added tee': 1, 'Not on price list': 2 };
  rows.sort((a, b) => order[a.source] - order[b.source] || a.cats.localeCompare(b.cats) || a.title.localeCompare(b.title));
  fs.writeFileSync(out, ['Source,Style,Product,Price on site ($),Variants (color x size),Categories,Link']
    .concat(rows.map((r) => [r.source, r.style, r.title, r.price, r.variants, r.cats, r.url].map(csv).join(','))).join('\n'));
  const by = {};
  rows.forEach((r) => { (by[r.source] = by[r.source] || []).push(r); });
  console.log(`${rows.length} live product(s) -> ${out}`);
  for (const k of Object.keys(order)) if (by[k]) console.log(`  ${k}: ${by[k].length}   (price range $${Math.min(...by[k].map((r) => r.min)).toFixed(2)} - $${Math.max(...by[k].map((r) => r.min)).toFixed(2)})`);
  return rows;
}

if (require.main === module) main().catch((err) => { console.error(err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.stack || err.message); process.exit(1); });
module.exports = { main };

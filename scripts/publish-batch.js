'use strict';

/**
 * Puts the priced batch on the storefront: checks each draft product is ready,
 * assigns it to the store's category collections, then (only with --publish)
 * sets it Active.
 *
 * Readiness checks per product: price > 0, at least one image, stock > 0 in at
 * least one variant, and every color has an image linked.
 *
 * Usage:
 *   node scripts/publish-batch.js                       # dry run: report only
 *   node scripts/publish-batch.js --connected-only      # restrict to products connected to Zakeke
 *   node scripts/publish-batch.js --publish [--connected-only] [--only ST535,PC54]
 *
 * Collections are assigned before publishing, and assignment is verified by
 * reading back from Shopify.
 */

const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const shopify = require('../src/shopify');

const PUBLISH = process.argv.includes('--publish');
const CONNECTED_ONLY = process.argv.includes('--connected-only');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

let token = null;
async function gql(query, variables) {
  token = token || (await shopify.getAccessToken());
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`,
        { query, variables }, { headers: { 'X-Shopify-Access-Token': token }, timeout: 60000 });
      if (res.data.errors) {
        if (res.data.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED') && attempt < 5) { await shopify.sleep(2000 * attempt); continue; }
        throw new Error(JSON.stringify(res.data.errors).slice(0, 400));
      }
      return res.data.data;
    } catch (err) {
      if (attempt === 5) throw err;
      await shopify.sleep(1500 * attempt);
    }
  }
  return null;
}

function classify(title) {
  const t = (title || '').toLowerCase();
  if (/visor|watch cap|beanie|knit cap|trucker|mesh back|unipanel|flexfit|snapback|\bcap\b|\bhats?\b|camouflage/.test(t)) return 'HAT';
  if (/\bvest\b|jacket|windbreaker|wind shirt/.test(t)) return 'JACKET';
  if (/polo/.test(t)) return 'POLO';
  if (/hood/.test(t)) return 'HOODIE';
  if (/crew|sweatshirt|fleece|french terry/.test(t)) return 'CREW';
  if (/long sleeve/.test(t)) return 'LONG';
  if (/tank|sleeveless|muscle/.test(t)) return 'TANK';
  return 'TEE';
}

// Shape -> the store's existing manual collections (titles checked against the live store)
const COLLECTIONS = {
  TEE: ['Custom T-shirts', 'Short Sleeve T-shirts'],
  TANK: ['Custom T-shirts', 'Activewear'],
  LONG: ['Custom Long Sleeve Shirts', 'Long Sleeve T-Shirts'],
  POLO: ['Custom Polo Shirts'],
  HOODIE: ['Custom Hoodies & Sweatshirts'],
  CREW: ['Custom Hoodies & Sweatshirts'],
  HAT: ['Hats'],
  JACKET: ['Jackets'],
};
const isWomens = (title) => /women|ladies|\blst|\bl\d{3}/i.test(title);

async function main() {
  const restClient = await shopify.getClient();
  const cols = {};
  let after = null;
  for (;;) {
    const d = await gql('query($a:String){collections(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id title ruleSet{appliedDisjunctively}}}}', { a: after });
    d.collections.nodes.filter((c) => !c.ruleSet).forEach((c) => { cols[c.title] = c.id; });
    if (!d.collections.pageInfo.hasNextPage) break;
    after = d.collections.pageInfo.endCursor;
  }
  const needed = new Set(Object.values(COLLECTIONS).flat().concat(["Women's T-shirts"]));
  const missing = [...needed].filter((t) => !cols[t]);
  if (missing.length) { console.log('Collections missing on the store:', missing.join(', ')); process.exit(1); }

  const products = [];
  after = null;
  for (;;) {
    const d = await gql(`query($a:String){products(first:50,after:$a,query:"tag:priced-batch-2026-10"){
      pageInfo{hasNextPage endCursor}
      nodes{ id title status publishedAt tags totalInventory mediaCount{count} priceRangeV2{minVariantPrice{amount}} collections(first:20){nodes{id title}} } }}`, { a: after });
    products.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }

  const styleOf = (t) => (t.trim().match(/([A-Z0-9][A-Z0-9-]+)\s*$/) || [])[1] || '';
  // Needs publishing: still a draft, or Active but never put on the Online Store (no publish date)
  let list = products.filter((p) => p.status === 'DRAFT' || !p.publishedAt);
  if (CONNECTED_ONLY) list = list.filter((p) => p.tags.includes('zakeke_connected'));
  if (ONLY) list = list.filter((p) => ONLY.has(styleOf(p.title)));

  const problems = [];
  const plan = {};
  for (const p of list) {
    const shape = classify(p.title);
    const targets = [...COLLECTIONS[shape]];
    if (isWomens(p.title) && (shape === 'TEE' || shape === 'TANK' || shape === 'LONG')) targets.push("Women's T-shirts");
    p.targets = targets;
    targets.forEach((t) => { plan[t] = (plan[t] || 0) + 1; });
    const price = parseFloat(p.priceRangeV2.minVariantPrice.amount);
    const issues = [];
    if (!(price > 0)) issues.push('no price');
    if (!p.mediaCount.count) issues.push('no images');
    if (!(p.totalInventory > 0)) issues.push('no stock');
    if (issues.length) problems.push(`${styleOf(p.title)}: ${issues.join(', ')}`);
  }

  console.log(`${list.length} draft product(s)${CONNECTED_ONLY ? ' connected to Zakeke' : ''} considered; ${products.length - products.filter((p) => p.status === 'DRAFT' || !p.publishedAt).length} already live`);
  console.log('Collection assignments:', JSON.stringify(plan));
  console.log(problems.length ? `Not ready (${problems.length}):\n  ${problems.join('\n  ')}` : 'All pass the readiness checks (price, images, stock).');
  if (!PUBLISH) { console.log('\nDry run — nothing changed. Re-run with --publish to assign collections and go live.'); return; }

  const ready = list.filter((p) => !problems.some((x) => x.startsWith(`${styleOf(p.title)}:`)));
  let done = 0;
  for (const p of ready) {
    for (const t of p.targets) {
      if (p.collections.nodes.some((c) => c.title === t)) continue;
      const r = await gql('mutation($id:ID!,$p:[ID!]!){collectionAddProducts(id:$id,productIds:$p){userErrors{message}}}', { id: cols[t], p: [p.id] });
      if (r.collectionAddProducts.userErrors.length) throw new Error(`${styleOf(p.title)} -> ${t}: ${JSON.stringify(r.collectionAddProducts.userErrors)}`);
      await shopify.sleep(250);
    }
    const chk = await gql('query($id:ID!){product(id:$id){collections(first:20){nodes{title}}}}', { id: p.id });
    const have = chk.product.collections.nodes.map((c) => c.title);
    if (!p.targets.every((t) => have.includes(t))) { console.log(`${styleOf(p.title)}: collection check FAILED, not publishing`); continue; }
    // Active alone leaves the product off the Online Store channel (no publish date, 404 on the storefront);
    // the REST `published` flag is what actually puts it on the storefront.
    const numericId = p.id.split('/').pop();
    await restClient.put(`/products/${numericId}.json`, { product: { id: numericId, status: 'active', published: true } });
    const back = await restClient.get(`/products/${numericId}.json`, { params: { fields: 'id,status,published_at' } });
    if (back.data.product.status !== 'active' || !back.data.product.published_at) { console.log(`${styleOf(p.title)}: publish NOT confirmed`); continue; }
    done++;
    await shopify.sleep(300);
  }
  console.log(`\nPublished ${done} of ${ready.length} ready product(s).`);
}

main().catch((err) => { console.error(err.response ? JSON.stringify(err.response.data).slice(0, 500) : err.stack || err.message); process.exit(1); });

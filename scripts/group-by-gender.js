'use strict';
/**
 * Sets every category collection to manual sort and orders it Men's -> Women's -> Youth
 * (untagged non-apparel last), keeping the existing best-selling order inside each group.
 *   node scripts/group-by-gender.js [--dry-run]
 */
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const shopify = require('../src/shopify');

const SKIP = new Set(['tshirt', 'port-company-hoodie', 'build-gang-sheet', 'upload-gang-sheet-1', 'dtf', 'dtf-transfer-by-size', 'mugs', 'bags']);
const rank = (tags) => (tags.includes("Men's") ? 0 : tags.includes("Women's") ? 1 : tags.includes('Youth') ? 2 : 3);
let token;
async function gql(query, variables) {
  token = token || (await shopify.getAccessToken());
  for (let a = 1; a <= 5; a++) {
    try {
      const r = await axios.post(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`, { query, variables }, { headers: { 'X-Shopify-Access-Token': token }, timeout: 60000 });
      if (r.data.errors) throw new Error(JSON.stringify(r.data.errors).slice(0, 300));
      return r.data.data;
    } catch (e) { if (a === 5) throw e; await shopify.sleep(1500 * a); }
  }
}
async function main() {
  const dry = process.argv.includes('--dry-run');
  const cols = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($a:String){collections(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id handle title sortOrder}}}`, { a: after });
    cols.push(...d.collections.nodes);
    if (!d.collections.pageInfo.hasNextPage) break;
    after = d.collections.pageInfo.endCursor;
  }
  for (const c of cols) {
    if (SKIP.has(c.handle)) continue;
    const products = [];
    let pa = null;
    for (;;) {
      const d = await gql(`query($id:ID!,$a:String){collection(id:$id){products(first:100,after:$a,sortKey:COLLECTION_DEFAULT){pageInfo{hasNextPage endCursor} nodes{id tags status}}}}`, { id: c.id, a: pa });
      products.push(...d.collection.products.nodes);
      if (!d.collection.products.pageInfo.hasNextPage) break;
      pa = d.collection.products.pageInfo.endCursor;
    }
    const live = products.filter((p) => p.status === 'ACTIVE');
    if (live.length < 2) continue;
    const ordered = live.map((p, i) => ({ p, i })).sort((x, y) => rank(x.p.tags) - rank(y.p.tags) || x.i - y.i).map((x) => x.p);
    const groups = [0, 1, 2, 3].map((r) => live.filter((p) => rank(p.tags) === r).length);
    console.log(`${c.handle}: ${live.length} products  Men's ${groups[0]} / Women's ${groups[1]} / Youth ${groups[2]} / other ${groups[3]}`);
    if (dry) continue;
    if (c.sortOrder !== 'MANUAL') {
      const u = await gql(`mutation($i:CollectionInput!){collectionUpdate(input:$i){userErrors{message}}}`, { i: { id: c.id, sortOrder: 'MANUAL' } });
      if (u.collectionUpdate.userErrors.length) { console.log('  sort error', u.collectionUpdate.userErrors); continue; }
    }
    const moves = ordered.map((p, i) => ({ id: p.id, newPosition: String(i) }));
    for (let i = 0; i < moves.length; i += 250) {
      const r = await gql(`mutation($id:ID!,$m:[MoveInput!]!){collectionReorderProducts(id:$id,moves:$m){userErrors{message}}}`, { id: c.id, m: moves.slice(i, i + 250) });
      if (r.collectionReorderProducts.userErrors.length) console.log('  reorder error', r.collectionReorderProducts.userErrors);
    }
    await shopify.sleep(800);
  }
}
main().catch((e) => { console.error(e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.stack); process.exit(1); });

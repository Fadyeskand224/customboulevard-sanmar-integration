'use strict';

/**
 * First-ever live write test: creates a small, diverse handful of products
 * (one per category, capped) from the curated pilot selection via the real
 * Shopify Admin API — all as drafts (verified unpublished/invisible to
 * customers) so this can be reviewed in Admin before deciding to run the
 * full curated batch.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buildShopifyProducts } = require('../src/mapper');
const { bulkImportProducts, getClient } = require('../src/shopify');

const INPUT_FILE = path.join(__dirname, '../data/raw/SanMar_SDL_N.csv');
const MAX_PER_RUN = parseInt(process.argv[2] || '5', 10);

async function main() {
  console.log('Loading curated pilot products (PILOT_STYLES from .env)...');
  const allProducts = await buildShopifyProducts(INPUT_FILE);
  console.log(`  ${allProducts.length} products in the curated pilot set\n`);

  // One product per category, up to MAX_PER_RUN, for a representative test.
  const seenCategories = new Set();
  const subset = [];
  for (const p of allProducts) {
    if (subset.length >= MAX_PER_RUN) break;
    if (seenCategories.has(p.product_type)) continue;
    seenCategories.add(p.product_type);
    subset.push(p);
  }

  console.log(`Smoke-testing with ${subset.length} products (draft, unpublished):`);
  subset.forEach((p) => console.log(`  - [${p.product_type}] ${p.vendor} — ${p.title} (${p.variants.length} variants)`));

  const result = await bulkImportProducts(subset, { dryRun: false });

  console.log('\nVerifying created products are actually draft/unpublished via a fresh read...');
  const client = await getClient();
  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace('.myshopify.com', '');
  const fs = require('fs');
  const createdMap = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/processed/created_products.json'), 'utf8'));

  for (const p of subset) {
    const id = createdMap[p.title];
    if (!id) continue;
    const res = await client.get(`/products/${id}.json`);
    const prod = res.data.product;
    const safe = prod.status === 'draft' ? 'OK draft' : `WARNING status=${prod.status}`;
    console.log(`  ${safe} — https://admin.shopify.com/store/${domain}/products/${id}`);
  }

  console.log(`\nDone. Created: ${result.created} | Skipped (already existed): ${result.skipped} | Errors: ${result.errors}`);
}

main().catch((err) => {
  console.error('Smoke test failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

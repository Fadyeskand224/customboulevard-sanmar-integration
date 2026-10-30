'use strict';

/**
 * Creates additional products from the curated 120-style pilot pool, up to
 * a target total count (including whatever's already been created), then
 * immediately syncs real inventory onto each — same verified pipeline as
 * the initial 5-product smoke test. All created as drafts.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buildShopifyProducts } = require('../src/mapper');
const { bulkImportProducts, getClient, getLocationId, setInventoryLevel, sleep } = require('../src/shopify');
const { parseDipFile } = require('../src/inventory-sync');

const INPUT_FILE = path.join(__dirname, '../data/raw/SanMar_SDL_N.csv');
const DIP_FILE = path.join(__dirname, '../data/raw/sanmar_dip.txt');
const CREATED_MAP_FILE = path.join(__dirname, '../data/processed/created_products.json');

const TARGET_TOTAL = parseInt(process.argv[2] || '20', 10);
const REQUEST_DELAY_MS = 600;

async function main() {
  const createdMap = JSON.parse(fs.readFileSync(CREATED_MAP_FILE, 'utf8'));
  const alreadyCreated = new Set(Object.keys(createdMap));
  const needed = TARGET_TOTAL - alreadyCreated.size;

  console.log(`Already created: ${alreadyCreated.size} | Target: ${TARGET_TOTAL} | Need: ${needed} more\n`);
  if (needed <= 0) {
    console.log('Already at or above target — nothing to do.');
    return;
  }

  console.log('Loading curated pilot products...');
  const allProducts = await buildShopifyProducts(INPUT_FILE);

  // Spread the new picks across categories not already well-represented,
  // same round-robin-by-category approach as the original curation pass.
  const byCategory = new Map();
  for (const p of allProducts) {
    if (alreadyCreated.has(p.title)) continue;
    if (!byCategory.has(p.product_type)) byCategory.set(p.product_type, []);
    byCategory.get(p.product_type).push(p);
  }
  const categories = [...byCategory.keys()];
  const subset = [];
  let catIdx = 0;
  while (subset.length < needed) {
    let madeProgress = false;
    for (let i = 0; i < categories.length && subset.length < needed; i++) {
      const cat = categories[(catIdx + i) % categories.length];
      const arr = byCategory.get(cat);
      if (arr.length > 0) {
        subset.push(arr.shift());
        madeProgress = true;
      }
    }
    catIdx++;
    if (!madeProgress) break;
  }

  console.log(`Selected ${subset.length} new products:`);
  subset.forEach((p) => console.log(`  - [${p.product_type}] ${p.vendor} — ${p.title} (${p.variants.length} variants)`));

  console.log('\nCreating (draft, unpublished)...');
  const result = await bulkImportProducts(subset, { dryRun: false });
  console.log(`Created: ${result.created} | Skipped: ${result.skipped} | Errors: ${result.errors}\n`);

  // Sync real inventory onto everything just created.
  console.log('Parsing sanmar_dip.txt for real inventory...');
  const inventory = await parseDipFile(DIP_FILE);
  console.log(`  ${inventory.size} SKUs with inventory data\n`);

  const client = await getClient();
  const locationId = await getLocationId();
  const updatedCreatedMap = JSON.parse(fs.readFileSync(CREATED_MAP_FILE, 'utf8'));
  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace('.myshopify.com', '');

  for (const p of subset) {
    const id = updatedCreatedMap[p.title];
    if (!id) { console.log(`  SKIP inventory for "${p.title}" — no created id found (creation may have errored)`); continue; }

    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,variants' } });
    let noDataCount = 0;
    for (const variant of res.data.product.variants) {
      if (!inventory.has(variant.sku)) { noDataCount++; continue; }
      await setInventoryLevel(client, locationId, variant.inventory_item_id, inventory.get(variant.sku));
      await sleep(REQUEST_DELAY_MS);
    }
    console.log(`  Inventory synced: ${p.title}${noDataCount ? ` (${noDataCount} SKUs had no dip.txt data)` : ''}`);
  }

  console.log('\nVerifying all newly created products via fresh read...\n');
  for (const p of subset) {
    const id = updatedCreatedMap[p.title];
    if (!id) continue;
    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,title,status,variants' } });
    const product = res.data.product;
    const prices = product.variants.map((v) => parseFloat(v.price));
    const totalQty = product.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
    console.log(`  ${product.title}`);
    console.log(`    status: ${product.status} | price: \$${Math.min(...prices)}${Math.max(...prices) !== Math.min(...prices) ? '-\$' + Math.max(...prices) : ''} | total units: ${totalQty}`);
    console.log(`    https://admin.shopify.com/store/${domain}/products/${id}`);
  }
}

main().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

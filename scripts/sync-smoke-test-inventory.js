'use strict';

/**
 * Pushes real, aggregated (across all SanMar warehouses) inventory from
 * sanmar_dip.txt onto the 5 already-created live draft products, then
 * verifies by reading the values back from Shopify rather than trusting
 * the write response.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { parseDipFile } = require('../src/inventory-sync');
const { getClient, getLocationId, setInventoryLevel, sleep } = require('../src/shopify');

const REQUEST_DELAY_MS = 600; // Shopify REST limit: ~2 req/s — same pacing as inventory-sync.js

const DIP_FILE = path.join(__dirname, '../data/raw/sanmar_dip.txt');
const CREATED_MAP_FILE = path.join(__dirname, '../data/processed/created_products.json');

async function main() {
  console.log('Parsing sanmar_dip.txt (aggregating quantity across all warehouses per SKU)...');
  const inventory = await parseDipFile(DIP_FILE);
  console.log(`  ${inventory.size} SKUs with inventory data\n`);

  const createdMap = JSON.parse(fs.readFileSync(CREATED_MAP_FILE, 'utf8'));
  const client = await getClient();
  const locationId = await getLocationId();
  console.log(`Using Shopify location ID: ${locationId}\n`);

  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace('.myshopify.com', '');

  for (const [title, id] of Object.entries(createdMap)) {
    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,title,variants' } });
    const product = res.data.product;
    console.log(`${title} (id ${id})`);

    for (const variant of product.variants) {
      const qty = inventory.has(variant.sku) ? inventory.get(variant.sku) : null;
      if (qty === null) {
        console.log(`  NO DATA  SKU ${variant.sku} — not found in dip.txt (may be discontinued or genuinely absent)`);
        continue;
      }
      await setInventoryLevel(client, locationId, variant.inventory_item_id, qty);
      console.log(`  SET  SKU ${variant.sku}: ${qty} units`);
      await sleep(REQUEST_DELAY_MS);
    }
    console.log('');
  }

  console.log('Verifying via fresh read...\n');
  for (const [title, id] of Object.entries(createdMap)) {
    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,title,variants,status' } });
    const product = res.data.product;
    const totalQty = product.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
    const zeroCount = product.variants.filter((v) => (v.inventory_quantity || 0) === 0).length;
    console.log(`  ${title}`);
    console.log(`    status: ${product.status} | total units across ${product.variants.length} variants: ${totalQty} | ${zeroCount} variant(s) at 0`);
    console.log(`    https://admin.shopify.com/store/${domain}/products/${id}`);
  }
}

main().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

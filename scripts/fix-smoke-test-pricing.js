'use strict';

/**
 * One-off correction: the 5 already-created live (draft) smoke-test products
 * were priced with a bug (mapper.js applied zero markup) and then a too-flat
 * multiplier. Recomputes correct prices with the category-tiered model and
 * PATCHes each variant on Shopify, then verifies by reading back.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buildShopifyProducts } = require('../src/mapper');
const { getClient } = require('../src/shopify');

const INPUT_FILE = path.join(__dirname, '../data/raw/SanMar_SDL_N.csv');
const CREATED_MAP_FILE = path.join(__dirname, '../data/processed/created_products.json');

async function main() {
  const createdMap = JSON.parse(fs.readFileSync(CREATED_MAP_FILE, 'utf8'));
  console.log('Recomputing correct prices for:', Object.keys(createdMap));

  const products = await buildShopifyProducts(INPUT_FILE);
  const bySku = new Map();
  for (const p of products) {
    for (const v of p.variants) bySku.set(v.sku, v.price);
  }

  const client = await getClient();
  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace('.myshopify.com', '');

  for (const [title, id] of Object.entries(createdMap)) {
    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,title,variants' } });
    const product = res.data.product;
    console.log(`\n${title} (id ${id})`);

    for (const variant of product.variants) {
      const newPrice = bySku.get(variant.sku);
      if (!newPrice) {
        console.log(`  SKIP ${variant.sku} — no matching SKU in freshly computed product data`);
        continue;
      }
      if (variant.price === newPrice) {
        console.log(`  OK    ${variant.sku}: already \$${newPrice}`);
        continue;
      }
      await client.put(`/variants/${variant.id}.json`, { variant: { id: variant.id, price: newPrice } });
      console.log(`  FIXED ${variant.sku}: \$${variant.price} -> \$${newPrice}`);
    }
  }

  console.log('\nVerifying via fresh read...');
  for (const [title, id] of Object.entries(createdMap)) {
    const res = await client.get(`/products/${id}.json`, { params: { fields: 'id,title,variants,status' } });
    const product = res.data.product;
    const prices = product.variants.map((v) => parseFloat(v.price));
    const min = Math.min(...prices), max = Math.max(...prices);
    console.log(`  ${title} | status: ${product.status} | price range: \$${min}${max !== min ? '-\$' + max : ''} | https://admin.shopify.com/store/${domain}/products/${id}`);
  }
}

main().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

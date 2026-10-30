'use strict';

/**
 * Two-stage final step for the 20 curated pilot products:
 *  1. Assign each to the matching existing manual collection(s) on the
 *     store (your storefront's category tabs are driven by manual
 *     collections, not the raw product type/category field — confirmed
 *     by checking your actual collections, which are 18 manual + 2 smart
 *     that don't key off category at all).
 *  2. Publish (status: active) — only after collection assignment is
 *     verified, so nothing goes live miscategorized.
 *
 * Everything is verified by reading back from Shopify after each write,
 * not by trusting the write response.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buildShopifyProducts } = require('../src/mapper');
const { getClient, sleep } = require('../src/shopify');

const INPUT_FILE = path.join(__dirname, '../data/raw/SanMar_SDL_N.csv');
const CREATED_MAP_FILE = path.join(__dirname, '../data/processed/created_products.json');
const REQUEST_DELAY_MS = 600;

// Category -> matching existing collection title(s) on the store. Built
// from the real collection list (checked 2026-08-01): 18 manual collections
// including Activewear, Bags, Custom Hoodies & Sweatshirts, Custom Long
// Sleeve Shirts, Custom Polo Shirts, Custom T-shirts, Hats, Jackets, Long
// Sleeve T-Shirts, Short Sleeve T-shirts, Women's T-shirts.
const CATEGORY_TO_COLLECTIONS = {
  'T-Shirts': ['Custom T-shirts', 'Short Sleeve T-shirts'],
  'Polos/Knits': ['Custom Polo Shirts'],
  'Sweatshirts/Fleece': ['Custom Hoodies & Sweatshirts'],
  'Woven Shirts': ['Custom Long Sleeve Shirts'], // best available match; no dedicated "woven/button-up" collection exists
  'Activewear': ['Activewear'],
  'Outerwear': ['Jackets'],
  'Caps': ['Hats'],
  'Bags': ['Bags'],
};

async function getCollectionIdsByTitle(client) {
  const res = await client.get('/custom_collections.json', { params: { limit: 50, fields: 'id,title' } });
  const map = new Map();
  for (const c of res.data.custom_collections) map.set(c.title, c.id);
  return map;
}

async function main() {
  const createdMap = JSON.parse(fs.readFileSync(CREATED_MAP_FILE, 'utf8'));
  console.log(`Loading category data for ${Object.keys(createdMap).length} products...`);
  const products = await buildShopifyProducts(INPUT_FILE);
  const categoryByTitle = new Map(products.map((p) => [p.title, p.product_type]));

  const client = await getClient();
  const collectionIds = await getCollectionIdsByTitle(client);
  console.log('Found collections:', [...collectionIds.keys()].join(', '), '\n');

  console.log('=== Stage 1: Assigning collections ===\n');
  for (const [title, productId] of Object.entries(createdMap)) {
    const category = categoryByTitle.get(title);
    let targetTitles = CATEGORY_TO_COLLECTIONS[category] || [];
    if (/women'?s/i.test(title) && category === 'T-Shirts') {
      targetTitles = [...targetTitles, "Women's T-shirts"];
    }

    if (targetTitles.length === 0) {
      console.log(`  SKIP "${title}" — no collection mapping for category "${category}"`);
      continue;
    }

    for (const colTitle of targetTitles) {
      const collectionId = collectionIds.get(colTitle);
      if (!collectionId) {
        console.log(`  WARN "${title}" — collection "${colTitle}" not found on store`);
        continue;
      }
      try {
        await client.post('/collects.json', { collect: { product_id: productId, collection_id: collectionId } });
        console.log(`  ADDED "${title}" -> "${colTitle}"`);
      } catch (err) {
        const msg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.log(`  ERROR "${title}" -> "${colTitle}": ${msg}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log('\n=== Verifying collection assignments ===\n');
  let collectionIssues = 0;
  for (const [title, productId] of Object.entries(createdMap)) {
    const res = await client.get('/collects.json', { params: { product_id: productId, fields: 'collection_id' } });
    const assignedIds = res.data.collects.map((c) => c.collection_id);
    const assignedTitles = [...collectionIds.entries()].filter(([, id]) => assignedIds.includes(id)).map(([t]) => t);
    const category = categoryByTitle.get(title);
    const expected = CATEGORY_TO_COLLECTIONS[category] || [];
    const missing = expected.filter((t) => collectionIds.has(t) && !assignedTitles.includes(t));
    if (missing.length) {
      collectionIssues++;
      console.log(`  MISSING for "${title}": ${missing.join(', ')}`);
    } else {
      console.log(`  OK "${title}": [${assignedTitles.join(', ')}]`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (collectionIssues > 0) {
    console.log(`\n${collectionIssues} product(s) have incomplete collection assignment — NOT publishing until this is resolved.`);
    process.exit(1);
  }

  console.log('\nAll collection assignments verified clean. Proceeding to publish.\n');
  console.log('=== Stage 2: Publishing (status: active) ===\n');

  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace('.myshopify.com', '');
  for (const [title, productId] of Object.entries(createdMap)) {
    await client.put(`/products/${productId}.json`, { product: { id: productId, status: 'active' } });
    console.log(`  PUBLISHED "${title}"`);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log('\n=== Verifying publish status ===\n');
  let publishIssues = 0;
  for (const [title, productId] of Object.entries(createdMap)) {
    const res = await client.get(`/products/${productId}.json`, { params: { fields: 'id,title,status' } });
    const status = res.data.product.status;
    if (status !== 'active') {
      publishIssues++;
      console.log(`  NOT ACTIVE "${title}": status=${status}`);
    } else {
      console.log(`  ACTIVE "${title}" — https://admin.shopify.com/store/${domain}/products/${productId}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nDone. ${Object.keys(createdMap).length - publishIssues}/${Object.keys(createdMap).length} confirmed active.`);
}

main().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

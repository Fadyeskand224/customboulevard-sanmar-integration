'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { downloadSanmarFiles } = require('./sftp');
const { getClient, getLocationId, setInventoryLevel, sleep } = require('./shopify');

const RAW_DIR = path.join(__dirname, '../data/raw');
const DIP_FILE = path.join(RAW_DIR, 'sanmar_dip.txt');

const REQUEST_DELAY_MS = 600;

// sanmar_dip.txt is pipe-delimited with ONE ROW PER WAREHOUSE per SKU.
// Field positions per the SanMar FTP Integration Guide's Sanmar_dip.txt spec:
const DIP_FIELD = {
  INVENTORY_KEY: 0,
  SIZE_INDEX: 1,
  CATALOG_NO: 2,
  CATALOG_COLOR: 3,
  SIZE: 4,
  WHSE_NO: 5,
  QUANTITY: 6,
  UNIQUE_KEY: 17,
  DISCONTINUED_CODE: 18,
};

// sanmar_dip.txt fields are quote-encapsulated (e.g. "29223", not 29223) —
// strip the wrapping quotes, not just whitespace, or every field comparison
// silently fails (parseInt on a leading '"' returns NaN; a quoted string
// never equal-matches a clean Shopify SKU).
function stripQuotes(s) {
  return (s || '').trim().replace(/^"|"$/g, '').trim();
}

/**
 * Parses sanmar_dip.txt into a Map: unique_key -> aggregate available qty
 * (summed across all SanMar warehouses — this store shows one combined
 * stock number per SKU rather than per-location inventory, since SanMar
 * itself auto-selects the fulfilling warehouse per order regardless of
 * what a customer sees on the storefront).
 *
 * Keyed by SanMar's UNIQUE_KEY (INVENTORY_KEY + SIZE_INDEX), which is also
 * what mapper.js/csv-converter.js now use as the Shopify Variant SKU — this
 * is the field SanMar's own documentation designates for joining files.
 *
 * Discontinued (closeout) items — Discontinued_code = 'S' — stay in the map
 * like any other SKU. An earlier version dropped them whenever ANY single
 * warehouse row showed quantity 0, which also dropped closeout SKUs that
 * still had stock in another warehouse: the sync then skipped them and
 * Shopify kept a stale, oversellable quantity. Their summed quantity is
 * correct as-is, and reaching 0 is exactly when Shopify must be told.
 */
async function parseDipFile(filePath) {
  const inventory = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length <= DIP_FIELD.UNIQUE_KEY) continue;

    const uniqueKey = stripQuotes(parts[DIP_FIELD.UNIQUE_KEY]);
    const qty = parseInt(stripQuotes(parts[DIP_FIELD.QUANTITY]), 10) || 0;

    if (!uniqueKey) continue;

    inventory.set(uniqueKey, (inventory.get(uniqueKey) || 0) + qty);
  }

  return inventory;
}

/**
 * Fetches variants for live (status=active) products only, with their
 * inventory_item_id and sku. Handles pagination to retrieve every product.
 *
 * The plain /variants.json endpoint has no product-status filter and
 * returns every variant store-wide, including the couple hundred draft,
 * back-end-only products that were never meant to sync — this store keeps
 * a lot of those. Going through /products.json?status=active and
 * flattening each product's variants instead means a draft product's
 * stock is never touched, and the run has far fewer variants to walk.
 */
async function fetchAllVariants(client) {
  const variants = [];
  let url = '/products.json?limit=250&status=active&fields=id,variants';

  while (url) {
    const res = await client.get(url);
    for (const product of res.data.products) {
      for (const v of product.variants) {
        variants.push({ id: v.id, sku: v.sku, inventory_item_id: v.inventory_item_id, inventory_quantity: v.inventory_quantity });
      }
    }

    // Follow Shopify's Link header for pagination
    const linkHeader = res.headers.link || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      // Strip the base URL — axios baseURL will prepend it
      url = nextMatch[1].replace(/^https:\/\/[^/]+\/admin\/api\/\d{4}-\d{2}/, '');
    } else {
      url = null;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return variants;
}

/**
 * Downloads the latest DIP file from SanMar SFTP, then updates Shopify
 * inventory levels for any variant whose qty has changed.
 */
async function runInventorySync() {
  console.log('\n=== SanMar Inventory Sync ===');
  console.log(new Date().toISOString());

  // 1. Download fresh DIP file only — this sync doesn't touch product
  // data (EPDD.csv), so pulling that huge file every run would just slow
  // down what's meant to be a fast, frequent inventory-only refresh.
  await downloadSanmarFiles(['/SanMarPDD/sanmar_dip.txt']);

  // 2. Parse DIP inventory (aggregated across warehouses, keyed by unique_key)
  if (!fs.existsSync(DIP_FILE)) {
    throw new Error(`DIP file not found at ${DIP_FILE} — download may have failed`);
  }
  const sanmarInventory = await parseDipFile(DIP_FILE);
  console.log(`Parsed ${sanmarInventory.size} SKUs from DIP file`);

  // 3. Get Shopify location
  const locationId = await getLocationId();
  console.log(`Using Shopify location ID: ${locationId}`);

  // 4. Fetch all Shopify variants
  const client = await getClient();
  console.log('Fetching variants for live Shopify products...');
  const variants = await fetchAllVariants(client);
  console.log(`Found ${variants.length} variants on live products`);

  // 5. Update inventory where qty differs
  let updated = 0;
  let unchanged = 0;
  let notFound = 0;

  for (const variant of variants) {
    const sku = (variant.sku || '').trim();
    if (!sanmarInventory.has(sku)) {
      notFound++;
      continue;
    }

    const newQty = sanmarInventory.get(sku);
    const currentQty = variant.inventory_quantity;

    if (newQty === currentQty) {
      unchanged++;
      continue;
    }

    try {
      await setInventoryLevel(client, locationId, variant.inventory_item_id, newQty);
      console.log(`  Updated ${sku}: ${currentQty} → ${newQty}`);
      updated++;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.error(`  Error updating ${sku}: ${detail}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nSync complete. Updated: ${updated} | Unchanged: ${unchanged} | Not in DIP: ${notFound}`);
}

// Allow running standalone: node src/inventory-sync.js
if (require.main === module) {
  runInventorySync().catch((err) => {
    console.error('Inventory sync failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runInventorySync, parseDipFile };

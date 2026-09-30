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

/** Follows Shopify's Link header to the next page URL, or null on the last page. */
function nextPageUrl(res) {
  const match = (res.headers.link || '').match(/<([^>]+)>;\s*rel="next"/);
  // Strip the base URL — axios baseURL will prepend it back on.
  return match ? match[1].replace(/^https:\/\/[^/]+\/admin\/api\/\d{4}-\d{2}/, '') : null;
}

/**
 * Fetches variants for live (status=active) products only, with their
 * inventory_item_id and sku.
 *
 * The plain /variants.json endpoint has no product-status filter and
 * returns every variant store-wide, including the couple hundred draft,
 * back-end-only products that were never meant to sync — this store keeps
 * a lot of those. So this lists active product ids first, then fetches
 * each product's variants from its own /products/{id}/variants.json.
 *
 * That per-product fetch is deliberate, not just filtering client-side —
 * a product's `variants` array *embedded* in /products.json (or even
 * /products/{id}.json) is silently capped at 100 regardless of how many
 * variants it actually has, a longstanding REST quirk left over from
 * variants' old 100-per-product limit. This store has a live product with
 * 128 variants; fetched that way, the last 28 (here, several whole colors)
 * would never be seen and would go stale forever. The dedicated variants
 * endpoint has no such cap and paginates normally.
 */
async function fetchAllVariants(client) {
  const productIds = [];
  let url = '/products.json?limit=250&status=active&fields=id';
  while (url) {
    const res = await client.get(url);
    productIds.push(...res.data.products.map((p) => p.id));
    url = nextPageUrl(res);
    await sleep(REQUEST_DELAY_MS);
  }

  const variants = [];
  for (const id of productIds) {
    let vUrl = `/products/${id}/variants.json?limit=250&fields=id,sku,inventory_item_id,inventory_quantity`;
    while (vUrl) {
      const res = await client.get(vUrl);
      variants.push(...res.data.variants);
      vUrl = nextPageUrl(res);
      await sleep(REQUEST_DELAY_MS);
    }
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

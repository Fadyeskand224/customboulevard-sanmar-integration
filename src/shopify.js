'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PROCESSED_DIR = path.join(__dirname, '../data/processed');
const CREATED_PRODUCTS_FILE = path.join(PROCESSED_DIR, 'created_products.json');

// Shopify rate limit: ~2 requests/second on REST. We throttle conservatively.
const REQUEST_DELAY_MS = 600;

// Shopify sunsets REST API versions ~12 months after release. Set
// SHOPIFY_API_VERSION in .env once you know the store's current supported
// version; this default is a placeholder, not verified.
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

// This app was created via the Dev Dashboard (post-Jan-2026 apps don't get a
// static Admin API token in the UI). Instead we hold a Client ID + Secret and
// exchange them for a short-lived Admin API access token via the client
// credentials grant (https://shopify.dev/.../client-credentials-grant).
// Tokens expire after 24h (expires_in: 86399) — cached in-process and
// refetched with a safety margin, since these scripts are short CLI runs
// rather than a long-lived daemon that would need proactive refresh.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function fetchAccessToken() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(`https://${domain}/admin/oauth/access_token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });

  return res.data; // { access_token, scope, expires_in }
}

async function getAccessToken() {
  const SAFETY_MARGIN_MS = 60 * 1000;
  if (cachedToken && Date.now() < cachedTokenExpiresAt - SAFETY_MARGIN_MS) {
    return cachedToken;
  }
  const { access_token, expires_in } = await fetchAccessToken();
  cachedToken = access_token;
  cachedTokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

async function getClient() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getAccessToken();

  return axios.create({
    baseURL: `https://${domain}/admin/api/${API_VERSION}`,
    // Product creation with many nested variants can genuinely take Shopify
    // longer than 20s to process server-side — a low timeout here doesn't
    // mean the write failed, just that we stopped waiting for the response
    // (confirmed: a "timeout" product still got created). 45s gives real
    // hangs room to fail loudly without false-failing legitimate slow writes.
    timeout: 45000,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCreatedProducts() {
  if (!fs.existsSync(CREATED_PRODUCTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(CREATED_PRODUCTS_FILE, 'utf8'));
}

function saveCreatedProducts(map) {
  if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  }
  fs.writeFileSync(CREATED_PRODUCTS_FILE, JSON.stringify(map, null, 2));
}

/**
 * Returns the first Shopify product whose title matches, or null.
 * Used for upsert: skip styles that were already imported.
 */
async function findExistingProduct(client, title) {
  const res = await client.get('/products.json', {
    params: { title, fields: 'id,title', limit: 1 },
  });
  const products = res.data.products;
  return products.length > 0 ? products[0] : null;
}

// mapper.js attaches extra tracking fields (inventoryKey, sizeIndex, gtin,
// per-variant image) onto product/variant objects for internal use — these
// aren't valid Shopify REST fields and must be stripped before POSTing.
function toShopifyPayload(product) {
  return {
    title: product.title,
    body_html: product.body_html,
    vendor: product.vendor,
    product_type: product.product_type,
    tags: product.tags,
    status: product.status,
    options: product.options,
    images: product.images,
    variants: product.variants.map((v) => ({
      option1: v.option1,
      option2: v.option2,
      sku: v.sku,
      price: v.price,
      weight: v.weight,
      weight_unit: v.weight_unit,
      inventory_management: v.inventory_management,
      inventory_policy: v.inventory_policy,
      requires_shipping: v.requires_shipping,
      taxable: v.taxable,
      barcode: v.gtin || undefined,
    })),
  };
}

function basename(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').pop() || '').toLowerCase();
  } catch {
    return String(url).split('/').pop().split('?')[0].toLowerCase();
  }
}

function optionKey(option1, option2) {
  return `${(option1 || '').trim().toLowerCase()}||${(option2 || '').trim().toLowerCase()}`;
}

/**
 * Links each Shopify variant to the product image matching its intended
 * color, by filename. Must run as a follow-up call after the product (and
 * its images) already exist — Shopify's variant.image_id has to reference
 * an existing image, and images don't have ids yet in the same request
 * that creates them. Matching by filename (rather than variant order)
 * because Shopify re-hosts `src` to its own CDN URL but keeps the original
 * filename, and re-hosted image order isn't guaranteed to match input order.
 *
 * `mappedVariants` are mapper.js's pre-upload variant objects, each
 * carrying the intended `image.src` (the original SanMar image URL) plus
 * option1/option2 to match against the live Shopify variant.
 */
async function linkVariantImages(client, shopifyProduct, mappedVariants) {
  const imageIdByFilename = new Map(
    shopifyProduct.images.map((img) => [basename(img.src), img.id])
  );
  const mappedByOptions = new Map(
    mappedVariants.map((v) => [optionKey(v.option1, v.option2), v])
  );

  let linked = 0;
  let unmatched = 0;
  for (const liveVariant of shopifyProduct.variants) {
    if (liveVariant.image_id) continue; // already linked, leave it alone

    const wanted = mappedByOptions.get(optionKey(liveVariant.option1, liveVariant.option2));
    const imageId = wanted && wanted.image ? imageIdByFilename.get(basename(wanted.image.src)) : undefined;
    if (!imageId) {
      unmatched++;
      continue;
    }

    await client.put(`/variants/${liveVariant.id}.json`, {
      variant: { id: liveVariant.id, image_id: imageId },
    });
    linked++;
    await sleep(REQUEST_DELAY_MS);
  }

  return { linked, unmatched };
}

/**
 * Upserts a single Shopify product (creates if not found, skips if exists).
 * Returns { id, action: 'created' | 'skipped' }
 */
async function upsertProduct(client, productData) {
  const existing = await findExistingProduct(client, productData.title);
  if (existing) {
    return { id: existing.id, action: 'skipped' };
  }

  const res = await client.post('/products.json', { product: toShopifyPayload(productData) });
  const created = res.data.product;
  const { linked, unmatched } = await linkVariantImages(client, created, productData.variants);
  return { id: created.id, action: 'created', linked, unmatched };
}

/**
 * Bulk-imports an array of mapped Shopify product objects.
 * Writes created IDs to data/processed/created_products.json for rollback.
 * Pass dryRun=true to log without hitting the API.
 */
async function bulkImportProducts(products, { dryRun = false } = {}) {
  const client = dryRun ? null : await getClient();
  const createdMap = loadCreatedProducts();

  let created = 0;
  let skipped = 0;
  let errors = 0;

  console.log(`\nStarting bulk import of ${products.length} products${dryRun ? ' (DRY RUN)' : ''}...\n`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const label = `[${i + 1}/${products.length}] ${product.title}`;

    if (dryRun) {
      console.log(`DRY RUN ${label} — ${product.variants.length} variants`);
      continue;
    }

    try {
      const result = await upsertProduct(client, product);
      if (result.action === 'created') {
        createdMap[product.title] = result.id;
        created++;
        console.log(`  CREATED  ${label} (id: ${result.id}, images linked: ${result.linked}, unmatched: ${result.unmatched})`);
      } else {
        skipped++;
        console.log(`  SKIPPED  ${label} (already exists)`);
      }
      saveCreatedProducts(createdMap);
    } catch (err) {
      errors++;
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.error(`  ERROR    ${label} — ${detail}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nImport complete. Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
  return { created, skipped, errors };
}

// Draft, unpublished product(s) used purely as a place to host generated
// assets (e.g. Zakeke print-area masks) that need a public HTTPS URL but
// have no home of their own in the catalog. Shopify caps a product at 250
// images, so a high-volume batch (this file's largest single consumer so
// far: ~1,850 Zakeke masks in one run) will run the original host out of
// room partway through — confirmed in practice, not theoretical. Once a
// host fills up a new numbered one (" #2", " #3", ...) is created and used
// from then on; nothing already uploaded to a full host needs to move.
const ASSET_HOST_BASE_TITLE = '_internal-asset-host (do not publish — generated images live here)';
const ASSET_HOST_MAX_IMAGES = 245; // small safety margin under Shopify's 250 cap
let assetHostProductId = null;

function assetHostTitle(n) {
  return n <= 1 ? ASSET_HOST_BASE_TITLE : `${ASSET_HOST_BASE_TITLE} #${n}`;
}

/** Finds the highest-numbered existing host product, creating #1 if none exist yet. */
async function findLatestAssetHost(client) {
  let n = 1;
  let latest = null;
  for (;;) {
    const found = await findExistingProduct(client, assetHostTitle(n));
    if (!found) break;
    latest = { id: found.id, n };
    n++;
  }
  if (latest) return latest;
  const res = await client.post('/products.json', {
    product: { title: assetHostTitle(1), status: 'draft', published: false },
  });
  return { id: res.data.product.id, n: 1 };
}

/** Returns a host product id with room for at least one more image, rotating to a new one if needed. */
async function getAssetHostProduct(client, { forceFresh = false } = {}) {
  if (assetHostProductId && !forceFresh) return assetHostProductId;

  const latest = await findLatestAssetHost(client);
  const full = await client.get(`/products/${latest.id}.json`, { params: { fields: 'id,images' } });
  if (full.data.product.images.length < ASSET_HOST_MAX_IMAGES) {
    assetHostProductId = latest.id;
    return assetHostProductId;
  }

  // Current host is full — start the next one.
  const res = await client.post('/products.json', {
    product: { title: assetHostTitle(latest.n + 1), status: 'draft', published: false },
  });
  assetHostProductId = res.data.product.id;
  return assetHostProductId;
}

/**
 * Uploads a buffer as an image on an internal asset-host product and
 * returns its public Shopify CDN URL. Used to give externally-fetched
 * generated files (masks, etc.) a public URL without a dedicated file host.
 * Rotates to a fresh host and retries once if Shopify reports the current
 * one's 250-image cap reached (the cached host id can go stale mid-run if
 * something else filled it since this process last checked).
 */
async function uploadImageAsset(client, buffer, filename) {
  const productId = await getAssetHostProduct(client);
  try {
    const res = await client.post(`/products/${productId}/images.json`, {
      image: { attachment: buffer.toString('base64'), filename },
    });
    return res.data.image.src;
  } catch (err) {
    const limitHit = err.response && JSON.stringify(err.response.data).includes('Limit of 250 media');
    if (!limitHit) throw err;
    const freshId = await getAssetHostProduct(client, { forceFresh: true });
    const res = await client.post(`/products/${freshId}/images.json`, {
      image: { attachment: buffer.toString('base64'), filename },
    });
    return res.data.image.src;
  }
}

/**
 * Returns the Shopify location ID to use for inventory updates.
 * Picks the first active location found.
 */
async function getLocationId() {
  const client = await getClient();
  const res = await client.get('/locations.json');
  const locations = res.data.locations.filter((l) => l.active);
  if (!locations.length) throw new Error('No active Shopify locations found');
  return locations[0].id;
}

/**
 * Sets inventory level for a specific inventory_item_id at a location.
 */
async function setInventoryLevel(client, locationId, inventoryItemId, available) {
  await client.post('/inventory_levels/set.json', {
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    available,
  });
}

module.exports = { getClient, getAccessToken, bulkImportProducts, getLocationId, setInventoryLevel, sleep, linkVariantImages, uploadImageAsset };

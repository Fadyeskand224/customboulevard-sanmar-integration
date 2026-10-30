'use strict';

/**
 * Builds Shopify DRAFT products for an explicit list of SanMar style numbers,
 * each priced with a single flat retail price (from --prices), rather than
 * the curated-pilot weight-based multiplier used elsewhere in this project.
 *
 * Unlike the curated-pilot import (mapper.js / catalog-config.js), this does
 * NOT filter by ALLOWED_CATEGORIES/ALLOWED_BRANDS — the caller is handing us
 * an explicit style list (e.g. Nike, Carhartt, New Era aren't in the pilot
 * allowlist, but belong here if the style's in --prices).
 *
 * Pulls every color/size SanMar actually stocks for each style (real rows,
 * not a synthetic color x size cross-product), creates the product as
 * status: draft, tags include 'sanmar' + 'priced-batch-2026-10' so the
 * existing hourly inventory sync picks it up automatically once published,
 * and sets starting stock from --dip.
 *
 * Resumable: skips any style whose product (matched by title) already
 * exists, and records created ids to --out as it goes, so a crash/retry
 * doesn't duplicate work already done.
 *
 * Usage:
 *   node scripts/import-priced-batch.js --epdd <EPDD.csv> --dip <sanmar_dip.txt> \
 *     --prices <price-map.json> [--out created-priced-batch.json] [--only STYLE,STYLE]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parse } = require('csv-parse');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getClient, getLocationId, sleep } = require('../src/shopify');
const { parseDipFile } = require('../src/inventory-sync');

const GRAPHQL_VERSION = '2025-07';
const REQUEST_DELAY_MS = 600;
const VARIANTS_PER_BULK_CALL = 150; // stay well under Shopify's per-call cap

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const NAMED_ENTITIES = { amp: '&', reg: '®', trade: '™', deg: '°', nbsp: ' ', apos: "'", quot: '"' };
function decodeHtmlEntities(text) {
  return (text || '').replace(/&#(\d+);|&([a-z]+);/gi, (match, dec, name) => {
    if (dec) return String.fromCharCode(parseInt(dec, 10));
    return NAMED_ENTITIES[name.toLowerCase()] || match;
  });
}
const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
const httpOnly = (v) => (/^https?:\/\//i.test((v || '').trim()) ? v.trim() : '');

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', 'OSFA', 'ONE SIZE'];
function sizeRank(size) {
  const idx = SIZE_ORDER.indexOf((size || '').toUpperCase().trim());
  return idx === -1 ? 99 : idx;
}

function streamEpdd(file) {
  return fs.createReadStream(file).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true, bom: true })
  );
}

async function loadStyles(epddFile, wantStyles) {
  const byStyle = new Map();
  for await (const row of streamEpdd(epddFile)) {
    const style = (row['STYLE#'] || '').trim();
    if (!wantStyles.has(style)) continue;
    let p = byStyle.get(style);
    if (!p) {
      p = {
        style,
        title: decodeHtmlEntities(clean(row.PRODUCT_TITLE)),
        body_html: row.PRODUCT_DESCRIPTION,
        product_type: row.SUBCATEGORY_NAME || row.CATEGORY_NAME,
        tags: [row.CATEGORY_NAME, row.SUBCATEGORY_NAME, row.MILL, 'sanmar', 'priced-batch-2026-10'].filter(Boolean).join(', '),
        vendor: row.MILL || 'SanMar',
        rows: [],
        colorImages: new Map(), // mainframeColor -> [frontImg, backImg]
        seenSkus: new Set(),
      };
      byStyle.set(style, p);
    }
    const uk = clean(row.UNIQUE_KEY);
    if (p.seenSkus.has(uk)) continue; // cross-listed under multiple subcategories
    p.seenSkus.add(uk);

    const mainframeColor = clean(row.SANMAR_MAINFRAME_COLOR);
    if (mainframeColor && !p.colorImages.has(mainframeColor)) {
      p.colorImages.set(mainframeColor, [httpOnly(row.FRONT_MODEL_IMAGE_URL), httpOnly(row.BACK_MODEL_IMAGE)].filter(Boolean));
    }

    p.rows.push({
      uk,
      color: clean(row.COLOR_NAME),
      size: clean(row.SIZE),
      gtin: clean(row.GTIN),
      weight: parseFloat(row.PIECE_WEIGHT || '0'),
      mainframeColor,
    });
  }
  return byStyle;
}

async function findExistingProduct(client, title) {
  const res = await client.get('/products.json', { params: { title, fields: 'id,title', limit: 1 } });
  return res.data.products.length > 0 ? res.data.products[0] : null;
}

/**
 * True variant count via GraphQL, not the REST embed (capped at 100 — see
 * inventory-sync.js's fetchAllVariants for the same issue elsewhere).
 */
async function realVariantCount(client, productId) {
  const data = await graphql(client, `query($id: ID!) { product(id: $id) { variantsCount { count } } }`, {
    id: `gid://shopify/Product/${productId}`,
  });
  return data.product.variantsCount.count;
}

async function graphql(client, query, variables) {
  const res = await axios.post(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${GRAPHQL_VERSION}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': client.defaults.headers['X-Shopify-Access-Token'] }, timeout: 60000 }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

const BULK_CREATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku selectedOptions { name value } }
    userErrors { field message code }
  }
}`;

function loadProgress(outFile) {
  if (fs.existsSync(outFile)) return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return {};
}
function saveProgress(outFile, progress) {
  fs.writeFileSync(outFile, JSON.stringify(progress, null, 1));
}

async function buildProduct(client, locationId, p, price, stock) {
  p.rows.sort((a, b) => {
    const c = a.color.localeCompare(b.color);
    return c !== 0 ? c : sizeRank(a.size) - sizeRank(b.size);
  });

  const colors = [...new Set(p.rows.map((r) => r.color))];
  const sizes = [...new Set(p.rows.map((r) => r.size))].sort((a, b) => sizeRank(a) - sizeRank(b));

  // Shopify's REST create rejects a product that declares options but no
  // variant matching them — so the first real row goes in the create call
  // itself; every other row is bulk-added via GraphQL right after. No
  // `images` here: a wide-color style can mean 100+ image URLs, and Shopify
  // processing all of them synchronously in one product-create call is what
  // was blowing the 45s timeout on anything with 40+ colors. Every image is
  // uploaded afterward anyway (one call per color, to also link it to that
  // color's variants), so the bulk array up front was pure redundant cost.
  const [firstRow, ...restRows] = p.rows;
  const createRes = await client.post('/products.json', {
    product: {
      title: p.title,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: p.tags,
      status: 'draft',
      options: [{ name: 'Color', values: colors }, { name: 'Size', values: sizes }],
      variants: [{
        option1: firstRow.color,
        option2: firstRow.size,
        sku: firstRow.uk,
        price: price.toFixed(2),
        barcode: firstRow.gtin || undefined,
        weight: firstRow.weight > 0 ? firstRow.weight : undefined,
        weight_unit: 'lb',
        inventory_management: 'shopify',
        inventory_policy: 'deny',
        requires_shipping: true,
        taxable: true,
      }],
    },
  });
  const product = createRes.data.product;
  await sleep(REQUEST_DELAY_MS);

  const firstVariant = product.variants[0];
  await client.post('/inventory_levels/set.json', {
    location_id: locationId,
    inventory_item_id: firstVariant.inventory_item_id,
    available: stock.get(firstRow.uk) || 0,
  });
  await sleep(REQUEST_DELAY_MS);

  // Bulk-create every remaining real variant, batched.
  const allVariants = restRows.map((r) => ({
    optionValues: [{ optionName: 'Color', name: r.color }, { optionName: 'Size', name: r.size }],
    price: price.toFixed(2),
    barcode: r.gtin || undefined,
    inventoryPolicy: 'DENY',
    taxable: true,
    inventoryItem: {
      sku: r.uk,
      tracked: true,
      requiresShipping: true,
      measurement: r.weight > 0 ? { weight: { value: r.weight, unit: 'POUNDS' } } : undefined,
    },
    inventoryQuantities: [{ locationId: `gid://shopify/Location/${locationId}`, availableQuantity: stock.get(r.uk) || 0 }],
  }));

  const createdVariants = [{ id: `gid://shopify/ProductVariant/${firstVariant.id}`, sku: firstVariant.sku, selectedOptions: [{ name: 'Color', value: firstRow.color }, { name: 'Size', value: firstRow.size }] }];
  for (let i = 0; i < allVariants.length; i += VARIANTS_PER_BULK_CALL) {
    const batch = allVariants.slice(i, i + VARIANTS_PER_BULK_CALL);
    const data = await graphql(client, BULK_CREATE, { productId: `gid://shopify/Product/${product.id}`, variants: batch });
    const { productVariants, userErrors } = data.productVariantsBulkCreate;
    if (userErrors.length) throw new Error(`variant batch error on ${p.style}: ${JSON.stringify(userErrors)}`);
    createdVariants.push(...productVariants);
    await sleep(REQUEST_DELAY_MS);
  }

  // Upload each color's images: the front image linked to that color's
  // variants (so picking the swatch switches the product photo), and the
  // back image added to the gallery unlinked (same pattern as the earlier
  // missing-color-additions work).
  const idsByColor = new Map();
  for (const v of createdVariants) {
    const c = v.selectedOptions.find((o) => o.name === 'Color').value;
    (idsByColor.get(c) || idsByColor.set(c, []).get(c)).push(Number(v.id.split('/').pop()));
  }
  // mainframeColor -> real COLOR_NAME may differ in casing/whitespace; map via rows.
  const colorToMainframe = new Map(p.rows.map((r) => [r.color, r.mainframeColor]));
  for (const [color, ids] of idsByColor) {
    const urls = p.colorImages.get(colorToMainframe.get(color));
    if (!urls || !urls[0]) continue;
    await client.post(`/products/${product.id}/images.json`, { image: { src: urls[0], variant_ids: ids } });
    await sleep(REQUEST_DELAY_MS);
    if (urls[1]) {
      await client.post(`/products/${product.id}/images.json`, { image: { src: urls[1] } });
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return { id: product.id, variantCount: createdVariants.length, colorCount: colors.length };
}

async function main() {
  const epddFile = arg('--epdd');
  const dipFile = arg('--dip');
  const pricesFile = arg('--prices');
  const outFile = arg('--out', path.join(__dirname, '../data/processed/created-priced-batch.json'));
  const only = arg('--only');
  if (!epddFile || !dipFile || !pricesFile) {
    throw new Error('Usage: node scripts/import-priced-batch.js --epdd <EPDD.csv> --dip <sanmar_dip.txt> --prices <price-map.json> [--out file] [--only STYLE,STYLE]');
  }

  const priceMap = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
  let wantStyles = new Set(Object.keys(priceMap));
  if (only) wantStyles = new Set(only.split(',').map((s) => s.trim()));

  console.log(`Loading ${wantStyles.size} styles from EPDD...`);
  const byStyle = await loadStyles(epddFile, wantStyles);
  console.log(`Found ${byStyle.size} / ${wantStyles.size} in EPDD`);

  console.log('Parsing current warehouse stock...');
  const stock = await parseDipFile(dipFile);

  const client = await getClient();
  const locationId = await getLocationId();

  const progress = loadProgress(outFile);
  let created = 0, skipped = 0, failed = 0;

  for (const style of wantStyles) {
    const p = byStyle.get(style);
    if (!p) { console.log(`SKIP ${style}: not found in EPDD`); failed++; continue; }
    if (progress[style] && progress[style].status === 'created') { console.log(`SKIP ${style}: already created (product ${progress[style].id})`); skipped++; continue; }

    const price = priceMap[style];
    if (!price) { console.log(`SKIP ${style}: no price in price map`); failed++; continue; }

    try {
      const existing = await findExistingProduct(client, p.title);
      if (existing) {
        // A product can exist but be an incomplete leftover from a run that
        // got interrupted mid-build (seen in practice: killed right after
        // the initial 1-variant create, before the rest were bulk-added).
        // Don't just skip it as if it were a real finished product — check
        // its true variant count and rebuild from scratch if it's short.
        const realCount = await realVariantCount(client, existing.id);
        if (realCount < p.rows.length) {
          console.log(`  "${p.title}" exists (id ${existing.id}) but only has ${realCount}/${p.rows.length} variants — deleting and rebuilding`);
          await client.delete(`/products/${existing.id}.json`);
          await sleep(REQUEST_DELAY_MS);
        } else {
          console.log(`SKIP ${style} "${p.title}": a complete product with this title already exists (id ${existing.id})`);
          progress[style] = { status: 'skipped-existing', id: existing.id, title: p.title };
          saveProgress(outFile, progress);
          skipped++;
          continue;
        }
      }

      console.log(`Building ${style}: "${p.title}" — ${new Set(p.rows.map((r) => r.color)).size} colors, ${p.rows.length} variants, $${price}`);
      const result = await buildProduct(client, locationId, p, price, stock);
      progress[style] = { status: 'created', id: result.id, title: p.title, price, colorCount: result.colorCount, variantCount: result.variantCount };
      saveProgress(outFile, progress);
      created++;
      console.log(`  OK: product ${result.id}, ${result.colorCount} colors, ${result.variantCount} variants`);
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.error(`  FAILED ${style}: ${detail}`);
      progress[style] = { status: 'failed', error: detail };
      saveProgress(outFile, progress);
      failed++;
    }
  }

  console.log(`\nDone. Created: ${created} | Skipped: ${skipped} | Failed: ${failed}`);
}

main().catch((err) => {
  console.error('Fatal:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

'use strict';

/**
 * Adds every SanMar color a live SanMar product is missing.
 *
 * The original import skipped some colors (SanMar closeout/discontinued
 * colors that still have warehouse stock), so a product page could show
 * fewer colors than SanMar actually has for that style. For each active
 * product tagged "sanmar", this finds colors present in SanMar_EPDD.csv for
 * its style but absent from the product, and creates a variant for every
 * size of each — same SKU scheme (UNIQUE_KEY), pricing model, tracking and
 * weight as the original import — with starting stock taken from
 * sanmar_dip.txt. The hourly inventory sync keeps stock current afterwards.
 *
 * A color is only added if it still has stock in a warehouse or isn't
 * discontinued; fully dead colors are reported and skipped.
 *
 * Dry run by default (prints exactly what it would create).
 *
 * Usage:
 *   node scripts/add-missing-colors.js --epdd <EPDD.csv> --dip <sanmar_dip.txt>            # dry run
 *   node scripts/add-missing-colors.js --epdd <EPDD.csv> --dip <sanmar_dip.txt> --apply
 *   ...                                       --only <style>   # limit to one style (e.g. L475)
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getClient, getLocationId, sleep } = require('../src/shopify');
const { parseDipFile } = require('../src/inventory-sync');
const { multiplierForWeight } = require('../src/pricing');

// productVariantsBulkCreate on this API version lifts the old 100-variant
// cap (up to 2048), which the wide-color styles (e.g. 2000L) need.
const GRAPHQL_VERSION = '2025-07';
const REQUEST_DELAY_MS = 600;

const APPLY = process.argv.includes('--apply');
function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function streamEpdd(file) {
  return fs.createReadStream(file).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true, bom: true })
  );
}

const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
const httpOnly = (v) => (/^https?:\/\//i.test((v || '').trim()) ? v.trim() : '');

/** Two passes over EPDD: which style each live SKU belongs to, then every row of those styles. */
async function loadStyleRows(epddFile, liveSkus) {
  const styles = new Set();
  for await (const row of streamEpdd(epddFile)) {
    if (liveSkus.has((row.UNIQUE_KEY || '').trim())) styles.add(row['STYLE#']);
  }

  const byStyle = new Map();
  for await (const row of streamEpdd(epddFile)) {
    const style = row['STYLE#'];
    if (!styles.has(style)) continue;
    const list = byStyle.get(style) || byStyle.set(style, []).get(style);
    list.push({
      uk: (row.UNIQUE_KEY || '').trim(),
      color: clean(row.COLOR_NAME),
      size: clean(row.SIZE),
      price: parseFloat(row.PIECE_PRICE || '0'),
      weight: parseFloat(row.PIECE_WEIGHT || '0'),
      gtin: (row.GTIN || '').trim(),
      // Only real URLs: several image columns hold bare filenames, not links.
      frontImg: httpOnly(row.FRONT_MODEL_IMAGE_URL),
      backImg: httpOnly(row.BACK_MODEL_IMAGE),
    });
  }
  return byStyle;
}

// Same price model as the import (mapper.js): piece price times a multiplier
// set by the style's AVERAGE weight across its (de-duplicated) SKUs.
function styleMultiplier(rows) {
  const seen = new Set();
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (seen.has(r.uk)) continue;
    seen.add(r.uk);
    if (r.weight > 0) { sum += r.weight; count++; }
  }
  return multiplierForWeight(count > 0 ? sum / count : 0);
}

async function fetchActiveSanmarProducts(client) {
  const out = [];
  let url = '/products.json?limit=250&status=active&fields=id,title,tags,options,variants';
  while (url) {
    const res = await client.get(url);
    out.push(...res.data.products.filter((p) => (p.tags || '').split(',').map((t) => t.trim()).includes('sanmar')));
    const next = (res.headers.link || '').match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(/^https:\/\/[^/]+\/admin\/api\/\d{4}-\d{2}/, '') : null;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

const BULK_CREATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku selectedOptions { name value } }
    userErrors { field message code }
  }
}`;

async function graphql(client, query, variables) {
  const res = await axios.post(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${GRAPHQL_VERSION}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': client.defaults.headers['X-Shopify-Access-Token'] }, timeout: 60000 }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

async function main() {
  const epddFile = arg('--epdd');
  const dipFile = arg('--dip');
  const only = arg('--only');
  if (!epddFile || !dipFile) throw new Error('Usage: node scripts/add-missing-colors.js --epdd <EPDD.csv> --dip <sanmar_dip.txt> [--apply] [--only <style>]');

  const client = await getClient();
  const products = await fetchActiveSanmarProducts(client);
  console.log(`${products.length} active SanMar products on the store`);

  const liveSkus = new Set(products.flatMap((p) => p.variants.map((v) => String(v.sku || '').trim())).filter(Boolean));
  const byStyle = await loadStyleRows(epddFile, liveSkus);
  const stock = await parseDipFile(dipFile);
  const locationId = APPLY ? await getLocationId() : null;

  let totalCreated = 0;
  for (const product of products) {
    const colorIdx = product.options.findIndex((o) => /colou?r/i.test(o.name));
    const sizeIdx = product.options.findIndex((o) => /size/i.test(o.name));
    if (colorIdx === -1 || sizeIdx === -1) continue;
    const colorName = product.options[colorIdx].name;
    const sizeName = product.options[sizeIdx].name;

    const styleSet = new Set(
      product.variants.map((v) => String(v.sku || '').trim()).filter(Boolean)
        .map((sku) => [...byStyle].find(([, rows]) => rows.some((r) => r.uk === sku)))
        .filter(Boolean).map(([style]) => style)
    );
    if (styleSet.size !== 1) { console.log(`- ${product.title}: could not tie to one style, skipped`); continue; }
    const style = [...styleSet][0];
    if (only && only !== style) continue;

    const rows = byStyle.get(style);
    const liveColors = new Set(product.variants.map((v) => clean(v[`option${colorIdx + 1}`])));
    const liveSkusHere = new Set(product.variants.map((v) => String(v.sku || '').trim()));
    // Price from the colors already on the product: that reproduces the live prices exactly,
    // so new colors cost the same as their siblings (averaging in the added colors would shift it).
    const multiplier = styleMultiplier(rows.filter((r) => liveColors.has(r.color)));

    // De-duplicate cross-listed SKUs (same UNIQUE_KEY appears under several subcategories).
    const seen = new Set();
    const missingRows = rows.filter((r) => {
      if (seen.has(r.uk) || liveColors.has(r.color) || liveSkusHere.has(r.uk)) return false;
      seen.add(r.uk);
      return true;
    });
    if (missingRows.length === 0) continue;

    const byColor = new Map();
    for (const r of missingRows) (byColor.get(r.color) || byColor.set(r.color, []).get(r.color)).push(r);

    console.log(`\n${style}  ${product.title}  (currently ${liveColors.size} colors, ${product.variants.length} variants; price x${multiplier.toFixed(2)})`);

    const toCreate = [];
    for (const [color, colorRows] of byColor) {
      const units = colorRows.reduce((n, r) => n + (stock.get(r.uk) || 0), 0);
      if (units === 0) { console.log(`   skip  ${color}: no warehouse stock`); continue; }
      console.log(`   add   ${color}: ${colorRows.length} sizes, ${units} units in warehouses`);
      for (const r of colorRows) toCreate.push({ ...r, color });
    }
    if (toCreate.length === 0) continue;

    if (!APPLY) { totalCreated += toCreate.length; continue; }

    const inputs = toCreate.map((r) => ({
      optionValues: [
        { optionName: colorName, name: r.color },
        { optionName: sizeName, name: r.size },
      ],
      price: (r.price * multiplier).toFixed(2),
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

    const data = await graphql(client, BULK_CREATE, { productId: `gid://shopify/Product/${product.id}`, variants: inputs });
    const { productVariants, userErrors } = data.productVariantsBulkCreate;
    if (userErrors.length) {
      console.log(`   ERROR: ${JSON.stringify(userErrors)}`);
      continue;
    }
    console.log(`   created ${productVariants.length} variants`);
    totalCreated += productVariants.length;

    // Give each new color its photo(s), with the color's variants linked to the front image
    // so choosing the swatch switches the product picture (same as the import does).
    const idsByColor = new Map();
    for (const v of productVariants) {
      const c = v.selectedOptions.find((o) => o.name === colorName).value;
      (idsByColor.get(c) || idsByColor.set(c, []).get(c)).push(Number(v.id.split('/').pop()));
    }
    for (const [color, ids] of idsByColor) {
      const sample = toCreate.find((r) => r.color === color);
      if (sample.frontImg) {
        await client.post(`/products/${product.id}/images.json`, { image: { src: sample.frontImg, variant_ids: ids } });
        await sleep(REQUEST_DELAY_MS);
      }
      if (sample.backImg) {
        await client.post(`/products/${product.id}/images.json`, { image: { src: sample.backImg } });
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  console.log(`\n${APPLY ? 'Created' : 'Would create'} ${totalCreated} variants.${APPLY ? '' : ' Re-run with --apply to create them.'}`);
}

main().catch((err) => {
  console.error(err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

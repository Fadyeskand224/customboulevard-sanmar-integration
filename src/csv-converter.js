'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { streamFilteredEpddRows } = require('./epdd-parser');
const { MAX_VARIANTS_PER_PRODUCT } = require('./catalog-config');
const { multiplierForWeight } = require('./pricing');

const SIZE_ORDER = [
  'OSFA', 'ONE SIZE', 'XS', 'S', 'M', 'L', 'XL',
  '2XL', '3XL', '4XL', '5XL', '6XL',
];

function sizeRank(size) {
  const idx = SIZE_ORDER.indexOf((size || '').toUpperCase().trim());
  return idx === -1 ? 99 : idx;
}

function toHandle(brand, style) {
  return `${brand}-${style}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Streams EPDD rows into a Map of style -> { product meta, variants[], colorImages{} }.
 * SKU = SanMar's UNIQUE_KEY (INVENTORY_KEY + SIZE_INDEX), the field SanMar's
 * own docs designate for joining product data to inventory files.
 */
async function groupByStyle(filePath) {
  const styleMap = new Map();
  const stats = {};

  for await (const row of streamFilteredEpddRows(filePath, stats)) {
    const weightGrams = Math.round(row.pieceWeight * 453.592); // lbs -> grams

    if (!styleMap.has(row.style)) {
      styleMap.set(row.style, {
        handle: toHandle(row.mill || row.style, row.style),
        title: row.title,
        bodyHtml: row.description,
        vendor: row.mill || 'SanMar',
        type: row.subCategory || row.category,
        tags: ['SanMar', row.category, row.subCategory, row.mill].filter(Boolean).join(', '),
        colorImages: new Map(), // mainframeColor -> [frontUrl, backUrl]
        variants: [],
        colorSet: new Set(),
        sizeSet: new Set(),
        // Accumulated across all rows for this style so the multiplier can
        // be based on average weight across sizes, not whichever row
        // happens to stream in first — see mapper.js for full rationale.
        weightSum: 0,
        weightCount: 0,
      });
    }

    const product = styleMap.get(row.style);

    if (row.mainframeColor && !product.colorImages.has(row.mainframeColor)) {
      product.colorImages.set(row.mainframeColor, [row.frontImg, row.backImg].filter(Boolean));
    }
    product.colorSet.add(row.colorName);
    product.sizeSet.add(row.size);
    if (row.pieceWeight > 0) {
      product.weightSum += row.pieceWeight;
      product.weightCount++;
    }

    product.variants.push({
      colorName: row.colorName,
      mainframeColor: row.mainframeColor,
      size: row.size,
      sku: row.uniqueKey,
      _piecePrice: row.piecePrice, // finalized into `price` once the style's average weight is known
      compareAtPrice: '',
      weightGrams,
      frontImg: row.frontImg,
    });
  }

  // Drop styles that would exceed Shopify's 100-variant-per-product cap,
  // and finalize each remaining style's price from its average weight.
  let variantCapSkipped = 0;
  for (const [style, product] of styleMap) {
    if (product.colorSet.size * product.sizeSet.size > MAX_VARIANTS_PER_PRODUCT) {
      variantCapSkipped++;
      styleMap.delete(style);
      continue;
    }
    const avgWeight = product.weightCount > 0 ? product.weightSum / product.weightCount : 0;
    const multiplier = multiplierForWeight(avgWeight);
    for (const variant of product.variants) {
      variant.price = (variant._piecePrice * multiplier).toFixed(2);
      delete variant._piecePrice;
    }
  }

  console.log(
    `  Filtered out — category: ${stats.category}, brand: ${stats.brand}, ` +
    `status: ${stats.status}, not in PILOT_STYLES: ${stats.notSelected}, ` +
    `>${MAX_VARIANTS_PER_PRODUCT} variants: ${variantCapSkipped}, ` +
    `missing style/key: ${stats.noStyle} (of ${stats.total} rows scanned)`
  );

  return styleMap;
}

/**
 * Converts the style map into Shopify-format CSV rows.
 *
 * Shopify CSV rules:
 * - First row per product: all product columns + first variant columns
 * - Additional variant rows: only Handle + variant columns (product cols blank)
 * - Additional image rows: only Handle + Image Src + Image Position + Image Alt Text
 */
function buildShopifyRows(styleMap) {
  const rows = [];

  for (const [, product] of styleMap) {
    // Sort variants: by color name, then by size order
    product.variants.sort((a, b) => {
      const c = a.colorName.localeCompare(b.colorName);
      return c !== 0 ? c : sizeRank(a.size) - sizeRank(b.size);
    });

    // Collect ordered unique images (front + back per color, deduped)
    const images = [];
    const seenUrls = new Set();
    for (const [, urls] of product.colorImages) {
      for (const url of urls) {
        if (url && !seenUrls.has(url)) {
          images.push(url);
          seenUrls.add(url);
        }
      }
    }

    let isFirstRow = true;
    let imagePosition = 1;

    for (const variant of product.variants) {
      // Assign the variant's front image so Shopify links color → image
      const variantImage = variant.frontImg || '';

      if (isFirstRow) {
        rows.push({
          Handle: product.handle,
          Title: product.title,
          'Body (HTML)': product.bodyHtml,
          Vendor: product.vendor,
          'Product Category': '',
          Type: product.type,
          Tags: product.tags,
          Published: 'false',
          'Option1 Name': 'Color',
          'Option1 Value': variant.colorName,
          'Option2 Name': 'Size',
          'Option2 Value': variant.size,
          'Option3 Name': '',
          'Option3 Value': '',
          'Variant SKU': variant.sku,
          'Variant Grams': variant.weightGrams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': 0,
          'Variant Inventory Policy': 'deny',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': variant.price,
          'Variant Compare At Price': variant.compareAtPrice,
          'Variant Requires Shipping': 'true',
          'Variant Taxable': 'true',
          'Variant Barcode': '',
          'Image Src': images[0] || '',
          'Image Position': images[0] ? imagePosition : '',
          'Image Alt Text': images[0] ? `${product.title} - ${variant.colorName}` : '',
          'Gift Card': 'false',
          'SEO Title': product.title,
          'SEO Description': '',
          'Google Shopping / Google Product Category': '',
          'Google Shopping / Gender': '',
          'Google Shopping / Age Group': '',
          'Google Shopping / MPN': '',
          'Google Shopping / AdWords Grouping': '',
          'Google Shopping / AdWords Labels': '',
          'Google Shopping / Condition': 'new',
          'Google Shopping / Custom Product': '',
          'Variant Image': variantImage,
          'Variant Weight Unit': 'g',
          'Variant Tax Code': '',
          'Cost per item': '',
          Status: 'draft',
        });
        isFirstRow = false;
        imagePosition++;
      } else {
        // Subsequent variant rows — product columns stay blank
        rows.push({
          Handle: product.handle,
          Title: '',
          'Body (HTML)': '',
          Vendor: '',
          'Product Category': '',
          Type: '',
          Tags: '',
          Published: '',
          'Option1 Name': 'Color',
          'Option1 Value': variant.colorName,
          'Option2 Name': 'Size',
          'Option2 Value': variant.size,
          'Option3 Name': '',
          'Option3 Value': '',
          'Variant SKU': variant.sku,
          'Variant Grams': variant.weightGrams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': 0,
          'Variant Inventory Policy': 'deny',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': variant.price,
          'Variant Compare At Price': variant.compareAtPrice,
          'Variant Requires Shipping': 'true',
          'Variant Taxable': 'true',
          'Variant Barcode': '',
          'Image Src': '',
          'Image Position': '',
          'Image Alt Text': '',
          'Gift Card': '',
          'SEO Title': '',
          'SEO Description': '',
          'Google Shopping / Google Product Category': '',
          'Google Shopping / Gender': '',
          'Google Shopping / Age Group': '',
          'Google Shopping / MPN': '',
          'Google Shopping / AdWords Grouping': '',
          'Google Shopping / AdWords Labels': '',
          'Google Shopping / Condition': '',
          'Google Shopping / Custom Product': '',
          'Variant Image': variantImage,
          'Variant Weight Unit': 'g',
          'Variant Tax Code': '',
          'Cost per item': '',
          Status: '',
        });
      }
    }

    // Additional image rows (images beyond the first)
    for (let i = 1; i < images.length; i++) {
      rows.push({
        Handle: product.handle,
        Title: '', 'Body (HTML)': '', Vendor: '', 'Product Category': '',
        Type: '', Tags: '', Published: '',
        'Option1 Name': '', 'Option1 Value': '',
        'Option2 Name': '', 'Option2 Value': '',
        'Option3 Name': '', 'Option3 Value': '',
        'Variant SKU': '', 'Variant Grams': '',
        'Variant Inventory Tracker': '', 'Variant Inventory Qty': '',
        'Variant Inventory Policy': '', 'Variant Fulfillment Service': '',
        'Variant Price': '', 'Variant Compare At Price': '',
        'Variant Requires Shipping': '', 'Variant Taxable': '',
        'Variant Barcode': '',
        'Image Src': images[i],
        'Image Position': imagePosition++,
        'Image Alt Text': `${product.title} view ${i + 1}`,
        'Gift Card': '', 'SEO Title': '', 'SEO Description': '',
        'Google Shopping / Google Product Category': '',
        'Google Shopping / Gender': '', 'Google Shopping / Age Group': '',
        'Google Shopping / MPN': '', 'Google Shopping / AdWords Grouping': '',
        'Google Shopping / AdWords Labels': '', 'Google Shopping / Condition': '',
        'Google Shopping / Custom Product': '',
        'Variant Image': '', 'Variant Weight Unit': '',
        'Variant Tax Code': '', 'Cost per item': '', Status: '',
      });
    }
  }

  return rows;
}

async function convertEpddToShopifyCsv(inputPath, outputPath) {
  console.log(`Reading (streamed): ${inputPath}`);

  const styleMap = await groupByStyle(inputPath);
  console.log(`  ${styleMap.size} unique products after filtering`);

  const shopifyRows = buildShopifyRows(styleMap);
  console.log(`  ${shopifyRows.length} CSV rows generated (products + variants + images)`);

  const csv = stringify(shopifyRows, { header: true });
  fs.writeFileSync(outputPath, csv, 'utf8');
  console.log(`Output: ${outputPath}`);

  return { products: styleMap.size, csvRows: shopifyRows.length };
}

module.exports = { convertEpddToShopifyCsv };

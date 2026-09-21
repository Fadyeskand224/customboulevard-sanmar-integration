'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { streamFilteredEpddRows } = require('./epdd-parser');
const { MAX_VARIANTS_PER_PRODUCT } = require('./catalog-config');
const { multiplierForWeight } = require('./pricing');

// Maps SanMar size strings to a canonical sort order for variant display
const SIZE_ORDER = [
  'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL',
  'OSFA', 'ONE SIZE',
];

function sizeRank(size) {
  const idx = SIZE_ORDER.indexOf((size || '').toUpperCase().trim());
  return idx === -1 ? 99 : idx;
}

// SanMar's feed leaves HTML entities un-decoded even in fields meant as
// plain text (e.g. PRODUCT_TITLE carrying literal "&#174;" for the ®
// trademark symbol). Shopify's title field isn't rendered as HTML, so
// left as-is it shows the raw entity text to customers. body_html is
// genuinely HTML and is intentionally left untouched.
const NAMED_ENTITIES = { amp: '&', reg: '®', trade: '™', deg: '°', nbsp: ' ', apos: "'", quot: '"' };
function decodeHtmlEntities(text) {
  return (text || '').replace(/&#(\d+);|&([a-z]+);/gi, (match, dec, name) => {
    if (dec) return String.fromCharCode(parseInt(dec, 10));
    return NAMED_ENTITIES[name.toLowerCase()] || match;
  });
}

/**
 * Streams SanMar_EPDD.csv and builds Shopify-ready product objects — one
 * product per unique style number, with variants for each color+size combo.
 *
 * SKU is SanMar's own UNIQUE_KEY (INVENTORY_KEY + SIZE_INDEX combined), per
 * SanMar's guidance that this is the authoritative field for joining
 * product data to the inventory files (sanmar_dip.txt). Building SKUs from
 * style/color-name strings is fragile since color naming isn't guaranteed
 * identical across SanMar's files.
 */
async function buildShopifyProducts(filePath) {
  const styleMap = new Map();
  const stats = {};

  try {
    for await (const row of streamFilteredEpddRows(filePath, stats)) {
    if (!styleMap.has(row.style)) {
      styleMap.set(row.style, {
        title: decodeHtmlEntities(row.title),
        body_html: row.description,
        product_type: row.subCategory || row.category,
        tags: [row.category, row.subCategory, row.mill, 'sanmar'].filter(Boolean).join(', '),
        vendor: row.mill || 'SanMar',
        status: 'draft',
        variants: [],
        images: [],
        _colorImages: new Map(), // mainframeColor → image URLs (deduped)
        _colorSet: new Set(),
        _sizeSet: new Set(),
        // Accumulated across all rows for this style, so the pricing
        // multiplier can be based on the style's AVERAGE weight across
        // sizes rather than whichever row happens to stream in first
        // (arbitrary/file-order-dependent) or recomputed per row (which
        // would make different sizes of the identical garment carry
        // different profit multiples — SanMar's per-size shipping weight
        // estimates are noisy/non-monotonic, e.g. XS can show a lower
        // weight than S for the same garment). Finalized after streaming.
        _weightSum: 0,
        _weightCount: 0,
      });
    }

    const product = styleMap.get(row.style);

    // SanMar's feed cross-lists some SKUs under multiple subcategories
    // (e.g. the same UNIQUE_KEY appears once under "Grocery Totes" and
    // again under "Totes") — same physical variant, duplicate row.
    if (!product._seenSkus) product._seenSkus = new Set();
    if (product._seenSkus.has(row.uniqueKey)) continue;
    product._seenSkus.add(row.uniqueKey);

    if (row.mainframeColor && !product._colorImages.has(row.mainframeColor)) {
      product._colorImages.set(row.mainframeColor, [row.frontImg, row.backImg].filter(Boolean));
    }
    product._colorSet.add(row.colorName);
    product._sizeSet.add(row.size);
    if (row.pieceWeight > 0) {
      product._weightSum += row.pieceWeight;
      product._weightCount++;
    }

    product.variants.push({
      option1: row.colorName,
      option2: row.size,
      sku: row.uniqueKey,
      inventoryKey: row.inventoryKey,
      sizeIndex: row.sizeIndex,
      gtin: row.gtin,
      _piecePrice: row.piecePrice, // finalized into `price` once the style's average weight is known
      weight: row.pieceWeight > 0 ? row.pieceWeight : undefined,
      weight_unit: 'lb',
      inventory_management: 'shopify',
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: true,
      _mainframeColor: row.mainframeColor,
    });
    }
  } catch (err) {
    // SanMar_EPDD.csv is 500MB+ and has been observed truncated mid-row at
    // EOF (a bad download, not a data-quality issue csv-parse options can
    // fix) — don't discard every row already streamed successfully before
    // the cutoff just because the tail is broken.
    console.warn(`  Warning: EPDD stream ended early (${err.message}) — continuing with ${styleMap.size} product(s) parsed so far`);
  }

  // Convert map to array, sort variants, build images array
  const products = [];
  let variantCapSkipped = 0;

  for (const [styleNo, product] of styleMap) {
    // Guard Shopify's 100-variant-per-product hard limit.
    if (product._colorSet.size * product._sizeSet.size > MAX_VARIANTS_PER_PRODUCT) {
      variantCapSkipped++;
      continue;
    }

    product.variants.sort((a, b) => {
      const colorCmp = a.option1.localeCompare(b.option1);
      if (colorCmp !== 0) return colorCmp;
      return sizeRank(a.option2) - sizeRank(b.option2);
    });

    product.options = [
      { name: 'Color', values: [...new Set(product.variants.map(v => v.option1))] },
      { name: 'Size',  values: [...new Set(product.variants.map(v => v.option2))] },
    ];

    // One multiplier per style, from the average weight across all its
    // sizes — see the _weightSum/_weightCount comment above.
    const avgWeight = product._weightCount > 0 ? product._weightSum / product._weightCount : 0;
    const multiplier = multiplierForWeight(avgWeight);
    for (const variant of product.variants) {
      variant.price = (variant._piecePrice * multiplier).toFixed(2);
      delete variant._piecePrice;
    }

    // Flatten color images into a product-level images array, and record
    // each variant's front-image src so Shopify links color -> image.
    const seenUrls = new Set();
    for (const [, urls] of product._colorImages) {
      for (const url of urls) {
        if (url && !seenUrls.has(url)) {
          product.images.push({ src: url });
          seenUrls.add(url);
        }
      }
    }
    for (const variant of product.variants) {
      const colorImgs = product._colorImages.get(variant._mainframeColor) || [];
      if (colorImgs[0]) variant.image = { src: colorImgs[0] };
      delete variant._mainframeColor;
    }

    delete product._colorImages;
    delete product._colorSet;
    delete product._sizeSet;
    delete product._weightSum;
    delete product._weightCount;
    delete product._seenSkus;
    product.style = styleNo;
    products.push(product);
  }

  console.log(
    `  Filtered out — category: ${stats.category}, brand: ${stats.brand}, ` +
    `status: ${stats.status}, not in PILOT_STYLES: ${stats.notSelected}, ` +
    `>${MAX_VARIANTS_PER_PRODUCT} variants: ${variantCapSkipped}, ` +
    `missing style/key: ${stats.noStyle} (of ${stats.total} rows scanned)`
  );

  return products;
}

// Standalone test: node src/mapper.js data/raw/SanMar_EPDD.csv
if (require.main === module) {
  const filePath = process.argv[2] || path.join(__dirname, '../data/raw/SanMar_EPDD.csv');
  buildShopifyProducts(filePath).then((products) => {
    console.log(`Mapped to ${products.length} Shopify products`);
    console.log('Sample product:', JSON.stringify(products[0], null, 2));
  }).catch((err) => {
    console.error('Mapper error:', err.message);
    process.exit(1);
  });
}

module.exports = { buildShopifyProducts };

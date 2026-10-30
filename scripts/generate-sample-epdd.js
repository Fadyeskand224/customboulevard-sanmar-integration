'use strict';

/**
 * Regenerates data/raw/SanMar_EPDD_sample.csv using the REAL SanMar_EPDD.csv
 * column names (per the SanMar FTP Integration Guide), so local testing
 * exercises the same parsing/filtering logic that will run against a real
 * SanMar download. Deliberately includes rows that should be filtered out
 * (wrong category, wrong brand, discontinued, oversized variant count) so
 * the pilot allowlist logic in catalog-config.js gets exercised too.
 */

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');

const HEADERS = [
  'UNIQUE_KEY', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'STYLE#', 'AVAILABLE_SIZES',
  'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'COLOR_NAME', 'SIZE', 'QTY',
  'PIECE_WEIGHT', 'PIECE_PRICE', 'INVENTORY_KEY', 'SIZE_INDEX', 'SANMAR_MAINFRAME_COLOR',
  'MILL', 'PRODUCT_STATUS', 'MSRP', 'MAP_PRICING',
  'FRONT_MODEL_IMAGE_URL', 'BACK_MODEL_IMAGE_URL', 'GTIN',
];

const SIZES = ['S', 'M', 'L', 'XL'];
let nextInventoryKey = 100000;

function makeStyleRows({ style, title, desc, category, subCategory, mill, status = 'Active', colors, piecePrice, weight, sizes = SIZES }) {
  const rows = [];
  const inventoryKey = nextInventoryKey++;
  colors.forEach((colorName, colorIdx) => {
    const mainframeColor = colorName.toUpperCase().replace(/\s+/g, '').slice(0, 10);
    sizes.forEach((size, sizeIdx) => {
      const sizeIndex = sizeIdx + 1;
      const uniqueKey = `${inventoryKey}${sizeIndex}${colorIdx}`;
      rows.push({
        UNIQUE_KEY: uniqueKey,
        PRODUCT_TITLE: title,
        PRODUCT_DESCRIPTION: desc,
        'STYLE#': style,
        AVAILABLE_SIZES: sizes.join(', '),
        CATEGORY_NAME: category,
        SUBCATEGORY_NAME: subCategory,
        COLOR_NAME: colorName,
        SIZE: size,
        QTY: 250,
        PIECE_WEIGHT: weight,
        PIECE_PRICE: piecePrice,
        INVENTORY_KEY: inventoryKey,
        SIZE_INDEX: sizeIndex,
        SANMAR_MAINFRAME_COLOR: mainframeColor,
        MILL: mill,
        PRODUCT_STATUS: status,
        MSRP: (piecePrice * 3).toFixed(2),
        MAP_PRICING: (piecePrice * 2.2).toFixed(2),
        FRONT_MODEL_IMAGE_URL: `https://cdnm.sanmar.com/imglib/${style}_${mainframeColor}_front.jpg`,
        BACK_MODEL_IMAGE_URL: `https://cdnm.sanmar.com/imglib/${style}_${mainframeColor}_back.jpg`,
        GTIN: '00191265' + String(Math.floor(Math.random() * 900000) + 100000),
      });
    });
  });
  return rows;
}

const rows = [
  // In pilot scope: brand + category both allowed -> should be imported
  ...makeStyleRows({
    style: 'PC61', title: 'Port & Company PC61 Essential T-Shirt',
    desc: 'A customer favorite, 6.1-oz 100% cotton tee.',
    category: 'T-Shirts', subCategory: 'T-Shirts', mill: 'Port & Co',
    colors: ['Jet Black', 'True Red', 'Athletic Heather'],
    piecePrice: 4.98, weight: 0.3,
  }),
  ...makeStyleRows({
    style: '5000', title: 'Gildan Heavy Cotton T-Shirt',
    desc: '5.3 oz., 100% cotton preshrunk jersey knit.',
    category: 'T-Shirts', subCategory: 'T-Shirts', mill: 'Gildan',
    colors: ['White', 'Navy', 'Sport Grey', 'Forest Green'],
    piecePrice: 3.25, weight: 0.28,
  }),
  ...makeStyleRows({
    style: 'K420', title: 'Port Authority Pique Knit Polo',
    desc: '5.6-ounce, 65/35 poly/cotton pique polo.',
    category: 'Polos/Knits', subCategory: 'Pique Polos', mill: 'Port Authority',
    colors: ['Black', 'Deep Blue'],
    piecePrice: 8.50, weight: 0.45,
  }),

  // Wrong category — should be filtered out even though brand is allowed
  ...makeStyleRows({
    style: 'BG100', title: 'Port Authority Tote Bag',
    desc: 'Canvas tote bag.', category: 'Bags', subCategory: 'Totes',
    mill: 'Port Authority', colors: ['Natural'], piecePrice: 5.0, weight: 0.4,
  }),

  // Wrong brand — right category, but MILL not in the pilot allowlist
  ...makeStyleRows({
    style: 'NKDX1234', title: 'Nike Dri-FIT Tee',
    desc: 'Performance tee.', category: 'T-Shirts', subCategory: 'T-Shirts',
    mill: 'Nike', colors: ['Black'], piecePrice: 12.0, weight: 0.3,
  }),

  // Discontinued — should be filtered out regardless of brand/category
  ...makeStyleRows({
    style: 'PC61OLD', title: 'Port & Company Discontinued Tee',
    desc: 'No longer available.', category: 'T-Shirts', subCategory: 'T-Shirts',
    mill: 'Port & Co', status: 'Discontinued',
    colors: ['Black'], piecePrice: 4.0, weight: 0.3,
  }),

  // Oversized: 15 colors x 8 sizes = 120 variants, over Shopify's 100 cap
  ...makeStyleRows({
    style: 'BC3001', title: 'Bella+Canvas Unisex Jersey Tee (All Colors)',
    desc: '4.2 oz, airlume combed cotton.',
    category: 'T-Shirts', subCategory: 'T-Shirts', mill: 'Bella + Canvas',
    colors: Array.from({ length: 15 }, (_, i) => `Color ${i + 1}`),
    sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'],
    piecePrice: 4.10, weight: 0.25,
  }),
];

const csv = stringify(rows, { header: true, columns: HEADERS });
const outPath = path.join(__dirname, '../data/raw/SanMar_EPDD_sample.csv');
fs.writeFileSync(outPath, csv, 'utf8');
console.log(`Wrote ${rows.length} rows to ${outPath}`);

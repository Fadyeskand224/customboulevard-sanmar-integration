'use strict';

const fs = require('fs');
const { parse } = require('csv-parse');
const { ALLOWED_CATEGORIES, ALLOWED_BRANDS, EXCLUDED_STATUSES, ALLOWED_STYLES } = require('./catalog-config');

/**
 * Reads a value from a parsed EPDD row by its real SanMar column name(s).
 * Falls back to a case-insensitive match for minor header variations.
 */
function col(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return row[name].trim();
  }
  const lowerNames = names.map((n) => n.toLowerCase());
  for (const key of Object.keys(row)) {
    if (lowerNames.includes(key.toLowerCase()) && row[key] !== '') {
      return row[key].trim();
    }
  }
  return '';
}

/**
 * Streams SanMar_EPDD.csv row-by-row instead of loading it into memory —
 * the real file runs 500MB+, and `fs.readFileSync` + sync CSV parsing on a
 * file that size risks a very slow parse or exhausting the Node heap.
 *
 * Yields only rows that pass the curated-pilot category/brand/status
 * allowlist (catalog-config.js), with the relevant columns already pulled
 * out by their real SanMar field names. Mutates `stats` with skip counts
 * so callers can report what was filtered and why.
 */
async function* streamFilteredEpddRows(filePath, stats = {}) {
  stats.total = stats.total || 0;
  stats.passed = stats.passed || 0;
  stats.category = stats.category || 0;
  stats.brand = stats.brand || 0;
  stats.status = stats.status || 0;
  stats.noStyle = stats.noStyle || 0;
  stats.notSelected = stats.notSelected || 0;

  const parser = fs.createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true, bom: true })
  );

  for await (const row of parser) {
    stats.total++;

    const style = col(row, 'STYLE#', 'Style#');
    const uniqueKey = col(row, 'UNIQUE_KEY');
    const mill = col(row, 'MILL');
    const productStatus = col(row, 'PRODUCT_STATUS');

    // CATEGORY_NAME sometimes packs two categories into one semicolon-joined
    // field (e.g. "T-Shirts ;Women's") — match against any segment, not the
    // whole string, or compound rows silently fail an exact-match filter.
    const rawCategory = col(row, 'CATEGORY_NAME');
    const category = rawCategory
      .split(';')
      .map((s) => s.trim())
      .find((c) => ALLOWED_CATEGORIES.has(c));

    if (!style || !uniqueKey) { stats.noStyle++; continue; }
    if (!category) { stats.category++; continue; }
    if (ALLOWED_BRANDS.size > 0 && !ALLOWED_BRANDS.has(mill)) { stats.brand++; continue; }
    if (EXCLUDED_STATUSES.has(productStatus)) { stats.status++; continue; }
    if (ALLOWED_STYLES.size > 0 && !ALLOWED_STYLES.has(style)) { stats.notSelected++; continue; }

    stats.passed++;

    yield {
      style,
      uniqueKey,
      title: col(row, 'PRODUCT_TITLE'),
      description: col(row, 'PRODUCT_DESCRIPTION'),
      category,
      subCategory: col(row, 'SUBCATEGORY_NAME'),
      colorName: col(row, 'COLOR_NAME'),
      mainframeColor: col(row, 'SANMAR_MAINFRAME_COLOR'),
      size: col(row, 'SIZE'),
      piecePrice: parseFloat(col(row, 'PIECE_PRICE') || '0'),
      pieceWeight: parseFloat(col(row, 'PIECE_WEIGHT') || '0'),
      inventoryKey: col(row, 'INVENTORY_KEY'),
      sizeIndex: col(row, 'SIZE_INDEX'),
      mill,
      productStatus,
      frontImg: col(row, 'FRONT_MODEL_IMAGE_URL') || col(row, 'FRONT_FLAT_IMAGE_URL'),
      backImg: col(row, 'BACK_MODEL_IMAGE_URL') || col(row, 'BACK_FLAT_IMAGE_URL'),
      gtin: col(row, 'GTIN'),
    };
  }
}

module.exports = { col, streamFilteredEpddRows };

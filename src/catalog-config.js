'use strict';

/**
 * Shared curated-pilot configuration for the SanMar → Shopify import.
 *
 * Real SanMar CATEGORY_NAME values (SanMar Web Services Integration Guide,
 * "SanMar getProductInfoByCategory Service" table): Activewear, Accessories,
 * Bags, Bottoms, Caps, Infant & Toddler, Juniors & Young Men, Outerwear,
 * Personal Protection, Polos/Knits, Sweatshirts/Fleece, T-Shirts, Tall,
 * Women's, Woven Shirts, Workwear, Youth.
 *
 * Override either list via .env (comma-separated) without touching code.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

function fromEnvList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Matches Custom Blvd's existing storefront categories (DTF-decorated
// apparel + hats/bags): tees, long sleeves, hoodies/sweatshirts, polos,
// jackets, caps, bags.
const ALLOWED_CATEGORIES = new Set(fromEnvList('PILOT_CATEGORIES', [
  'T-Shirts',
  'Polos/Knits',
  'Sweatshirts/Fleece',
  'Woven Shirts',
  'Activewear',
  'Outerwear',
  'Caps',
  'Bags',
]));

// MILL field in SanMar's data. Values verified against the real
// SanMar_SDL_N.csv MILL column (42 distinct brands) — SanMar's actual
// spelling differs from the commonly-used names in a few cases:
// "Port & Co" (not "Port & Company"), "Bella + Canvas" (spaced),
// "Next Level Apparel" (not "Next Level").
const ALLOWED_BRANDS = new Set(fromEnvList('PILOT_BRANDS', [
  'Port & Co',
  'Port Authority',
  'Gildan',
  'Bella + Canvas',
  'Next Level Apparel',
  'District',
  'Sport-Tek',
  'Anvil',
]));

// PRODUCT_STATUS values: Coming Soon, New, Regular, Discontinued.
// Coming Soon data is explicitly documented as possibly incomplete.
const EXCLUDED_STATUSES = new Set(['Coming Soon', 'Discontinued']);

// Shopify hard limit: 100 variants per product (Color x Size combos).
const MAX_VARIANTS_PER_PRODUCT = parseInt(process.env.MAX_VARIANTS_PER_PRODUCT || '100', 10);

// Optional: restrict to a specific set of SanMar STYLE# numbers (set by
// scripts/select-pilot-styles.js for a curated first import). Empty = no
// restriction beyond category/brand/status.
const ALLOWED_STYLES = new Set(fromEnvList('PILOT_STYLES', []));

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_BRANDS,
  EXCLUDED_STATUSES,
  MAX_VARIANTS_PER_PRODUCT,
  ALLOWED_STYLES,
};

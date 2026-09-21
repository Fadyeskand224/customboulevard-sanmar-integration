'use strict';

/**
 * Retail pricing calibrated against Custom Blvd's actual live pricing for
 * matching SanMar styles already on the site (checked 2026-08-01, 7 matched
 * styles). A category-tiered model was tried first and produced a real
 * markup multiplier by garment type, but that broke badly on two live test
 * products: a jacket tagged "Activewear" (not "Outerwear") and a heavy
 * denim shirt tagged "Woven Shirts" (same category as light cotton tees)
 * both got the light-tier multiplier and came out wildly overpriced
 * ($87-$197 for the jacket).
 *
 * SanMar's PIECE_WEIGHT (physical weight per garment, in lbs) turned out to
 * be a far better predictor than category name — heavier garment = lower
 * markup multiplier, and unlike category labels this is a continuous,
 * unambiguous number every row has. Fit as a power law in log-log space
 * (multiplier = a * weight^b), which tracked the 7 real anchors far more
 * tightly than a linear fit or a category bucket:
 *
 *   weight   real mult   style
 *   0.32 lb  5.45x       5000   (Gildan tee)
 *   0.35 lb  5.04x       PC54   (Port & Co tee)
 *   0.42 lb  4.68x       KP55   (Port & Co polo)
 *   0.47 lb  4.14x       PC54LS (Port & Co long-sleeve tee)
 *   0.79 lb  2.64x       18000  (Gildan crewneck fleece)
 *   1.08 lb  2.65x       PC78H  (Port & Co fleece hoodie)
 *   1.11 lb  2.37x       18500  (Gildan hoodie)
 *
 *   Fit: multiplier = 2.550 * weight^-0.655, max residual 0.34x across
 *   all 7 anchors (vs 0.71x for a linear fit).
 *
 * Clamped to [MIN_MULTIPLIER, MAX_MULTIPLIER] as safety rails so a garment
 * far outside the weight range we calibrated against (near-zero weight, or
 * something unusually heavy) can't produce an absurd price.
 */

const FIT_A = parseFloat(process.env.PRICING_FIT_A || '2.550');
const FIT_B = parseFloat(process.env.PRICING_FIT_B || '-0.655');
const MIN_MULTIPLIER = parseFloat(process.env.PRICING_MIN_MULTIPLIER || '1.8');
const MAX_MULTIPLIER = parseFloat(process.env.PRICING_MAX_MULTIPLIER || '6.0');

// Fallback for rows with missing/zero PIECE_WEIGHT (rare) — the average
// multiplier across the 7 calibration anchors.
const FALLBACK_MULTIPLIER = 3.85;

function multiplierForWeight(pieceWeight) {
  if (!pieceWeight || pieceWeight <= 0) return FALLBACK_MULTIPLIER;
  const raw = FIT_A * Math.pow(pieceWeight, FIT_B);
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, raw));
}

function retailPrice(piecePrice, pieceWeight) {
  const multiplier = multiplierForWeight(pieceWeight);
  return (piecePrice * multiplier).toFixed(2);
}

module.exports = { retailPrice, multiplierForWeight, FIT_A, FIT_B, MIN_MULTIPLIER, MAX_MULTIPLIER };

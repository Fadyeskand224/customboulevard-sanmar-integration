'use strict';

/**
 * Connects the SanMar-imported products to Zakeke's Visual Product
 * Customizer via its CSV bulk-import API, since 17 of the 20 haven't
 * synced into Zakeke at all yet and 2 more only got a rough auto-generated
 * placeholder (see TEMPLATE_MAP below).
 *
 * Zakeke has no product-shape awareness of its own — for each product we
 * copy the print-area geometry (as a fraction of the reference image's own
 * width/height, so it survives a differently-shaped photo) from an
 * existing, already-configured product of a similar garment type, then
 * render a matching transparent-PNG mask sized to each color's actual
 * photo and submit it all through Zakeke's CSV import.
 *
 * This is an APPROXIMATION — it's the closest fit available, not a
 * pixel-verified placement, and should be spot-checked in Zakeke's visual
 * editor before relying on it for real orders.
 *
 * Usage:
 *   node scripts/zakeke-connect-products.js --only=B100   (pilot one product by its SanMar style code)
 *   node scripts/zakeke-connect-products.js --dry-run     (build everything, skip the actual submit)
 *   node scripts/zakeke-connect-products.js                (run all mapped products)
 */

const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const shopify = require('../src/shopify');
const zakeke = require('../src/zakeke');
const { getImageDimensions, scaleRect, renderMaskPng } = require('../src/mask-generator');

const CREATED_PRODUCTS_FILE = path.join(__dirname, '../data/processed/created_products.json');

// style code (last token of the SanMar title) -> template to copy geometry
// from. `template: 'self'` means: use this exact product's own existing
// Zakeke entry (already has a real, if rough, auto-generated print area).
// `template: null` means no reasonably-similar shape exists in the
// account; falls back to a manual, conservative centered rectangle.
// B100/B300's underlying Shopify products were deleted and recreated
// (new Shopify product ids), so their old Zakeke stub entries (still
// present in Zakeke, referencing the now-gone Shopify ids) are orphaned
// and irrelevant — 'self' no longer applies. Using the other tote
// template instead, same as any other non-self product.
const TEMPLATE_MAP = {
  B100: { template: 10060900, side: null }, // Medium Cotton Canvas Tote Bag
  B300: { template: 10060900, side: null },
  BTU: { template: 606600, side: null }, // SnapBack Hats
  JP56: { template: 10060883, side: null }, // Carhartt jacket
  '18000B': { template: 10060839, side: null }, // Gildan Heavy Blend Fleece Sweatshirt
  // B300: { template: 'self', side: null },
  // SP10 was the one hand-configured product, but its "Customize" button
  // wasn't picking up the selected color (separate JS bug, fixed in
  // assets/custom.js) — rebuilding it the same automated way as the rest
  // for consistency, once the old entry is deleted in Zakeke. LSP10 (same
  // shirt family, already rebuilt via this pipeline) stands in as its
  // template — Zakeke's own internal productId for it, not a Shopify id.
  SP10: { template: 10093232, side: null },
  LSP10: { template: 10093212, side: null }, // SP10 itself — same shirt family
  '18200': { template: null, side: null }, // sweatpants — no template in account
  '2200': { template: 10008385, side: null }, // Gildan Heavy Cotton Tee
  L469: { template: 10008535, side: null }, // Port & Co Core Blend Jersey Polo
  DT600: { template: 606601, side: null }, // Trucker Hats
  F243: { template: 10060876, side: null }, // Jerzees NuBlend Fleece Sweatshirt
  F219: { template: 10060839, side: null }, // fleece vest -> fleece sweatshirt chest area
  LSP11: { template: 10093212, side: null },
  F280: { template: 10060839, side: null },
  '2000L': { template: 10008385, side: null },
  L475: { template: 10008535, side: null },
  STC10: { template: 606600, side: null },
  JST72: { template: 10060883, side: null }, // wind shirt -> jacket
  F226: { template: 10060839, side: null },
};

const FALLBACK_RECT_FRACTION = { fx: -0.2, fy: -0.15, fw: 0.4, fh: 0.45 }; // centered-ish, conservative

function styleCodeFromTitle(title) {
  const tokens = title.trim().split(/\s+/);
  return tokens[tokens.length - 1];
}

function csvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

async function zipCsvFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }
    archive.finalize();
  });
}

/** Pulls { fx, fy, fw, fh } (fractions of the source image's own size) plus ppcm from a template. */
async function resolveTemplateGeometry(templateSpec, zakekeProducts, selfProductCode) {
  if (templateSpec.template === null) {
    return { ...FALLBACK_RECT_FRACTION, ppcmPerPxWidth: 0.025 }; // arbitrary modest default scale
  }

  const zProduct =
    templateSpec.template === 'self'
      ? zakekeProducts.find((p) => p.code === String(selfProductCode))
      : zakekeProducts.find((p) => p.productId === templateSpec.template);

  if (!zProduct) {
    throw new Error(`Template product not found in Zakeke catalog (spec: ${JSON.stringify(templateSpec)})`);
  }

  const variant = zProduct.variants[0];
  const side = templateSpec.side
    ? variant.sides.find((s) => s.name === templateSpec.side) || variant.sides[0]
    : variant.sides[0];
  const area = side.areas[0];

  const templateImageSize = await getImageDimensions(side.imageUrl);

  return {
    fx: area.boundsX / templateImageSize.width,
    fy: area.boundsY / templateImageSize.height,
    fw: area.boundsWidth / templateImageSize.width,
    fh: area.boundsHeight / templateImageSize.height,
    ppcmPerPxWidth: side.ppcm / templateImageSize.width,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;

  const createdMap = JSON.parse(fs.readFileSync(CREATED_PRODUCTS_FILE, 'utf8'));
  const shopifyClient = await shopify.getClient();
  const zakekeClient = await zakeke.getClient();

  console.log('Fetching current Zakeke catalog (for template geometry)...');
  const zakekeProducts = await zakeke.getProducts(zakekeClient);
  console.log(`  ${zakekeProducts.length} products currently in Zakeke\n`);

  const productRows = [];
  const sideRows = [];
  const areaRows = [];

  for (const [title, productId] of Object.entries(createdMap)) {
    const styleCode = styleCodeFromTitle(title);
    if (only && only !== styleCode) continue;

    const templateSpec = TEMPLATE_MAP[styleCode];
    if (!templateSpec) {
      console.log(`  SKIP (already configured or no mapping) — ${title} [${styleCode}]`);
      continue;
    }

    console.log(`Processing ${title} [${styleCode}] (Shopify product ${productId})...`);
    const geometry = await resolveTemplateGeometry(templateSpec, zakekeProducts, productId);

    const res = await shopifyClient.get(`/products/${productId}.json`, {
      params: { fields: 'id,title,images,variants' },
    });
    const product = res.data.product;
    const imageById = new Map(product.images.map((img) => [img.id, img]));

    const seenColors = new Set();
    for (const variant of product.variants) {
      const color = variant.option1;
      if (seenColors.has(color)) continue; // one row per color, not per size
      seenColors.add(color);

      const image = imageById.get(variant.image_id);
      if (!image) {
        console.log(`    no linked image for color "${color}" — skipping this color`);
        continue;
      }

      const rect = {
        boundsX: geometry.fx * image.width,
        boundsY: geometry.fy * image.height,
        boundsWidth: geometry.fw * image.width,
        boundsHeight: geometry.fh * image.height,
      };
      const ppcm = geometry.ppcmPerPxWidth * image.width;

      let maskUrl = '(dry-run, not generated)';
      if (!dryRun) {
        const maskBuffer = renderMaskPng({ width: image.width, height: image.height }, rect);
        maskUrl = await shopify.uploadImageAsset(shopifyClient, maskBuffer, `zakeke-mask-${productId}-${color}.png`);
      }

      const colorSlug = color.replace(/\s+/g, '-');
      const masterId = String(productId);
      const variantName = color;

      productRows.push({
        MasterProductID: masterId,
        ProductID: `${masterId}-${colorSlug}`,
        ProductName: title,
        ImageLink: image.src,
        VariantName: variantName,
        VariantNameLocale: '',
        Attributes: `color=${color}`,
      });
      sideRows.push({
        MasterProductID: masterId,
        VariantName: variantName,
        SideName: 'Front',
        SideNameLocale: '',
        SideCode: '',
        UrlImageSide: image.src,
        PPCM: ppcm.toFixed(4),
      });
      areaRows.push({
        MasterProductID: masterId,
        VariantName: variantName,
        SideName: 'Front',
        AreaName: '',
        UrlAreaMask: maskUrl,
        ClipOut: 'true',
      });

      console.log(`    ${color}: rect ${JSON.stringify(rect)}, ppcm ${ppcm.toFixed(2)}, mask ${maskUrl}`);
      if (!dryRun) await shopify.sleep(350); // Shopify REST rate limit — one image-upload write per color
    }
  }

  console.log(`\nBuilt ${productRows.length} color rows across ${new Set(productRows.map((r) => r.MasterProductID)).size} products.`);

  if (dryRun) {
    console.log('Dry run — not submitting to Zakeke.');
    return;
  }
  if (productRows.length === 0) {
    console.log('Nothing to submit.');
    return;
  }

  const zipBuffer = await zipCsvFiles({
    'products.txt': buildCsv(
      ['MasterProductID', 'ProductID', 'ProductName', 'ImageLink', 'VariantName', 'VariantNameLocale', 'Attributes'],
      productRows
    ),
    'sides.txt': buildCsv(
      ['MasterProductID', 'VariantName', 'SideName', 'SideNameLocale', 'SideCode', 'UrlImageSide', 'PPCM'],
      sideRows
    ),
    'areas.txt': buildCsv(
      ['MasterProductID', 'VariantName', 'SideName', 'AreaName', 'UrlAreaMask', 'ClipOut'],
      areaRows
    ),
  });

  console.log('\nSubmitting CSV import to Zakeke...');
  const { taskID, lastError } = await zakeke.submitCsvImport(zakekeClient, zipBuffer);
  if (lastError) {
    console.error('Submit error:', lastError);
    process.exit(1);
  }
  console.log(`  TaskID: ${taskID} — polling for result...`);

  const result = await zakeke.pollCsvImportResult(zakekeClient, taskID);
  console.log('\nImport result:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Zakeke connect error:', err.response ? JSON.stringify(err.response.data) : err.stack || err.message);
  process.exit(1);
});

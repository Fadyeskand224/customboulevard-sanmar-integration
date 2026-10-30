'use strict';

/**
 * Connects the 97 products from import-priced-batch.js to Zakeke's Visual
 * Product Customizer, the same way scripts/zakeke-connect-products.js did
 * for the original 20 — copying print-area geometry (as a fraction of the
 * reference image's own width/height) from an already-configured Zakeke
 * product of a matching garment shape, then submitting a CSV import.
 *
 * Unlike the original script, the template isn't hand-picked per style —
 * each product's real SanMar title is classified by its actual garment
 * construction (tee / long sleeve / tank / polo / jersey / hoodie /
 * crewneck / two shapes of cap / visor / beanie), and each bucket maps to
 * the best-shaped real template already in the Zakeke catalog. A plain
 * "Hats" or "Unisex shirt" category label isn't trustworthy for this —
 * e.g. several "Active wear shirt"/"Long sleeve shirt" codes are the same
 * actual long-sleeve-tee shape and need the long-sleeve template, not the
 * generic tee one; "Sleeveless ... Tee" is a tank in shape even though its
 * name says "Tee". Two shapes (visor, beanie) have no existing Zakeke
 * product even roughly that shape, so they get a small hand-set area
 * instead of inheriting a torso-sized rectangle from an unrelated garment.
 *
 * Usage:
 *   node scripts/zakeke-connect-priced-batch.js --dry-run
 *   node scripts/zakeke-connect-priced-batch.js [--only=STYLE,STYLE]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ZipArchive } = require('archiver');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const shopify = require('../src/shopify');
const zakeke = require('../src/zakeke');
const { renderMaskPng, fetchAndResizeImage } = require('../src/mask-generator');

const GRAPHQL_VERSION = '2025-07';

async function shopifyGraphql(client, query, variables) {
  const res = await axios.post(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${GRAPHQL_VERSION}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': client.defaults.headers['X-Shopify-Access-Token'] }, timeout: 60000 }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

/** Every variant's color and linked image (id/src/width/height), paginated. */
async function fetchVariantsWithImages(client, productId) {
  const out = [];
  let after = null;
  for (;;) {
    const data = await shopifyGraphql(
      client,
      `query($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              selectedOptions { name value }
              image { id src: url width height }
            }
          }
        }
      }`,
      { id: `gid://shopify/Product/${productId}`, after }
    );
    const v = data.product.variants;
    for (const n of v.nodes) {
      out.push({ color: n.selectedOptions.find((o) => o.name === 'Color').value, image: n.image });
    }
    if (!v.pageInfo.hasNextPage) break;
    after = v.pageInfo.endCursor;
  }
  return out;
}

const BATCH_FILE = path.join(__dirname, '../data/processed/created-priced-batch.json');

/** Retries a flaky single call (network timeout, transient 5xx) a few times with backoff. */
async function withRetry(fn, { attempts = 4, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await shopify.sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

// Resolved geometry (fraction of a reference image's own width/height),
// extracted once from 9 already-configured Zakeke products with matching
// real garment shapes (see conversation history for which product each
// shape was pulled from: plain crew tee, long sleeve, 2200's own tank
// shape, polo, jersey, pullover hoodie, crewneck fleece, and both cap
// styles). Hardcoded rather than looked up live on every run so these 9
// legacy products — several carrying real storefront photos that count
// against Zakeke's storage cap — can be trimmed or dropped without
// silently breaking this script's geometry resolution.
const SHAPE_GEOMETRY = {
  TEE: { fx: -0.2578400025748503, fy: -0.3484211600008175, fw: 0.50024048, fh: 0.6336526877133105, ppcmPerPxWidth: 0.012361382196746477 },
  LONG_SLEEVE: { fx: -0.19608191838323355, fy: -0.3497385256790174, fw: 0.41686706808383234, fh: 0.6138922129334149, ppcmPerPxWidth: 0.011359647575337271 },
  TANK: { fx: -0.25806451612903225, fy: -0.3486328125, fw: 0.501466275659824, fh: 0.6337890625, ppcmPerPxWidth: 0.012361416666666666 },
  POLO: { fx: 0.04323066161676644, fy: -0.345786436052809, fw: 0.17601053598802394, fh: 0.14359281791798495, ppcmPerPxWidth: 0.0115496922907883 },
  JERSEY: { fx: 0.05125448028673852, fy: -0.28450617818707064, fw: 0.189247311827957, fh: 0.16690561529271214, ppcmPerPxWidth: 0.012863148037762923 },
  HOODIE: { fx: -0.2424004790419162, fy: -0.3892594863982971, fw: 0.4956086227544911, fh: 0.46239520958083824, ppcmPerPxWidth: 0.013618910021493225 },
  CREWNECK: { fx: -0.23655913978494617, fy: -0.2805635258573216, fw: 0.48626045400238954, fh: 0.6045400238948628, ppcmPerPxWidth: 0.01608746004268293 },
  CAP_SNAPBACK: { fx: -0.22061567164178475, fy: -0.2134328358208955, fw: 0.4535447761193967, fh: 0.3529850746268656, ppcmPerPxWidth: 0.024180302882822045 },
  CAP_TRUCKER: { fx: -0.2267723880597015, fy: -0.20932835820895523, fw: 0.46585820895522395, fh: 0.31604477611940296, ppcmPerPxWidth: 0.022783548173779818 },
};

// No existing Zakeke product is this shape, so these get a direct,
// hand-set area (fraction of the photo's own width/height, same
// coordinate convention as a resolved template) instead of a template
// lookup. Sized for where these actually carry a logo: a visor's small
// embroidered patch on the brim's front-center; a beanie's patch on the
// folded cuff, low and centered. Both far smaller than any torso garment's
// print area — using the tee template's area here would place a
// chest-sized box over a hat with no chest.
const CUSTOM_SHAPE = {
  VISOR: { fx: -0.12, fy: -0.04, fw: 0.24, fh: 0.12, ppcmPerPxWidth: 0.02 },
  BEANIE: { fx: -0.1, fy: 0.05, fw: 0.2, fh: 0.12, ppcmPerPxWidth: 0.02 },
};

function classify(title) {
  const t = title.toLowerCase();
  if (/visor/.test(t)) return 'VISOR';
  if (/watch cap|beanie/.test(t)) return 'BEANIE';
  if (/trucker|mesh back|unipanel|flexfit/.test(t)) return 'CAP_TRUCKER';
  if (/snapback|cap\b|camouflage/.test(t)) return 'CAP_SNAPBACK';
  // Narrow and specific on purpose: "jersey" alone is ambiguous — several
  // BELLA+CANVAS tees/tanks use it as a FABRIC name ("Jersey Short Sleeve
  // Tee", "Jersey Muscle Tank"), not a garment shape, and would wrongly
  // land here on a bare /jersey/ match (confirmed: it swallowed a tee, two
  // tanks, and even the polo — KP55's "Core Blend Jersey Knit Polo"). Only
  // Sport-Tek's Replica Jersey is an actual jersey-cut garment.
  if (/replica jersey/.test(t)) return 'JERSEY';
  if (/polo/.test(t)) return 'POLO';
  if (/long sleeve/.test(t)) return 'LONG_SLEEVE';
  if (/tank|sleeveless/.test(t)) return 'TANK';
  if (/hood/.test(t)) return 'HOODIE';
  if (/crew|sweatshirt|fleece|french terry/.test(t)) return 'CREWNECK';
  return 'TEE';
}

function csvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
function buildCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvField(row[h] ?? '')).join(','));
  return lines.join('\r\n');
}
async function zipCsvFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(files)) archive.append(content, { name });
    archive.finalize();
  });
}

/** { fx, fy, fw, fh, ppcmPerPxWidth } (fractions of the target image's own size) for a shape. */
function resolveGeometry(shape) {
  const geometry = CUSTOM_SHAPE[shape] || SHAPE_GEOMETRY[shape];
  if (!geometry) throw new Error(`No geometry defined for shape ${shape}`);
  return geometry;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;

  const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
  const shopifyClient = await shopify.getClient();
  const zakekeClient = await zakeke.getClient();

  console.log('Fetching current Zakeke catalog (for template geometry)...');
  const zakekeProducts = await zakeke.getProducts(zakekeClient);
  console.log(`  ${zakekeProducts.length} products currently in Zakeke\n`);

  const geometryCache = new Map(); // shape -> resolved geometry (one lookup per shape, not per product)

  const productRows = [];
  const sideRows = [];
  const areaRows = [];
  const shapeCounts = {};

  for (const [style, info] of Object.entries(batch)) {
    if (only && !only.has(style)) continue;
    if (info.status !== 'created' && info.status !== 'skipped-existing') { console.log(`SKIP ${style}: not a completed product (status ${info.status})`); continue; }

    const shape = classify(info.title);
    shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
    if (!geometryCache.has(shape)) geometryCache.set(shape, resolveGeometry(shape));
    const geometry = geometryCache.get(shape);

    console.log(`Processing ${style} [${shape}]: "${info.title}" (Shopify product ${info.id})...`);

    // Each variant's linked image, via GraphQL rather than REST's
    // `variant.image_id` — that REST field was found unreliable for
    // variants created through productVariantsBulkCreate (as this whole
    // batch was): it reads correctly right after creation, then goes null
    // later even though the real link (checked here, and what the theme
    // actually renders) stays intact the whole time. Also sidesteps REST's
    // separate 100-variant-per-product embed cap for the wide-color styles.
    const variants = await fetchVariantsWithImages(shopifyClient, info.id);

    const seenColors = new Set();
    for (const variant of variants) {
      const color = variant.color;
      if (seenColors.has(color)) continue; // one row per color, not per size
      seenColors.add(color);

      const image = variant.image;
      if (!image) { console.log(`    no linked image for color "${color}" — skipping this color`); continue; }

      let maskUrl = '(dry-run, not generated)';
      let zakekeImageUrl = image.src;
      let zakekeImageSize = { width: image.width, height: image.height };
      if (!dryRun) {
        // Zakeke bills by storage, and SanMar's source photos run
        // 1200x1800+ — re-encoded at a smaller size before anything gets
        // submitted, both the reference photo itself and the mask built to
        // match it, rather than handing Zakeke the full-resolution original
        // for every color of every product.
        const resized = await withRetry(() => fetchAndResizeImage(image.src));
        zakekeImageSize = { width: resized.width, height: resized.height };
        zakekeImageUrl = await withRetry(() => shopify.uploadImageAsset(shopifyClient, resized.buffer, `zakeke-photo-${info.id}-${color}.jpg`));
      }

      const rect = {
        boundsX: geometry.fx * zakekeImageSize.width,
        boundsY: geometry.fy * zakekeImageSize.height,
        boundsWidth: geometry.fw * zakekeImageSize.width,
        boundsHeight: geometry.fh * zakekeImageSize.height,
      };
      const ppcm = geometry.ppcmPerPxWidth * zakekeImageSize.width;

      if (!dryRun) {
        const maskBuffer = renderMaskPng(zakekeImageSize, rect);
        // ~1,850 of these calls happen in one run; a lone transient network
        // timeout shouldn't take the whole thing down (confirmed in
        // practice: one did, 30 products in).
        maskUrl = await withRetry(() => shopify.uploadImageAsset(shopifyClient, maskBuffer, `zakeke-mask-${info.id}-${color}.png`));
      }

      const colorSlug = color.replace(/\s+/g, '-');
      const masterId = String(info.id);

      productRows.push({
        MasterProductID: masterId,
        ProductID: `${masterId}-${colorSlug}`,
        ProductName: info.title,
        ImageLink: zakekeImageUrl,
        VariantName: color,
        VariantNameLocale: '',
        Attributes: `color=${color}`,
      });
      sideRows.push({
        MasterProductID: masterId,
        VariantName: color,
        SideName: 'Front',
        SideNameLocale: '',
        SideCode: '',
        UrlImageSide: zakekeImageUrl,
        PPCM: ppcm.toFixed(4),
      });
      areaRows.push({
        MasterProductID: masterId,
        VariantName: color,
        SideName: 'Front',
        AreaName: '',
        UrlAreaMask: maskUrl,
        ClipOut: 'true',
      });

      if (!dryRun) await shopify.sleep(350); // Shopify REST rate limit — one image-upload write per color
    }
    console.log(`  ${seenColors.size} colors queued`);
  }

  console.log(`\nShape distribution: ${JSON.stringify(shapeCounts)}`);
  console.log(`Built ${productRows.length} color rows across ${new Set(productRows.map((r) => r.MasterProductID)).size} products.`);

  if (dryRun) { console.log('Dry run — not submitting to Zakeke.'); return; }
  if (productRows.length === 0) { console.log('Nothing to submit.'); return; }

  const zipBuffer = await zipCsvFiles({
    'products.txt': buildCsv(['MasterProductID', 'ProductID', 'ProductName', 'ImageLink', 'VariantName', 'VariantNameLocale', 'Attributes'], productRows),
    'sides.txt': buildCsv(['MasterProductID', 'VariantName', 'SideName', 'SideNameLocale', 'SideCode', 'UrlImageSide', 'PPCM'], sideRows),
    'areas.txt': buildCsv(['MasterProductID', 'VariantName', 'SideName', 'AreaName', 'UrlAreaMask', 'ClipOut'], areaRows),
  });

  console.log('\nSubmitting CSV import to Zakeke...');
  const { taskID, lastError } = await zakeke.submitCsvImport(zakekeClient, zipBuffer);
  if (lastError) { console.error('Submit error:', lastError); process.exit(1); }
  console.log(`  TaskID: ${taskID} — polling for result...`);

  const result = await zakeke.pollCsvImportResult(zakekeClient, taskID);
  console.log('\nImport result:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Zakeke connect error:', err.response ? JSON.stringify(err.response.data) : err.stack || err.message);
  process.exit(1);
});

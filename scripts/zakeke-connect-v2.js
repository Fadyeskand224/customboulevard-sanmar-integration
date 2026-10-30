'use strict';

/**
 * Connects SanMar products to Zakeke's Visual Product Customizer with a
 * FRONT and a BACK view (plus the print areas that make sense for each
 * garment), following Zakeke's CSV-import rules
 * (https://docs.zakeke.com/docs/API/Integration/Connecting-Product/CSV-method):
 *
 *   - one sides row per side per color, one areas row per area per side
 *   - each area is a PNG mask the same pixel size as its side photo, solid
 *     black print shape on a transparent background with a transparent border
 *   - PPCM (pixels per cm) is required whenever areas are included
 *   - re-importing a MasterProductID updates that product (no duplicate)
 *
 * Keeping Zakeke's storage small (it bills by GB):
 *   - photos are NOT re-uploaded: Zakeke is pointed at the product's existing
 *     SanMar photo on Shopify's CDN, resized on the fly to 720px wide JPEG
 *     (~55 KB each; the CDN never upscales)
 *   - masks are tiny PNGs (a few KB), generated once per photo size/area and
 *     shared by every color and product with that size
 *   - only colors that exist on the Shopify product are sent
 *
 * Usage:
 *   node scripts/zakeke-connect-v2.js --dry-run [--which batch|originals|all] [--only ST535,PC54]
 *   node scripts/zakeke-connect-v2.js --only ST535
 *   node scripts/zakeke-connect-v2.js --which originals --chunk 6
 *
 * Progress is recorded in data/processed/zakeke-v2-state.json so an
 * interrupted run resumes where it stopped (use --force to redo products).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ZipArchive } = require('archiver');
const { createCanvas } = require('canvas');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const shopify = require('../src/shopify');
const zakeke = require('../src/zakeke');

const GRAPHQL_VERSION = '2025-07';
const PHOTO_WIDTH = 720; // px; Shopify's CDN never upscales
const BYTES_PER_PIXEL = 0.07; // measured: a 720x1080 SanMar JPEG is ~55 KB
const STATE_FILE = path.join(__dirname, '../data/processed/zakeke-v2-state.json');
const MASK_CACHE_FILE = path.join(__dirname, '../data/processed/zakeke-mask-cache.json');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

/* ---------- Garment geometry ----------
 * Print areas as fractions of the photo [x, y, width, height], calibrated on
 * SanMar's photos (1200x1800 portrait model shots for apparel; the caps'
 * 3/4 product shots). Left/Right follow the print-shop convention: the
 * WEARER's left/right, so "Left Chest" is on the viewer's right.
 * A single large Front area is used for plain tees/sweatshirts/hoodies/tanks:
 * a design can sit anywhere inside it, including either chest pocket spot, or
 * fill the shirt. Garments with a zip/placket down the middle (polos, jackets,
 * vests, quarter-zips, button shirts) get separate chest areas.
 */
const A = (name, x, y, w, h) => ({ name, x, y, w, h });
const LEFT_CHEST = (y = 0.33, w = 0.13, h = 0.09) => A('Left Chest', 0.53, y, w, h);
const RIGHT_CHEST = (y = 0.33, w = 0.13, h = 0.09) => A('Right Chest', 0.34, y, w, h);

const SHAPES = {
  TEE: { front: [A('Front', 0.30, 0.30, 0.40, 0.42)], back: [A('Back', 0.30, 0.27, 0.40, 0.45)], ppcmPerPx: 0.012361 },
  LONG_SLEEVE: { front: [A('Front', 0.30, 0.30, 0.40, 0.42)], back: [A('Back', 0.30, 0.27, 0.40, 0.45)], ppcmPerPx: 0.011360 },
  CREWNECK: { front: [A('Front', 0.30, 0.32, 0.40, 0.38)], back: [A('Back', 0.30, 0.27, 0.40, 0.45)], ppcmPerPx: 0.016087 },
  HOODIE: { front: [A('Front', 0.31, 0.32, 0.38, 0.34)], back: [A('Back', 0.30, 0.30, 0.40, 0.42)], ppcmPerPx: 0.013619 },
  TANK: { front: [A('Front', 0.33, 0.33, 0.34, 0.38)], back: [A('Back', 0.33, 0.27, 0.34, 0.43)], ppcmPerPx: 0.012361 },
  POLO: {
    front: [LEFT_CHEST(0.33, 0.15, 0.09), A('Right Chest', 0.32, 0.33, 0.15, 0.09), A('Lower Front', 0.30, 0.43, 0.40, 0.29)],
    back: [A('Back', 0.30, 0.27, 0.40, 0.43)],
    ppcmPerPx: 0.011550,
  },
  JERSEY: { front: [A('Front', 0.31, 0.34, 0.38, 0.36)], back: [A('Back', 0.30, 0.27, 0.40, 0.45)], ppcmPerPx: 0.012863 },
  JACKET: { front: [LEFT_CHEST(), RIGHT_CHEST()], back: [A('Back', 0.30, 0.27, 0.40, 0.38)], ppcmPerPx: 0.012361 },
  VEST: { front: [A('Left Chest', 0.53, 0.34, 0.12, 0.08), A('Right Chest', 0.35, 0.34, 0.12, 0.08)], back: [A('Back', 0.32, 0.27, 0.36, 0.36)], ppcmPerPx: 0.012361 },
  QUARTER_ZIP: { front: [A('Left Chest', 0.53, 0.35, 0.12, 0.08), A('Right Chest', 0.35, 0.35, 0.12, 0.08)], back: [A('Back', 0.30, 0.27, 0.40, 0.42)], ppcmPerPx: 0.012361 },
  BUTTON_SHIRT: { front: [A('Left Chest', 0.53, 0.33, 0.12, 0.08), A('Right Chest', 0.35, 0.33, 0.12, 0.08)], back: [A('Back', 0.30, 0.28, 0.40, 0.38)], ppcmPerPx: 0.012361 },
  PANTS: { front: [A('Left Leg', 0.51, 0.20, 0.11, 0.12), A('Right Leg', 0.37, 0.20, 0.11, 0.12)], back: [A('Back Leg', 0.37, 0.20, 0.11, 0.12)], ppcmPerPx: 0.012361 },
  CAP_SNAPBACK: { front: [A('Front', 0.33, 0.16, 0.30, 0.14)], back: [A('Back', 0.28, 0.14, 0.34, 0.15)], ppcmPerPx: 0.024180 },
  CAP_TRUCKER: { front: [A('Front', 0.33, 0.16, 0.30, 0.14)], back: [A('Back', 0.28, 0.14, 0.34, 0.15)], ppcmPerPx: 0.022784 },
  VISOR: { front: [A('Front', 0.30, 0.21, 0.30, 0.06)], back: null, ppcmPerPx: 0.02 },
  BEANIE: { front: [A('Cuff', 0.36, 0.36, 0.28, 0.10)], back: null, ppcmPerPx: 0.02 },
};

// Products photographed differently from SanMar's usual framing
const STYLE_OVERRIDES = {
  C855: { front: [A('Front', 0.35, 0.22, 0.30, 0.22)], back: [A('Back', 0.30, 0.15, 0.35, 0.28)] }, // landscape camo cap photos
  BTU: { front: [A('Front', 0.32, 0.20, 0.36, 0.30)], back: [A('Back', 0.28, 0.30, 0.30, 0.20)] }, // landscape 3/4 cap shots
};

function classify(title) {
  const t = (title || '').toLowerCase();
  if (/visor/.test(t)) return 'VISOR';
  if (/watch cap|beanie|knit cap/.test(t)) return 'BEANIE';
  if (/trucker|mesh back|unipanel|flexfit/.test(t)) return 'CAP_TRUCKER';
  if (/snapback|\bcap\b|\bhats?\b|camouflage/.test(t)) return 'CAP_SNAPBACK';
  if (/sweatpant|jogger|\bpants?\b|\bshorts\b/.test(t)) return 'PANTS';
  if (/\bvest\b/.test(t)) return 'VEST';
  if (/1\/4[- ]zip|quarter[- ]zip|1\/2[- ]zip/.test(t)) return 'QUARTER_ZIP';
  if (/jacket|soft shell|parka|anorak|windbreaker|\bcoat\b/.test(t)) return 'JACKET';
  if (/full[- ]button|denim shirt|button[- ]down|woven|oxford|dress shirt|camp shirt/.test(t)) return 'BUTTON_SHIRT';
  if (/replica jersey/.test(t)) return 'JERSEY';
  if (/polo/.test(t)) return 'POLO';
  if (/long sleeve|wind shirt/.test(t)) return 'LONG_SLEEVE';
  if (/tank|sleeveless/.test(t)) return 'TANK';
  if (/hood/.test(t)) return 'HOODIE';
  if (/crew|sweatshirt|fleece|french terry/.test(t)) return 'CREWNECK';
  return 'TEE';
}

const styleOf = (title) => (title.trim().match(/([A-Z0-9][A-Z0-9-]+)\s*$/) || [])[1] || '';

/* ---------- Shopify ---------- */

let tokenCache = null;
async function gql(query, variables) {
  tokenCache = tokenCache || (await shopify.getAccessToken());
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(
        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${GRAPHQL_VERSION}/graphql.json`,
        { query, variables },
        { headers: { 'X-Shopify-Access-Token': tokenCache }, timeout: 60000 },
      );
      if (res.data.errors) {
        const throttled = res.data.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled && attempt < 5) { await shopify.sleep(2000 * attempt); continue; }
        throw new Error(JSON.stringify(res.data.errors).slice(0, 400));
      }
      return res.data.data;
    } catch (err) {
      if (attempt === 5) throw err;
      await shopify.sleep(1500 * attempt);
    }
  }
  return null;
}

async function listProducts(which) {
  const out = [];
  let after = null;
  for (;;) {
    const data = await gql(`query($after: String) {
      products(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id title handle status tags }
      }
    }`, { after });
    for (const p of data.products.nodes) {
      const batch = p.tags.includes('priced-batch-2026-10');
      const original = p.tags.includes('sanmar') && !batch && p.status === 'ACTIVE';
      if ((which === 'batch' && batch) || (which === 'originals' && original) || (which === 'all' && (batch || original))) {
        out.push({ id: p.id.split('/').pop(), title: p.title, handle: p.handle, status: p.status, tags: p.tags });
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return out;
}

async function loadProductImages(productId) {
  const gid = `gid://shopify/Product/${productId}`;
  const media = [];
  const mdata = await gql(`query($id: ID!) { product(id: $id) { media(first: 250) { nodes { alt ... on MediaImage { image { url width height } } } } } }`, { id: gid });
  for (const m of mdata.product.media.nodes) {
    if (m.image) media.push({ alt: m.alt || '', url: m.image.url, width: m.image.width, height: m.image.height });
  }
  const variants = [];
  let after = null;
  for (;;) {
    const v = await gql(`query($id: ID!, $after: String) {
      product(id: $id) { variants(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { selectedOptions { name value } image { url width height } }
      } }
    }`, { id: gid, after });
    for (const n of v.product.variants.nodes) {
      const color = (n.selectedOptions.find((o) => /colou?r/i.test(o.name)) || {}).value;
      variants.push({ color, image: n.image });
    }
    if (!v.product.variants.pageInfo.hasNextPage) break;
    after = v.product.variants.pageInfo.endCursor;
  }
  return { media, variants };
}

/* ---------- Photos ---------- */

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stemOf = (url) => url.split('?')[0].split('/').pop().replace(/\.(jpe?g|png|webp)$/i, '').replace(/_[0-9a-f]{8}-[0-9a-f-]{27,}$/i, '').toLowerCase();

/** Back photo for a color: "Back - <Color>" alt text, else the front photo's filename with front/left -> back. */
function findBack(color, frontImage, media) {
  const want = norm(`Back - ${color}`);
  const byAlt = media.find((m) => norm(m.alt) === want);
  if (byAlt) return byAlt;
  if (!frontImage) return null;
  const stem = stemOf(frontImage.url);
  const targets = [stem.replace(/front/g, 'back'), stem.replace(/_left$/, '_back')].filter((t) => t !== stem);
  return media.find((m) => targets.includes(stemOf(m.url))) || null;
}

/** Zakeke's copy: the CDN's 720px-wide JPEG. Returns { url, width, height } (height predicted, verified). */
function zakekePhoto(img) {
  const width = Math.min(PHOTO_WIDTH, img.width);
  const height = Math.round((img.height * width) / img.width);
  const sep = img.url.includes('?') ? '&' : '?';
  return { url: `${img.url}${sep}width=${width}&format=jpg`, width, height };
}

/* ---------- Masks ---------- */

const maskCache = fs.existsSync(MASK_CACHE_FILE) ? JSON.parse(fs.readFileSync(MASK_CACHE_FILE, 'utf8')) : {};
function saveMaskCache() { fs.writeFileSync(MASK_CACHE_FILE, JSON.stringify(maskCache, null, 1)); }

// Zakeke: print areas are solid black, everything else transparent, with a transparent border
function renderMask(width, height, area) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  const x = Math.max(2, Math.round(area.x * width));
  const y = Math.max(2, Math.round(area.y * height));
  const w = Math.min(Math.round(area.w * width), width - x - 2);
  const h = Math.min(Math.round(area.h * height), height - y - 2);
  ctx.fillRect(x, y, w, h);
  return canvas.toBuffer('image/png');
}

async function maskUrl(client, width, height, area, key) {
  const cacheKey = `${width}x${height}|${key}|${area.name}|${area.x},${area.y},${area.w},${area.h}`;
  if (maskCache[cacheKey]) return maskCache[cacheKey];
  if (DRY_RUN) return '(dry-run mask)';
  const buf = renderMask(width, height, area);
  const file = `zk-mask-${width}x${height}-${norm(key)}-${norm(area.name)}-${Math.round(area.x * 1000)}${Math.round(area.y * 1000)}.png`;
  let url;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { url = await shopify.uploadImageAsset(client, buf, file); break; } catch (e) { if (attempt === 4) throw e; await shopify.sleep(2000 * attempt); }
  }
  maskCache[cacheKey] = url;
  saveMaskCache();
  await shopify.sleep(350);
  return url;
}

/* ---------- CSV / zip ---------- */

const csvField = (v) => `"${String(v).replace(/"/g, '""')}"`;
function buildCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvField(r[h] ?? '')).join(','))].join('\r\n');
}
function zipFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(files)) archive.append(content, { name });
    archive.finalize();
  });
}

/* ---------- Per product ---------- */

async function buildProduct(client, product) {
  const style = styleOf(product.title);
  const shapeKey = classify(product.title);
  const shape = SHAPES[shapeKey];
  const override = STYLE_OVERRIDES[style] || {};
  const frontAreas = override.front || shape.front;
  const backAreas = override.back !== undefined ? override.back : shape.back;

  const { media, variants } = await loadProductImages(product.id);
  const rows = { products: [], sides: [], areas: [] };
  const stats = { colors: 0, withBack: 0, noFront: 0, photos: 0, pixels: 0 };
  const master = String(product.id);
  const seen = new Set();

  for (const v of variants) {
    const color = v.color;
    if (!color || seen.has(color)) continue;
    seen.add(color);
    if (!v.image) { stats.noFront++; continue; }

    const front = zekePhotoOrNull(v.image);
    const backSrc = backAreas ? findBack(color, v.image, media) : null;
    const back = backSrc ? zekePhotoOrNull(backSrc) : null;

    stats.colors++;
    stats.photos += back ? 2 : 1;
    stats.pixels += front.width * front.height + (back ? back.width * back.height : 0);
    if (back) stats.withBack++;

    rows.products.push({
      MasterProductID: master,
      ProductID: `${master}-${color.replace(/\s+/g, '-')}`,
      ProductName: product.title,
      ImageLink: front.url,
      VariantName: color,
      VariantNameLocale: '',
      Attributes: `color=${color}`,
    });

    const sides = [['Front', front, frontAreas]];
    if (back) sides.push(['Back', back, backAreas]);
    for (const [sideName, photo, areas] of sides) {
      rows.sides.push({
        MasterProductID: master,
        VariantName: color,
        SideName: sideName,
        SideNameLocale: '',
        SideCode: '',
        UrlImageSide: photo.url,
        PPCM: (shape.ppcmPerPx * photo.width).toFixed(4),
      });
      for (const area of areas) {
        rows.areas.push({
          MasterProductID: master,
          VariantName: color,
          SideName: sideName,
          AreaName: area.name,
          UrlAreaMask: await maskUrl(client, photo.width, photo.height, area, `${shapeKey}-${style === 'BTU' ? 'BTU' : ''}-${sideName}`),
          ClipOut: 'true',
        });
      }
    }
  }
  return { rows, stats, shapeKey };
}

function zekePhotoOrNull(img) { return img ? zakekePhoto(img) : null; }

async function submit(zakekeClient, rows) {
  const zip = await zipFiles({
    'products.txt': buildCsv(['MasterProductID', 'ProductID', 'ProductName', 'ImageLink', 'VariantName', 'VariantNameLocale', 'Attributes'], rows.products),
    'sides.txt': buildCsv(['MasterProductID', 'VariantName', 'SideName', 'SideNameLocale', 'SideCode', 'UrlImageSide', 'PPCM'], rows.sides),
    'areas.txt': buildCsv(['MasterProductID', 'VariantName', 'SideName', 'AreaName', 'UrlAreaMask', 'ClipOut'], rows.areas),
  });
  const { taskID, lastError } = await zakeke.submitCsvImport(zakekeClient, zip);
  if (lastError) throw new Error(`Zakeke rejected the upload: ${JSON.stringify(lastError)}`);
  return zakeke.pollCsvImportResult(zakekeClient, taskID);
}

async function main() {
  const which = arg('which') || 'all';
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const chunkSize = parseInt(arg('chunk') || '6', 10);
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};

  const client = await shopify.getClient();
  let products = await listProducts(which);
  if (only) products = products.filter((p) => only.has(styleOf(p.title)) || only.has(p.id));
  if (!FORCE) products = products.filter((p) => state[p.id] !== 'done');
  console.log(`${products.length} product(s) to ${DRY_RUN ? 'plan' : 'connect'} (${which}${only ? `, only ${[...only].join(',')}` : ''})`);

  const zakekeClient = DRY_RUN ? null : await zakeke.getClient();
  const totals = { products: 0, colors: 0, photos: 0, pixels: 0, noBack: 0 };
  const batchRows = { products: [], sides: [], areas: [] };
  let batchProducts = [];

  const flush = async () => {
    if (!batchProducts.length) return;
    if (DRY_RUN) { batchProducts = []; return; }
    console.log(`  -> submitting ${batchProducts.length} product(s) / ${batchRows.products.length} colors to Zakeke...`);
    let result;
    try {
      // Network blips (timeouts/resets) are retried; the import is idempotent, so re-sending a chunk is safe
      for (let attempt = 1; ; attempt++) {
        try { result = await submit(zakekeClient, batchRows); break; } catch (e) {
          const transient = e.code && /ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENOTFOUND/.test(e.code);
          if (!transient || attempt >= 4) throw e;
          console.log(`  network hiccup (${e.code}), retrying (${attempt}/3)...`);
          await shopify.sleep(5000 * attempt);
        }
      }
    } catch (err) {
      console.error('  Zakeke import failed:', err.response ? JSON.stringify(err.response.data).slice(0, 400) : err.message);
      process.exitCode = 1;
      batchProducts = []; batchRows.products = []; batchRows.sides = []; batchRows.areas = [];
      return;
    }
    if (process.env.ZK_DEBUG) console.log('  raw result:', JSON.stringify(result).slice(0, 1500));
    const errors = result.errors || [];
    // Zakeke reports { productID, hasConfiguredArea } — trust only products it confirms, with print areas
    const confirmed = new Map((result.importedProducts || []).map((p) => [String(p.productID ?? p.productId), !!p.hasConfiguredArea]));
    const missing = batchProducts.filter((p) => !confirmed.has(p.id));
    const noAreas = batchProducts.filter((p) => confirmed.has(p.id) && !confirmed.get(p.id));
    console.log(`  Zakeke: ${confirmed.size} of ${batchProducts.length} product(s) confirmed, ${errors.length} error(s)${missing.length ? `, NOT confirmed: ${missing.map((p) => styleOf(p.title)).join(',')}` : ''}${noAreas.length ? `, NO AREAS: ${noAreas.map((p) => styleOf(p.title)).join(',')}` : ''}`);
    errors.slice(0, 8).forEach((e) => console.log(`    [${e.sourceFile} row ${e.row}] ${e.description}`));
    const failedAny = result.errorOccurred || errors.length > 0;
    const okProducts = batchProducts.filter((p) => confirmed.get(p.id) === true);
    for (const p of batchProducts) state[p.id] = okProducts.includes(p) && !failedAny ? 'done' : 'error';
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    if (okProducts.length !== batchProducts.length || failedAny) process.exitCode = 1;
    if (!failedAny) {
      for (const p of okProducts) {
        await gql('mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }', { id: `gid://shopify/Product/${p.id}`, tags: ['zakeke_connected'] });
      }
    }
    batchProducts = []; batchRows.products = []; batchRows.sides = []; batchRows.areas = [];
  };

  for (const product of products) {
    const { rows, stats, shapeKey } = await buildProduct(client, product);
    const sides = stats.withBack ? 'front+back' : 'front only';
    console.log(`${styleOf(product.title).padEnd(10)} ${shapeKey.padEnd(12)} ${String(stats.colors).padStart(3)} colors, ${sides.padEnd(10)} ${stats.noFront ? `(${stats.noFront} colors w/o photo) ` : ''}${stats.colors && stats.withBack < stats.colors && stats.withBack ? `(${stats.colors - stats.withBack} colors w/o back photo)` : ''}`);
    if (!stats.colors) continue;
    totals.products++; totals.colors += stats.colors; totals.photos += stats.photos; totals.pixels += stats.pixels;
    if (!stats.withBack && SHAPES[shapeKey].back) totals.noBack++;
    batchProducts.push(product);
    for (const k of ['products', 'sides', 'areas']) batchRows[k].push(...rows[k]);
    if (batchProducts.length >= chunkSize) await flush();
  }
  await flush();

  const mb = (totals.pixels * BYTES_PER_PIXEL) / 1e6;
  console.log(`\n${DRY_RUN ? 'PLAN' : 'DONE'}: ${totals.products} products, ${totals.colors} colors, ${totals.photos} photos`);
  console.log(`Estimated Zakeke storage for these photos: ~${mb.toFixed(0)} MB (${(mb / 1024).toFixed(2)} GB) + masks (a few KB each)`);
  if (totals.noBack) console.log(`${totals.noBack} product(s) have no back photo at SanMar and stay front-only`);
}

main().catch((err) => { console.error(err.response ? JSON.stringify(err.response.data).slice(0, 500) : err.stack || err.message); process.exit(1); });

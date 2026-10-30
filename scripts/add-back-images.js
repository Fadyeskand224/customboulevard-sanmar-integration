'use strict';

/**
 * Adds SanMar's back photo for every color of a product to its Shopify
 * media, so the custom designer (theme assets/custom-designer.js) can offer
 * a Back side. Each image's alt text is "Back - <Color>", which is how the
 * designer finds the back photo for the color being designed.
 *
 * The original import skipped these: EPDD's BACK_MODEL_IMAGE column is a bare
 * filename, living in the same CDN folder as FRONT_MODEL_IMAGE_URL — see
 * data/processed/sanmar-side-images.json ("STYLE|Color" -> URLs).
 *
 * Idempotent and resumable: skips colors that already have a "Back - <Color>"
 * image (or a *_back filename for that color), checks each SanMar URL exists
 * before asking Shopify to fetch it, and records progress per product.
 *
 * Usage:
 *   node scripts/add-back-images.js --dry-run            # print the plan only
 *   node scripts/add-back-images.js [--only ST535,PC54]  # do it
 *   Options: --prefer-flat (use flat back shots when SanMar has them, for
 *            products photographed flat), --products <id,id> (Shopify ids,
 *            for products outside the priced batch, paired with --styles)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getAccessToken, sleep } = require('../src/shopify');

const SIDE_IMAGES = path.join(__dirname, '../data/processed/sanmar-side-images.json');
const BATCH_FILE = path.join(__dirname, '../data/processed/created-priced-batch.json');
const PROGRESS_FILE = path.join(__dirname, '../data/processed/back-images-progress.json');
const ALIASES_FILE = path.join(__dirname, '../data/processed/color-aliases.json');
const API_VERSION = '2025-07';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const DRY_RUN = process.argv.includes('--dry-run');
const PREFER_FLAT = process.argv.includes('--prefer-flat');

async function gql(query, variables) {
  const token = await getAccessToken();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(
        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
        { query, variables },
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 45000 },
      );
      if (res.data.errors) {
        const throttled = res.data.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled && attempt < 5) { await sleep(2000 * attempt); continue; }
        throw new Error(JSON.stringify(res.data.errors).slice(0, 400));
      }
      return res.data.data;
    } catch (err) {
      if (attempt === 5 || (err.response && err.response.status < 500 && err.response.status !== 429)) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function urlExists(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.head(url, { maxRedirects: 0, validateStatus: () => true, timeout: 20000 });
      if (res.status === 200) return true;
      if (res.status === 301 || res.status === 302 || res.status === 404) return false; // SanMar redirects missing images
    } catch (e) { /* retry */ }
    await sleep(1500 * attempt);
  }
  return false;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function loadProduct(id) {
  const data = await gql(`query($id: ID!) {
    product(id: $id) {
      id title
      options { name values }
      media(first: 250) { nodes { alt ... on MediaImage { image { url } } } }
    }
  }`, { id: `gid://shopify/Product/${id}` });
  return data.product;
}

async function main() {
  const sides = JSON.parse(fs.readFileSync(SIDE_IMAGES, 'utf8'));
  const aliases = fs.existsSync(ALIASES_FILE) ? JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) : {};
  // Store color -> SanMar entry: exact, then case-insensitive, then data/processed/color-aliases.json
  const byLower = {};
  for (const k of Object.keys(sides)) byLower[k.toLowerCase()] = sides[k];
  const lookup = (style, color) => {
    const alias = (aliases[style] || {})[color];
    return sides[`${style}|${color}`] || byLower[`${style}|${color}`.toLowerCase()] || (alias && sides[`${style}|${alias}`]) || null;
  };
  const progress = fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) : {};

  // style -> Shopify product id
  let targets = [];
  if (arg('products')) {
    const ids = arg('products').split(',');
    const styles = (arg('styles') || '').split(',');
    if (ids.length !== styles.length) throw new Error('--products and --styles must pair up');
    targets = ids.map((id, i) => ({ style: styles[i], id }));
  } else {
    const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
    targets = Object.entries(batch).filter(([, v]) => v.status === 'created' || v.status === 'skipped-existing').map(([style, v]) => ({ style, id: String(v.id) }));
  }
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  if (only) targets = targets.filter((t) => only.has(t.style));

  let added = 0, skipped = 0, missing = 0;
  for (const t of targets) {
    if (progress[t.id] === 'done' && !DRY_RUN) { skipped++; continue; }
    const product = await loadProduct(t.id);
    if (!product) { console.log(`SKIP ${t.style}: product ${t.id} not found`); continue; }
    const colorOpt = product.options.find((o) => /colou?r/i.test(o.name));
    const colors = colorOpt ? colorOpt.values : [];
    const haveAlt = new Set(product.media.nodes.map((m) => norm(m.alt)));
    const haveFiles = product.media.nodes.map((m) => (m.image ? m.image.url.split('/').pop().split('?')[0].toLowerCase() : ''));

    const toAdd = [];
    for (const color of colors) {
      if (haveAlt.has(norm(`Back - ${color}`))) continue;
      const entry = lookup(t.style, color);
      if (!entry) { missing++; continue; }
      const candidates = PREFER_FLAT ? [entry.back_flat, entry.back_model] : [entry.back_model, entry.back_flat];
      let url = null;
      for (const c of candidates) {
        if (!c) continue;
        const file = c.split('/').pop().toLowerCase();
        if (haveFiles.some((f) => f.startsWith(file.replace(/\.(jpg|jpeg|png)$/, '')))) { url = 'present'; break; }
        if (await urlExists(c)) { url = c; break; }
        await sleep(250);
      }
      if (url === 'present') continue;
      if (!url) { missing++; continue; }
      toAdd.push({ color, url });
    }

    console.log(`${t.style} (${product.title.slice(0, 40)}): ${toAdd.length} back image(s) to add`);
    if (DRY_RUN) { toAdd.slice(0, 2).forEach((a) => console.log(`   ${a.color}: ${a.url}`)); continue; }

    for (let i = 0; i < toAdd.length; i += 10) {
      const chunk = toAdd.slice(i, i + 10);
      const data = await gql(`mutation($id: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $id, media: $media) { media { alt } mediaUserErrors { field message } }
      }`, { id: product.id, media: chunk.map((a) => ({ mediaContentType: 'IMAGE', originalSource: a.url, alt: `Back - ${a.color}` })) });
      const errs = data.productCreateMedia.mediaUserErrors;
      if (errs.length) console.log(`   errors: ${JSON.stringify(errs).slice(0, 300)}`);
      added += chunk.length - errs.length;
      await sleep(600);
    }
    progress[t.id] = 'done';
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }
  console.log(`\n${DRY_RUN ? 'DRY RUN — ' : ''}added ${added}, products already done ${skipped}, colors without a SanMar back photo ${missing}`);
}

main().catch((err) => { console.error(err.response ? JSON.stringify(err.response.data).slice(0, 500) : err); process.exit(1); });

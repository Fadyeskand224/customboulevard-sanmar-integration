'use strict';

/**
 * Builds the storefront's color-swatch CSS from SanMar's own swatch images.
 *
 * Why this exists: the theme colors a swatch circle only when the option
 * value's handle exactly matches a hand-written `.bg_color_<name>` rule in
 * theme.css (red, blue, black...). Every other SanMar color name
 * ("Cardinal", "Athletic Heather", "Deep Royal"...) falls through to a
 * default light grey. SanMar publishes a real swatch image per color
 * (EPDD column COLOR_SQUARE_IMAGE, served from cdnm.sanmar.com/swatch/gifs/),
 * so we sample the true color from that instead of guessing hex codes.
 *
 * The same color name looks different across brands ("Red" is a bright red
 * on one tee and a deep crimson on another), and a few swatch files are
 * SanMar's "IMAGE NOT YET AVAILABLE" placeholder. So for each name we sample
 * every distinct swatch file, drop placeholders, and use the medoid — the
 * real swatch closest to all the others — as the representative shade.
 *
 * Output is one CSS rule per distinct color, keyed by the same handle the
 * theme puts in each swatch's class (`bg_color_{{ value | handle }}`).
 *
 * Scans SanMar's ENTIRE catalog, not just catalog-config.js's curated
 * pilot brands/categories — the store also carries explicit, hand-picked
 * style batches outside that allowlist (e.g. Nike, Carhartt, New Era),
 * and a color missing here is a product that silently goes back to a grey
 * swatch circle on the live site. Covering every color SanMar has, not
 * just what's imported today, means newly imported styles (curated or
 * explicit-batch) get correct swatches with no extra work beyond
 * re-running this and deploying the CSS.
 *
 * Usage:
 *   node scripts/build-swatch-colors.js --epdd <SanMar_EPDD.csv> \
 *        [--out ../../shopify-theme/shopify-theme-folder-ex/assets/sanmar-swatch-colors.css]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { parse } = require('csv-parse');
const { createCanvas, loadImage } = require('canvas');

const SWATCH_BASE = 'https://cdnm.sanmar.com/swatch/gifs/';
const CONCURRENCY = 8;
const CACHE_FILE = path.join(__dirname, '../data/processed/swatch-colors.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

// Mirrors Liquid's `handle` filter, which is what the theme uses to build the
// class name on every swatch: lowercase, runs of non-alphanumerics -> "-".
function handleize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collects color name -> distinct swatch image filenames, across every row
 * in SanMar's catalog (not filtered to the curated pilot's brands/
 * categories — see the file header for why).
 */
async function collectColors(epddPath) {
  const colors = new Map(); // colorName -> Set(swatchFile)
  const parser = fs.createReadStream(epddPath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true, bom: true })
  );

  for await (const row of parser) {
    const name = (row.COLOR_NAME || '').replace(/\s+/g, ' ').trim();
    const file = (row.COLOR_SQUARE_IMAGE || '').trim();
    if (!name || !file) continue;
    (colors.get(name) || colors.set(name, new Set()).get(name)).add(file);
  }
  return colors;
}

/** Average color of a swatch image's inner region (skips any border). */
async function sampleSwatch(file) {
  const res = await axios.get(SWATCH_BASE + file, { responseType: 'arraybuffer', timeout: 20000 });
  const buf = Buffer.from(res.data);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const inset = Math.floor(Math.min(img.width, img.height) * 0.2);
  const w = img.width - inset * 2;
  const h = img.height - inset * 2;
  const data = ctx.getImageData(inset, inset, w, h).data;

  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  if (n === 0) throw new Error('swatch image has no opaque pixels');
  return { rgb: [r / n, g / n, b / n].map(Math.round), md5 };
}

const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// The real swatch closest (least squared RGB distance) to all the others.
// With only one or two samples there's no "typical" to find, so take the more
// saturated one — fabric photos read muted, and a grey-green "Green" is worse
// than a slightly vivid one.
function medoid(samples) {
  if (samples.length <= 2) {
    const chroma = (c) => Math.max(...c.rgb) - Math.min(...c.rgb);
    return samples.reduce((a, b) => (chroma(b) > chroma(a) ? b : a));
  }
  let best = samples[0];
  let bestCost = Infinity;
  for (const a of samples) {
    let cost = 0;
    for (const b of samples) cost += a.rgb.reduce((sum, v, i) => sum + (v - b.rgb[i]) ** 2, 0);
    if (cost < bestCost) { bestCost = cost; best = a; }
  }
  return best;
}

async function main() {
  const epddPath = arg('--epdd');
  if (!epddPath) throw new Error('Usage: node scripts/build-swatch-colors.js --epdd <SanMar_EPDD.csv> [--out <css path>]');
  const outPath = arg('--out', path.join(__dirname, '../data/processed/sanmar-swatch-colors.css'));

  console.log('Scanning EPDD for colors in the curated catalog...');
  const colors = await collectColors(epddPath);
  console.log(`  ${colors.size} distinct color names`);

  const files = [...new Set([...colors.values()].flatMap((set) => [...set]))];
  console.log(`  ${files.length} distinct swatch files`);

  // Reuse previously sampled files so re-runs only fetch new ones.
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  const todo = files.filter((f) => !cache[f]);
  console.log(`  ${todo.length} to sample (${files.length - todo.length} cached)`);

  const failed = [];
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const file = todo[next++];
      try {
        cache[file] = await sampleSwatch(file);
      } catch (err) {
        failed.push(`${file}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

  // SanMar's "IMAGE NOT YET AVAILABLE" placeholder is one byte-identical
  // image reused under many unrelated color names — flag any image that
  // spans 3+ distinct color names as a placeholder, not a real swatch.
  const namesByMd5 = new Map();
  for (const [name, set] of colors) {
    for (const f of set) {
      if (!cache[f]) continue;
      (namesByMd5.get(cache[f].md5) || namesByMd5.set(cache[f].md5, new Set()).get(cache[f].md5)).add(name);
    }
  }
  const placeholderMd5 = new Set([...namesByMd5].filter(([, names]) => names.size >= 3).map(([md5]) => md5));

  const resolved = new Map(); // color name -> hex
  const unresolved = [];
  for (const [name, set] of colors) {
    const samples = [...set].map((f) => cache[f]).filter((c) => c && !placeholderMd5.has(c.md5));
    if (samples.length === 0) { unresolved.push(name); continue; }
    resolved.set(name, toHex(medoid(samples).rgb));
  }

  // Multi-color names ("Black/ Red/ Stone") often only have placeholder
  // swatches. A circle can only show one color, so fall back to the first
  // color named, if that one resolved on its own.
  for (const name of [...unresolved]) {
    const first = name.split('/')[0].trim();
    if (first !== name && resolved.has(first)) {
      resolved.set(name, resolved.get(first));
      unresolved.splice(unresolved.indexOf(name), 1);
    }
  }

  // Group handles by hex so the file stays small. !important lets these beat
  // the theme's own `.bg_color_red` etc. defaults regardless of load order
  // (theirs are inaccurate: "red" is orange, "green" is lime).
  const byHex = new Map();
  const seenHandles = new Set();
  for (const name of [...resolved.keys()].sort()) {
    const handle = handleize(name);
    if (!handle || seenHandles.has(handle)) continue;
    seenHandles.add(handle);
    const hex = resolved.get(name);
    (byHex.get(hex) || byHex.set(hex, []).get(hex)).push(handle);
  }

  let css = '/* Generated by sanmar-integration/scripts/build-swatch-colors.js from SanMar swatch images. Do not edit by hand. */\n';
  for (const [hex, handles] of [...byHex].sort()) {
    css += handles.map((h) => `.bg_color_${h}`).join(',') + `{--t4s-bg-color:${hex}!important}\n`;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, css);

  console.log(`Wrote ${seenHandles.size} color rules -> ${outPath} (${(css.length / 1024).toFixed(1)} KB)`);
  console.log(`  ${placeholderMd5.size} placeholder image(s) ignored`);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} color(s) had no usable swatch (left to the theme's default): ${unresolved.join(', ')}`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} swatch file(s) failed to download: ${failed.slice(0, 10).join('; ')}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

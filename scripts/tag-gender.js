'use strict';
/**
 * Adds a gender tag (Men's, Women's or Youth) to every live apparel product so the
 * storefront can filter and group by it. Derived from the product title (SanMar names
 * youth/toddler/infant/women's/ladies styles explicitly; the rest are adult/unisex).
 * Non-apparel (mug, tote, caps, visors, DTF, gang sheet) gets no gender tag.
 *
 *   node scripts/tag-gender.js [--dry-run]
 */
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const shopify = require('../src/shopify');

const GENDER_TAGS = ["Men's", "Women's", 'Youth'];
const nonApparel = (p) => /mug|tote|gang sheet|dtf|\bcap\b|visor|beanie|watch cap|snapback/i.test(p.title) || /^(caps|visors|fleece\/beanies|gang sheet)$/i.test(p.product_type || '');
const genderOf = (p) => (nonApparel(p) ? null : /youth|toddler|infant/i.test(p.title) ? 'Youth' : /women|ladies/i.test(p.title) ? "Women's" : "Men's");

async function main() {
  const dry = process.argv.includes('--dry-run');
  const token = await shopify.getAccessToken();
  const h = { headers: { 'X-Shopify-Access-Token': token } };
  const base = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/`;
  let url = `${base}products.json?limit=250&status=active&fields=id,title,tags,product_type,published_at`;
  const products = [];
  while (url) {
    const r = await axios.get(url, h);
    products.push(...r.data.products.filter((p) => p.published_at));
    const next = (r.headers.link || '').match(/<([^>]+)>; rel="next"/);
    url = next ? next[1] : null;
  }
  let changed = 0;
  const counts = {};
  for (const p of products) {
    const want = genderOf(p);
    const tags = p.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const next = tags.filter((t) => !GENDER_TAGS.includes(t)).concat(want ? [want] : []);
    if (want) counts[want] = (counts[want] || 0) + 1;
    if (next.length === tags.length && next.every((t) => tags.includes(t))) continue;
    changed++;
    if (!dry) {
      for (let a = 1; a <= 4; a++) {
        try { await axios.put(`${base}products/${p.id}.json`, { product: { id: p.id, tags: next.join(', ') } }, h); break; }
        catch (e) { if (a === 4) throw e; await shopify.sleep(1500 * a); }
      }
      await shopify.sleep(600);
    }
  }
  console.log(`${products.length} live products, ${changed} ${dry ? 'would change' : 'updated'}`, counts);
}
main().catch((e) => { console.error(e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.stack); process.exit(1); });

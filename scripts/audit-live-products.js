'use strict';

/**
 * Audits every product that is live on the storefront (read-only):
 *   INVENTORY   every variant tracked by Shopify and stocked somewhere; flags variants at 0
 *   LOOKS       title is clean, price > 0, description + vendor present, every color has a photo
 *               linked, SKUs present, assigned to at least one real collection
 *   CUSTOMIZABLE the storefront page loads (200) with Zakeke's Customize button, and Zakeke has
 *               the product Published
 * Gang sheet / DTF pages use their own buying flow and are checked for loading only.
 *
 * Usage: node scripts/audit-live-products.js [--json]
 * Output: a summary, the list of problems, and data/processed/audit-latest.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const shopify = require('../src/shopify');
const zakeke = require('../src/zakeke');

let token = null;
async function gql(query, variables) {
  token = token || (await shopify.getAccessToken());
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`,
        { query, variables }, { headers: { 'X-Shopify-Access-Token': token }, timeout: 60000 });
      if (res.data.errors) {
        if (res.data.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED') && attempt < 5) { await shopify.sleep(2000 * attempt); continue; }
        throw new Error(JSON.stringify(res.data.errors).slice(0, 300));
      }
      return res.data.data;
    } catch (err) {
      if (attempt === 5) throw err;
      await shopify.sleep(1500 * attempt);
    }
  }
  return null;
}

async function loadProduct(id) {
  const base = await gql(`query($id: ID!) { product(id: $id) {
    id title handle vendor productType descriptionHtml status publishedAt onlineStoreUrl tags totalInventory tracksInventory
    mediaCount { count }
    collections(first: 20) { nodes { title ruleSet { appliedDisjunctively } } }
  } }`, { id });
  const variants = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($id: ID!, $after: String) { product(id: $id) { variants(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { sku price inventoryQuantity inventoryPolicy selectedOptions { name value } image { id } inventoryItem { tracked } }
    } } }`, { id, after });
    variants.push(...d.product.variants.nodes);
    if (!d.product.variants.pageInfo.hasNextPage) break;
    after = d.product.variants.pageInfo.endCursor;
  }
  return { ...base.product, variants };
}

async function main() {
  const ids = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($a: String) { products(first: 100, after: $a, query: "status:active") { pageInfo { hasNextPage endCursor } nodes { id publishedAt } } }`, { a: after });
    d.products.nodes.filter((p) => p.publishedAt).forEach((p) => ids.push(p.id));
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  console.log(`Auditing ${ids.length} live product(s)...`);

  const zk = await zakeke.getClient();
  const zkList = await zakeke.getProducts(zk);
  const zkProducts = Array.isArray(zkList) ? zkList : zkList.items;
  const zkByCode = new Map(zkProducts.map((p) => [String(p.code), p]));

  const report = [];
  const concurrency = 4;
  let idx = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++];
      const p = await loadProduct(id);
      const special = /gang|dtf/i.test(`${p.handle} ${p.title}`);
      const issues = { inventory: [], looks: [], custom: [] };

      // INVENTORY
      const untracked = p.variants.filter((v) => !v.inventoryItem.tracked).length;
      const zero = p.variants.filter((v) => v.inventoryItem.tracked && v.inventoryQuantity <= 0).length;
      const stocked = p.variants.filter((v) => v.inventoryQuantity > 0).length;
      if (!special) {
        if (untracked) issues.inventory.push(`${untracked} variant(s) not inventory-tracked`);
        if (!stocked) issues.inventory.push('no stock in any variant');
        else if (zero) issues.inventory.push(`${zero} of ${p.variants.length} variant(s) at 0 stock`);
      }

      // LOOKS
      if (/&#\d+;|&amp;|&[a-z]+;/.test(p.title)) issues.looks.push('title has HTML entities');
      if (/\s{2,}/.test(p.title.trim())) issues.looks.push('title has doubled spaces');
      if (p.variants.some((v) => !(parseFloat(v.price) > 0))) issues.looks.push('a variant has no price');
      if (!special) {
        if ((p.descriptionHtml || '').replace(/<[^>]+>/g, '').trim().length < 20) issues.looks.push('no description');
        if (!p.vendor) issues.looks.push('no vendor');
        if (!p.mediaCount.count) issues.looks.push('no images');
        const colorOpt = p.variants[0] && p.variants[0].selectedOptions.find((o) => /colou?r/i.test(o.name));
        if (colorOpt) {
          const colors = new Map();
          p.variants.forEach((v) => { const c = v.selectedOptions.find((o) => /colou?r/i.test(o.name)).value; colors.set(c, colors.get(c) || !!v.image); if (v.image) colors.set(c, true); });
          const noPhoto = [...colors.entries()].filter(([, has]) => !has).map(([c]) => c);
          if (noPhoto.length) issues.looks.push(`${noPhoto.length} color(s) with no photo: ${noPhoto.slice(0, 3).join(', ')}${noPhoto.length > 3 ? '…' : ''}`);
        }
        if (p.variants.some((v) => !v.sku)) issues.looks.push('variant(s) missing SKU');
        if (!p.collections.nodes.some((c) => !c.ruleSet)) issues.looks.push('not in any category collection');
      }

      // CUSTOMIZABLE
      let status = null;
      let hasZakeke = false;
      try {
        const res = await axios.get(p.onlineStoreUrl, { validateStatus: () => true, timeout: 30000 });
        status = res.status;
        hasZakeke = /zakeke-product-button/.test(res.data);
      } catch (e) { status = e.code || 'ERR'; }
      const zkProduct = zkByCode.get(String(p.id.split('/').pop()));
      if (status !== 200) issues.custom.push(`storefront page returned ${status}`);
      if (!special) {
        if (!hasZakeke) issues.custom.push('no Customize button on the page');
        if (!zkProduct) issues.custom.push('not in Zakeke');
        else if (zkProduct.status !== 'Published') issues.custom.push(`Zakeke status ${zkProduct.status}`);
      }

      report.push({ id: p.id.split('/').pop(), title: p.title.replace(/\s+/g, ' ').trim(), handle: p.handle, special, variants: p.variants.length, stocked, zero, units: p.totalInventory, status, hasZakeke, zakeke: zkProduct ? zkProduct.status : null, issues });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  report.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(__dirname, '../data/processed/audit-latest.json'), JSON.stringify(report, null, 1));

  const bad = report.filter((r) => r.issues.inventory.length || r.issues.looks.length || r.issues.custom.length);
  const count = (k) => report.filter((r) => r.issues[k].length).length;
  console.log(`\n${report.length} live product(s): ${report.length - bad.length} clean, ${bad.length} with findings`);
  console.log(`  inventory findings: ${count('inventory')} | look findings: ${count('looks')} | customization findings: ${count('custom')}`);
  console.log(`  total variants: ${report.reduce((s, r) => s + r.variants, 0)}, units in stock: ${report.reduce((s, r) => s + (r.units || 0), 0)}`);
  for (const r of bad) {
    console.log(`\n${r.title.slice(0, 70)}  [${r.id}]`);
    for (const k of ['inventory', 'looks', 'custom']) r.issues[k].forEach((i) => console.log(`   ${k.toUpperCase().padEnd(9)} ${i}`));
  }
}

main().catch((err) => { console.error(err.response ? JSON.stringify(err.response.data).slice(0, 400) : err.stack || err.message); process.exit(1); });

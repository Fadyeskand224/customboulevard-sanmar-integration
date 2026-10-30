'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { downloadSanmarFiles } = require('./src/sftp');
const { buildShopifyProducts } = require('./src/mapper');
const { bulkImportProducts } = require('./src/shopify');

const EPDD_PATH = path.join(__dirname, 'data/raw/SanMar_EPDD.csv');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_DOWNLOAD = args.includes('--skip-download');
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx !== -1 ? parseInt(args[idx + 1], 10) : null;
})();

async function main() {
  console.log('=== SanMar → Shopify Product Import ===');
  if (DRY_RUN) console.log('MODE: DRY RUN (no Shopify API calls will be made)\n');

  // Step 1: Download EPDD CSV from SanMar SFTP
  if (!SKIP_DOWNLOAD) {
    await downloadSanmarFiles();
  } else {
    console.log('Skipping SFTP download (--skip-download flag set)');
  }

  // Step 2 & 3: Stream-parse SanMar_EPDD.csv and map to Shopify products
  // (streamed, not loaded fully into memory — the real file runs 500MB+)
  console.log('\nParsing and mapping SanMar_EPDD.csv...');
  let products = await buildShopifyProducts(EPDD_PATH);
  console.log(`  ${products.length} products mapped`);

  if (LIMIT) {
    console.log(`  Limiting to first ${LIMIT} products (--limit flag)`);
    products = products.slice(0, LIMIT);
  }

  // Step 4: Import to Shopify
  const result = await bulkImportProducts(products, { dryRun: DRY_RUN });

  if (!DRY_RUN) {
    console.log('\nNext steps:');
    console.log('  1. Go to Shopify Admin → Products (filter Status: Draft)');
    console.log('  2. Review products, then bulk-publish when ready');
    console.log('  3. Assign to collections (Custom Apparel, etc.)');
    console.log('  4. Run "node src/inventory-sync.js" to sync live inventory');
  }

  return result;
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
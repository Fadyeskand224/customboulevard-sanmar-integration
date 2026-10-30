'use strict';

/**
 * One-command pipeline:
 *   node scripts/build-shopify-csv.js              → downloads from SFTP, converts real data
 *   node scripts/build-shopify-csv.js --sample     → uses sample CSV (no SFTP needed)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { convertEpddToShopifyCsv } = require('../src/csv-converter');

const USE_SAMPLE = process.argv.includes('--sample');

const REAL_INPUT   = path.join(__dirname, '../data/raw/SanMar_EPDD.csv');
const SAMPLE_INPUT = path.join(__dirname, '../data/raw/SanMar_EPDD_sample.csv');
const OUTPUT_DIR   = path.join(__dirname, '../data/processed');
const OUTPUT_FILE  = path.join(OUTPUT_DIR, 'shopify_products.csv');

async function main() {
  console.log('=== SanMar → Shopify CSV Builder ===\n');

  let inputFile;

  if (USE_SAMPLE) {
    inputFile = SAMPLE_INPUT;
    console.log('Mode: SAMPLE (using local test data, no SFTP needed)\n');
  } else {
    // Download real file from SanMar SFTP first
    console.log('Mode: LIVE (downloading from SanMar SFTP)\n');
    const { downloadSanmarFiles } = require('../src/sftp');
    await downloadSanmarFiles();
    inputFile = REAL_INPUT;

    if (!fs.existsSync(inputFile)) {
      throw new Error(`SFTP download succeeded but ${REAL_INPUT} not found. Check the SanmarPDD folder path.`);
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const result = await convertEpddToShopifyCsv(inputFile, OUTPUT_FILE);

  console.log('\n=== Done ===');
  console.log(`  Products:  ${result.products}`);
  console.log(`  CSV rows:  ${result.csvRows}`);
  console.log(`  Output:    ${OUTPUT_FILE}`);
  console.log('\nNext step: Import this file in Shopify Admin → Products → Import');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});

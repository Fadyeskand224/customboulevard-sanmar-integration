'use strict';

/**
 * SanMar's SFTP sessions appear to silently die (connection goes idle with
 * no error, no data) somewhere around 35-40 minutes in, regardless of how
 * much has transferred — hit twice now, at 22% and 91% through two
 * different files. A plain retry-from-scratch risks repeating this
 * indefinitely on a large file. This resumes from the local file's current
 * size using a ranged SFTP read (`createReadStream({ start })`) appended to
 * the existing local file, reconnecting and resuming again on failure, up
 * to MAX_ATTEMPTS.
 *
 * Usage: node scripts/resumable-download.js <remotePath> <localPath>
 */

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { verifySanmarHostKey } = require('../src/sftp');

const MAX_ATTEMPTS = 8;
const STALL_TIMEOUT_MS = 90 * 1000; // no bytes received for this long => assume dead, reconnect

async function getRemoteSize(sftp, remotePath) {
  const stat = await sftp.stat(remotePath);
  return stat.size;
}

async function downloadChunk(remotePath, localPath, startOffset) {
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.SANMAR_SFTP_HOST,
    port: parseInt(process.env.SANMAR_SFTP_PORT, 10),
    username: process.env.SANMAR_SFTP_USERNAME,
    password: process.env.SANMAR_SFTP_PASSWORD,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
      kex: [
        'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
        'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group-exchange-sha1',
      ],
    },
    hostVerifier: verifySanmarHostKey,
    readyTimeout: 20000,
  });

  const remoteSize = await getRemoteSize(sftp, remotePath);

  await new Promise((resolve, reject) => {
    const readStream = sftp.createReadStream(remotePath, { start: startOffset });
    const writeStream = fs.createWriteStream(localPath, { flags: 'a' });

    let lastByteAt = Date.now();
    let received = 0;
    const stallCheck = setInterval(() => {
      if (Date.now() - lastByteAt > STALL_TIMEOUT_MS) {
        clearInterval(stallCheck);
        readStream.destroy(new Error('stalled — no data for ' + STALL_TIMEOUT_MS + 'ms'));
      }
    }, 5000);

    readStream.on('data', (chunk) => {
      lastByteAt = Date.now();
      received += chunk.length;
    });
    readStream.on('error', (err) => { clearInterval(stallCheck); writeStream.end(); reject(err); });
    writeStream.on('error', (err) => { clearInterval(stallCheck); reject(err); });
    writeStream.on('finish', () => { clearInterval(stallCheck); resolve({ received, remoteSize }); });

    readStream.pipe(writeStream);
  }).finally(async () => {
    try { await sftp.end(); } catch (_) { /* already dead, ignore */ }
  });

  return remoteSize;
}

async function resumableDownload(remotePath, localPath) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startOffset = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
    console.log(`[attempt ${attempt}/${MAX_ATTEMPTS}] Resuming from byte ${startOffset.toLocaleString()}...`);

    try {
      const remoteSize = await downloadChunk(remotePath, localPath, startOffset);
      const localSize = fs.statSync(localPath).size;
      console.log(`  Connection closed cleanly. Local: ${localSize.toLocaleString()} / Remote: ${remoteSize.toLocaleString()}`);

      if (localSize >= remoteSize) {
        console.log('Download complete.');
        return;
      }
      console.log('  Incomplete — reconnecting to resume...');
    } catch (err) {
      const localSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      console.log(`  Attempt failed (${err.message}) at byte ${localSize.toLocaleString()} — retrying...`);
    }
  }
  throw new Error(`Did not complete after ${MAX_ATTEMPTS} attempts`);
}

if (require.main === module) {
  const [remotePath, localPath] = process.argv.slice(2);
  if (!remotePath || !localPath) {
    console.error('Usage: node scripts/resumable-download.js <remotePath> <localPath>');
    process.exit(1);
  }
  resumableDownload(remotePath, localPath).catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { resumableDownload };

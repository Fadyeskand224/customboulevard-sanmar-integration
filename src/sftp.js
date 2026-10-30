'use strict';

const SftpClient = require('ssh2-sftp-client');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const RAW_DIR = path.join(__dirname, '../data/raw');

// SanMar's SFTP server key (RSA), as served by ftp.sanmar.com:2200 on
// 2026-10-26. Pinned so the SanMar password is only ever sent to SanMar's
// real server — accepting any key would hand it to anyone able to intercept
// the connection. If SanMar rotates its key the connection fails loudly with
// the new fingerprint; verify it with SanMar, then set
// SANMAR_SFTP_HOST_FINGERPRINT (or update this default).
const SANMAR_HOST_FINGERPRINT = process.env.SANMAR_SFTP_HOST_FINGERPRINT || 'SHA256:5n3MbQ0zsoXr1mMpdzKWx7lSFkdHfuZC9FXYUV6ba5E';

function verifySanmarHostKey(key) {
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  if (fingerprint !== SANMAR_HOST_FINGERPRINT) {
    console.error(`SanMar SFTP host key mismatch: got ${fingerprint}, expected ${SANMAR_HOST_FINGERPRINT}. Refusing to connect.`);
    return false;
  }
  return true;
}

// Real folder is "/SanMarPDD" (capital M) — verified against the live
// server listing; the FTP guide's own text has a "Sanmar" typo for this path.
const FILES_TO_DOWNLOAD = [
  '/SanMarPDD/SanMar_EPDD.csv',
  '/SanMarPDD/sanmar_dip.txt',
];

async function downloadSanmarFiles(files = FILES_TO_DOWNLOAD) {
  const sftp = new SftpClient();

  if (!fs.existsSync(RAW_DIR)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }

  console.log('Connecting to SanMar SFTP...');

  await sftp.connect({
    host: process.env.SANMAR_SFTP_HOST,
    port: parseInt(process.env.SANMAR_SFTP_PORT, 10),
    username: process.env.SANMAR_SFTP_USERNAME,
    password: process.env.SANMAR_SFTP_PASSWORD,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
      kex: [
        'diffie-hellman-group14-sha256',
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group-exchange-sha256',
        'diffie-hellman-group-exchange-sha1',
      ],
    },
    hostVerifier: verifySanmarHostKey,
  });

  for (const remotePath of files) {
    const filename = path.basename(remotePath);
    const localPath = path.join(RAW_DIR, filename);
    console.log(`Downloading ${filename}...`);
    await sftp.get(remotePath, localPath);
    console.log(`  Saved to ${localPath}`);
  }

  await sftp.end();
  console.log('SFTP download complete.');
}

// Allow running standalone: node src/sftp.js
if (require.main === module) {
  downloadSanmarFiles().catch((err) => {
    console.error('SFTP error:', err.message);
    process.exit(1);
  });
}

module.exports = { downloadSanmarFiles, FILES_TO_DOWNLOAD, verifySanmarHostKey };

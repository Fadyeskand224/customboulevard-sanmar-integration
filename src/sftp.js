'use strict';

const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const RAW_DIR = path.join(__dirname, '../data/raw');

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
    hostVerifier: () => true,
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

module.exports = { downloadSanmarFiles, FILES_TO_DOWNLOAD };

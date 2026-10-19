'use strict';
// This test-only cache serves the exact pinned upstream bytes to Chromium. It is
// never loaded by index.html and does not change production dependency behavior.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const directory = path.join(__dirname, '.cache');
fs.mkdirSync(directory, { recursive: true });
const dependencies = [
  ['pdf-lib@1.17.1/dist/pdf-lib.min.js', 'pdf-lib.min.js', 'weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI', '/workspace/deps/pdfLib.js'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.min.mjs', 'pdf.min.mjs', 'WZ19eSKLd5nvuF6gSf5+dWLC1OM7omDgxo0gENWkgmOr43sLyle/LJp+TKHjDAKY', '/workspace/deps/pdf.min.mjs'],
  ['fflate@0.8.2/umd/index.js', 'fflate.min.js', 'DT0Ls0mO7JmjTnT+oBuMhEJzYJO1zUqzuuMXNdnOmOQRIpN2BgSjvBV/j50NngIT', '/workspace/deps/zip.js'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs', 'XQpM4ft9oqgzszJDEejhnb/lm8/sxo2oTDykD8DHEXahzhSdDUhNYfrnJ/4ndOpb', '/workspace/deps/pdf.worker.min.mjs'],
  ['qrcode-generator@1.4.4/qrcode.js', 'qrcode.js', '8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k', '/workspace/v2parts/qrcode-1.4.4.js'],
];
for (const [url, name, expectedHash, existing] of dependencies) {
  const filename = path.join(directory, name);
  if (!fs.existsSync(filename)) {
    if (existing && fs.existsSync(existing)) fs.copyFileSync(existing, filename);
    else execFileSync('curl', ['-fLsS', '--max-time', '90', `https://cdn.jsdelivr.net/npm/${url}`, '-o', filename], { stdio: 'inherit' });
  }
  const bytes = fs.readFileSync(filename);
  const actualHash = crypto.createHash('sha384').update(bytes).digest('base64');
  if (expectedHash && expectedHash !== actualHash) throw new Error(`Pinned integrity mismatch for ${name}`);
  console.log(`${name}: ${bytes.length} bytes, SHA384 ${actualHash}`);
}

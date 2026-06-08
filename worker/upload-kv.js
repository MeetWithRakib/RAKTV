#!/usr/bin/env node
/**
 * RAK TV — KV Upload Script
 * Run: node upload-kv.js
 * Requires: wrangler CLI logged in
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KV_DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'channels_kv.json'), 'utf8')
);

console.log(`📡 Uploading ${Object.keys(KV_DATA).length} channels to Cloudflare KV...\n`);

let success = 0;
let failed = 0;

for (const [key, value] of Object.entries(KV_DATA)) {
  try {
    const json = JSON.stringify(value);
    // Escape for shell
    const escaped = json.replace(/'/g, "'\\''");
    execSync(
      `wrangler kv:key put --binding=RAK_KV "${key}" '${escaped}'`,
      { stdio: 'pipe' }
    );
    success++;
    process.stdout.write(`\r✅ Uploaded ${success}/${Object.keys(KV_DATA).length}`);
  } catch (e) {
    failed++;
    console.error(`\n❌ Failed: ${key} — ${e.message}`);
  }
}

console.log(`\n\n✅ Done! ${success} uploaded, ${failed} failed.`);
console.log('\n📋 Next steps:');
console.log('  1. wrangler deploy');
console.log('  2. Copy worker URL to frontend/.env');

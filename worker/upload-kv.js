/**
 * RAK TV — KV Bulk Upload (Windows compatible)
 * Uses Cloudflare REST API directly — no shell quoting issues
 * Run: node upload-kv.js YOUR_API_TOKEN YOUR_ACCOUNT_ID YOUR_KV_NAMESPACE_ID
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Get args ──
const [,, API_TOKEN, ACCOUNT_ID, KV_ID] = process.argv;

if (!API_TOKEN || !ACCOUNT_ID || !KV_ID) {
  console.log(`
Usage:
  node upload-kv.js <API_TOKEN> <ACCOUNT_ID> <KV_NAMESPACE_ID>

How to get these:
  API_TOKEN   → dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template
  ACCOUNT_ID  → dash.cloudflare.com → Right sidebar → Account ID
  KV_ID       → Workers & Pages → KV → RAK_KV → Namespace ID
`);
  process.exit(1);
}

const KV_DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'channels_kv.json'), 'utf8')
);

const entries = Object.entries(KV_DATA);
console.log(`\n📡 Uploading ${entries.length} channels via REST API...\n`);

// Cloudflare KV bulk write supports up to 10,000 entries at once
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({ success: false, raw: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function upload() {
  // Build bulk payload — max 10,000 per request, we have 90
  const bulkPayload = entries.map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
    expiration_ttl: undefined
  }));

  console.log(`Uploading all ${bulkPayload.length} channels in one batch...`);

  const result = await apiRequest(
    'PUT',
    `/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/bulk`,
    bulkPayload
  );

  if (result.success) {
    console.log(`\n✅ Successfully uploaded all ${bulkPayload.length} channels!\n`);
    console.log('📋 Next steps:');
    console.log('  1. Update frontend/index.html with WORKER_URL');
    console.log('  2. Deploy to Vercel');
  } else {
    console.error('\n❌ Upload failed:');
    console.error(JSON.stringify(result.errors || result, null, 2));
    console.log('\nPlease check your API_TOKEN, ACCOUNT_ID, and KV_ID');
  }
}

upload().catch(err => {
  console.error('Fatal error:', err.message);
});

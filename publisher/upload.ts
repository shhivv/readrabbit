// Upload the selected starter pack to Cloudflare R2.
//
// Env (or publisher/.env):
//   R2_ACCOUNT_ID      cloudflare account id
//   R2_ACCESS_KEY_ID   r2 API token access key
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET          bucket name
//   R2_PREFIX          optional key prefix (default "nc")
//
// Layout written:
//   <prefix>/starter.json           latest — this is what the app fetches
//   <prefix>/packs/YYYY-MM-DD.json  dated history

import { AwsClient } from "aws4fetch";

const packPath = new URL("./.data/starter-pack.json", import.meta.url).pathname;
const packFile = Bun.file(packPath);
if (!(await packFile.exists())) {
  console.error("✗ no .data/starter-pack.json — run `bun run crawl` first");
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
const prefix = process.env.R2_PREFIX ?? "nc";

for (const [name, value] of Object.entries({
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
  R2_BUCKET: bucket,
})) {
  if (!value) {
    console.error(`✗ missing env ${name}`);
    process.exit(1);
  }
}

const body = await packFile.text();
const pack = JSON.parse(body);
const today = new Date().toISOString().slice(0, 10);

const r2 = new AwsClient({ accessKeyId, secretAccessKey });
const base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;

for (const key of [`${prefix}/starter.json`, `${prefix}/packs/${today}.json`]) {
  const res = await r2.fetch(`${base}/${key}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
    body,
  });
  if (!res.ok) {
    console.error(`✗ upload failed for ${key}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`✓ uploaded ${key} (${(body.length / 1024).toFixed(0)} KB, ${pack.articles.length} articles)`);
}

console.log(`\napp constant: STARTER_PACK_URL = "https://your-public-r2.dev/${prefix}/starter.json"`);
console.log("(serve the bucket via a public r2.dev domain or a worker)");

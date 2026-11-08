// Fetches the key set of each Casazium-hosted server the demo knows, checks
// it against the root keys built into the SDK, and saves them to
// main/key-sets.json. Run before every release, so new installs start
// from the current list:
//
//   node scripts/update-key-sets.mjs
//
// A key set is public (GET /v1/signing-keys), so it's safe to commit. A set
// that doesn't verify stops the script, and nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASAZIUM_HOSTED_ROOT_KEYS, CasaziumLicenseClient } from '@casazium/license-sdk';

// The servers the demo ships key sets for: the demo server (its default)
// and hosted production, for a visitor who points the demo at their own
// hosted account.
const SERVERS = ['https://demo-license-api.casazium.com', 'https://license-cloud-api.casazium.com'];

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main', 'key-sets.json');
const sets = {};
for (const issuer of SERVERS) {
  const res = await fetch(`${issuer}/v1/signing-keys`);
  if (!res.ok) throw new Error(`${issuer}/v1/signing-keys answered ${res.status}`);
  const doc = await res.json();
  // The client verifies the set against the hosted roots for this issuer;
  // a set that doesn't verify makes refreshKeySet() reject.
  const client = new CasaziumLicenseClient({
    baseUrl: `${issuer}/v1`,
    rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
    keySet: doc,
  });
  await client.refreshKeySet();
  const payload = JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8'));
  console.log(`${issuer}: sequence ${payload.sequence}, ${payload.keys.length} keys, verified`);
  sets[issuer] = doc;
}
fs.writeFileSync(out, `${JSON.stringify(sets, null, 2)}\n`);
console.log(`Saved ${path.relative(process.cwd(), out)}`);

// Fetches the key set of each Casazium-hosted server the demo knows, checks
// it against the root keys built into the SDK, and saves them to
// main/key-sets.json. Run before every release, so new installs start
// from the current list:
//
//   node scripts/update-key-sets.mjs
//
// A key set is public (GET /v1/signing-keys), so it's safe to commit. A set
// that doesn't verify, or is older than the one already saved, stops the
// script, and nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASAZIUM_HOSTED_ROOT_KEYS, CasaziumLicenseClient } from '@casazium/license-sdk';

// The servers the demo ships key sets for: the demo server (its default)
// and hosted production, for a visitor who points the demo at their own
// hosted account. Only origins with roots in CASAZIUM_HOSTED_ROOT_KEYS
// can be listed.
const SERVERS = ['https://demo-license-api.casazium.com', 'https://license-cloud-api.casazium.com'];

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main', 'key-sets.json');
const sequenceOf = (doc) => JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8')).sequence;
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  // First run.
}

const sets = {};
for (const issuer of SERVERS) {
  const res = await fetch(`${issuer}/v1/signing-keys`);
  if (!res.ok) throw new Error(`${issuer}/v1/signing-keys answered ${res.status}`);
  const doc = await res.json();
  // Verified the way the app does: the client checks the set against the
  // hosted roots for this issuer, and refreshKeySet() rejects if it doesn't
  // verify. Its fetch is stubbed, so the server isn't asked again.
  const client = new CasaziumLicenseClient({
    baseUrl: `${issuer}/v1`,
    rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
    keySet: doc,
    fetch: async () => {
      throw new Error('not fetched');
    },
  });
  await client.refreshKeySet();
  const sequence = sequenceOf(doc);
  if (saved[issuer]) {
    const before = sequenceOf(saved[issuer]);
    if (sequence < before) throw new Error(`${issuer}: the server's set (${sequence}) is older than the saved one (${before})`);
    if (sequence === before && JSON.stringify(doc) !== JSON.stringify(saved[issuer])) {
      throw new Error(`${issuer}: a different set with the same sequence (${sequence}) as the saved one`);
    }
  }
  const payload = JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8'));
  console.log(`${issuer}: sequence ${sequence}, ${payload.keys.length} keys, verified`);
  sets[issuer] = doc;
}
fs.writeFileSync(out, `${JSON.stringify(sets, null, 2)}\n`);
console.log(`Saved ${path.relative(process.cwd(), out)}`);

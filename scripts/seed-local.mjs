// Issues a demo license on a License Server you run yourself, so the app
// has something to activate. Uses the server's admin API key, which
// belongs on your machine or server - never in the app.
//
//   LICENSE_SERVER_URL=http://localhost:3001/v1 ADMIN_API_KEY=... npm run seed:local
//
// Prints the key and the product UUID to paste into the app.

const baseUrl = process.env.LICENSE_SERVER_URL ?? 'http://localhost:3001/v1';
const adminKey = process.env.ADMIN_API_KEY;
if (!adminKey) {
  console.error('Set ADMIN_API_KEY to your server\'s admin API key.');
  process.exit(1);
}

const res = await fetch(`${baseUrl}/issue-license`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
  body: JSON.stringify({
    product_id: 'casazium-demo',
    tier: 'pro',
    issued_to: 'demo@example.test',
    // Two machines, five metered actions, a week.
    max_activations: 2,
    limits: { api_calls_per_day: 5 },
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`issue-license failed with ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  process.exit(1);
}

console.log(`License key:   ${body.key}`);
console.log(`Product UUID:  ${body.product_uuid}`);

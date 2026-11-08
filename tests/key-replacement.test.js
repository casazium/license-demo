// A signing-key replacement, end to end, with the real SDK: test root and
// signing keys for a made-up issuer, a fake server that replaces its key
// halfway through, and the app's licensing module in between.
import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { CasaziumLicenseClient } from '@casazium/license-sdk';
import { createLicensing } from '../main/licensing.js';

const ISSUER = 'https://issuer.test';
const PRODUCT = 'product-uuid-1';
const KEY = 'KEY-1';

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const id = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return { id, pem, privateKey };
}

const root = keyPair();
const [k1, k2, k3] = [keyPair(), keyPair(), keyPair()];
const ROOT_KEYS = { [ISSUER]: [{ key_id: root.id, public_key: root.pem }] };

function keySet(sequence, keys) {
  const payload = Buffer.from(
    JSON.stringify({ type: 'signing-key-set', issuer: ISSUER, sequence, issued_at: new Date().toISOString(), keys })
  );
  return {
    payload: payload.toString('base64'),
    root_key_id: root.id,
    signature: crypto.sign('sha256', payload, root.privateKey).toString('base64'),
  };
}

const entry = (k, status, isDefault) => ({ key_id: k.id, public_key: k.pem, status, ...(isDefault ? { default: true } : {}) });
// Before: K1 signs, K2 waits as the emergency key. After: K1 revoked, K2
// signs, K3 is the new emergency key.
const SET_1 = keySet(1, [entry(k1, 'active', true), entry(k2, 'next')]);
const SET_2 = keySet(2, [entry(k1, 'revoked', true), entry(k2, 'active'), entry(k3, 'next')]);

function signedFile(signer, set) {
  const license = { type: 'license', key: KEY, product_uuid: PRODUCT, tier: 'pro', expires_at: null };
  return {
    license,
    signature: crypto.sign('sha256', Buffer.from(JSON.stringify(license)), signer.privateKey).toString('base64'),
    key_id: signer.id,
    key_set: set,
  };
}

// The server, before and after its key is replaced.
function fakeServer() {
  const server = { signer: k1, set: SET_1, online: true };
  server.fetch = async (url) => {
    if (!server.online) throw new TypeError('fetch failed');
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const route = new URL(url).pathname;
    if (route === '/v1/verify-license') return json({ valid: true, product_uuid: PRODUCT, tier: 'pro', expires_at: null });
    if (route === '/v1/validate-license') return json({ valid: true });
    if (route === '/v1/activate-license') return json({ activated: true, token: 'tok-1' });
    if (route === '/v1/license-export/offline') return json(signedFile(server.signer, server.set));
    if (route === '/v1/signing-keys') return json(server.set);
    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };
  return server;
}

function memoryStore(initial = null) {
  let value = initial;
  return {
    get: () => value,
    set: async (v) => {
      value = structuredClone(v);
    },
    update: async (fn) => {
      value = structuredClone(fn(value === null ? null : structuredClone(value)));
    },
    clear: async () => {
      value = null;
    },
  };
}

// One run of the app: a fresh licensing module (and so a fresh SDK
// client) over the same stores, as after a restart.
function app(server, stores, { builtIn = SET_1 } = {}) {
  return createLicensing({
    createClient: (options) => new CasaziumLicenseClient({ fetch: server.fetch, ...options }),
    vault: stores.vault,
    state: { get: () => ({}), update: () => {} },
    settings: () => ({ serverUrl: `${ISSUER}/v1`, productUuid: PRODUCT }),
    instanceId: () => 'machine-1',
    rootKeys: ROOT_KEYS,
    builtInKeySets: { [ISSUER]: builtIn },
    keySetStore: stores.keySets,
  });
}

describe('a signing-key replacement on the server', () => {
  test('the app follows it online, then keeps working offline, and refuses the replaced key', async () => {
    const server = fakeServer();
    const stores = { vault: memoryStore(), keySets: memoryStore() };

    // Before: activated, with a file signed by K1.
    const before = app(server, stores);
    expect(await before.activate(KEY)).toMatchObject({ outcome: 'activated' });
    expect(stores.vault.get().offlineFile.key_id).toBe(k1.id);
    expect(await before.verifyOffline()).toMatchObject({ valid: true });
    const oldFile = stores.vault.get().offlineFile;

    // The server replaces its key.
    server.signer = k2;
    server.set = SET_2;

    // Next start, online: the app learns set 2 and saves a file signed by K2.
    const online = app(server, stores);
    expect(await online.launchCheck()).toMatchObject({ state: 'ok', keySetUpdated: true });
    expect(stores.keySets.get()[ISSUER]).toEqual(SET_2);
    expect(stores.vault.get().offlineFile.key_id).toBe(k2.id);
    expect(online.status().trust).toMatchObject({ mode: 'key_set', sequence: 2, activeKeyId: k2.id });

    // A start after that, offline: the K2 file verifies...
    server.online = false;
    const offline = app(server, stores);
    expect(await offline.launchCheck()).toMatchObject({ state: 'offline', valid: true });
    // ...and a file signed by the replaced key doesn't.
    await stores.vault.set({ ...stores.vault.get(), offlineFile: oldFile });
    expect(await offline.verifyOffline()).toMatchObject({ valid: false, reason: 'file_refused' });
  });

  test('offline from the start, the app learns the new set from a newly exported file', async () => {
    const server = fakeServer();
    server.signer = k2;
    server.set = SET_2;
    const stores = { vault: memoryStore({ key: KEY, lastCheckedAt: Date.now(), offlineFile: signedFile(k2, SET_2) }), keySets: memoryStore() };
    server.online = false;
    const offline = app(server, stores);
    // The built-in set (1) doesn't know K2 as active, but the file carries set 2.
    expect(await offline.verifyOffline()).toMatchObject({ valid: true });
    // Having seen set 2, a file signed by K1 is refused.
    await stores.vault.set({ ...stores.vault.get(), offlineFile: signedFile(k1, SET_1) });
    expect(await offline.verifyOffline()).toMatchObject({ valid: false, reason: 'file_refused' });
  });

  test('a newer build ships set 2: an older stored set 1 does not bring K1 back', async () => {
    const server = fakeServer();
    server.online = false;
    const stores = { vault: memoryStore({ key: KEY, lastCheckedAt: Date.now(), offlineFile: signedFile(k1, SET_1) }), keySets: memoryStore({ [ISSUER]: SET_1 }) };
    const newer = app(server, stores, { builtIn: SET_2 });
    expect(newer.status().trust.sequence).toBe(2);
    expect(await newer.verifyOffline()).toMatchObject({ valid: false, reason: 'file_refused' });
  });

  test("a stored set that isn't signed by a root is ignored", async () => {
    const server = fakeServer();
    server.online = false;
    const forged = { ...SET_2, signature: crypto.sign('sha256', Buffer.from(SET_2.payload, 'base64'), k1.privateKey).toString('base64') };
    const stores = { vault: memoryStore({ key: KEY, lastCheckedAt: Date.now(), offlineFile: signedFile(k1, null) }), keySets: memoryStore({ [ISSUER]: forged }) };
    // Still on set 1, so the K1 file verifies.
    expect(await app(server, stores).verifyOffline()).toMatchObject({ valid: true });
  });
});

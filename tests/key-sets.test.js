import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { CASAZIUM_HOSTED_ROOT_KEYS, CasaziumLicenseClient } from '@casazium/license-sdk';
import { createLicensing } from '../main/licensing.js';

const BUILT_IN = JSON.parse(fs.readFileSync(new URL('../main/key-sets.json', import.meta.url), 'utf8'));
const DEMO = 'https://demo-license-api.casazium.com';
const PRODUCT = 'product-uuid-1';
const payloadOf = (doc) => JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8'));
// A copy of a set with another sequence: for display tests only (its
// signature no longer matches).
const withSequence = (doc, sequence) => ({
  ...doc,
  payload: Buffer.from(JSON.stringify({ ...payloadOf(doc), sequence })).toString('base64'),
});

describe('the key sets shipped in main/key-sets.json', () => {
  test('cover the demo server', () => {
    expect(Object.keys(BUILT_IN)).toContain(DEMO);
  });

  for (const [issuer, doc] of Object.entries(BUILT_IN)) {
    test(`${issuer}: verifies against the SDK's hosted roots`, async () => {
      expect(payloadOf(doc).issuer).toBe(issuer);
      // The server isn't asked (the fetch fails): refreshKeySet() rejects
      // only when the built-in set doesn't verify.
      const client = new CasaziumLicenseClient({
        baseUrl: `${issuer}/v1`,
        rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
        keySet: doc,
        fetch: async () => {
          throw new Error('offline');
        },
      });
      await expect(client.refreshKeySet()).resolves.toMatchObject({ updated: false });
    });
  }

  test('a set that does not verify is caught', async () => {
    const doc = { ...BUILT_IN[DEMO], signature: BUILT_IN[DEMO].signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    const client = new CasaziumLicenseClient({
      baseUrl: `${DEMO}/v1`,
      rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
      keySet: doc,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(client.refreshKeySet()).rejects.toThrow();
  });
});

// In-memory stand-ins for the app's two encrypted stores.
function memoryStore() {
  let value = null;
  return {
    get: () => value,
    set: async (v) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      value = structuredClone(v);
    },
    update: async (fn) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      value = structuredClone(fn(value === null ? null : structuredClone(value)));
    },
    clear: async () => {
      value = null;
    },
  };
}

function setup({ serverUrl = `${DEMO}/v1`, overrides = {} } = {}) {
  const vault = memoryStore();
  const keySetStore = memoryStore();
  const calls = [];
  const created = [];
  const client = {
    calls,
    activate: async () => ({ activated: true, token: 'tok-1' }),
    verifyKey: async () => ({ valid: true, tier: 'pro', product_id: 'demo', expires_at: null }),
    validate: async () => ({ valid: true }),
    deactivate: async () => ({ deactivated: true }),
    exportOfflineLicense: async (key) => ({ license: { key, tier: 'pro', expires_at: null }, signature: 'sig', key_id: 'k' }),
    getPublicKey: async () => (calls.push('getPublicKey'), 'PUBLIC KEY'),
    verifySignedFile: async () => (calls.push('verifySignedFile'), true),
    refreshKeySet: async (opts) => (calls.push(['refreshKeySet', opts]), { updated: false }),
    ...overrides,
  };
  const licensing = createLicensing({
    createClient: (options) => (created.push(options), client),
    vault,
    state: { get: () => ({}), update: () => {} },
    settings: () => ({ serverUrl, productUuid: PRODUCT }),
    instanceId: () => 'machine-1',
    rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
    builtInKeySets: BUILT_IN,
    keySetStore,
    now: () => Date.now(),
  });
  return { licensing, vault, keySetStore, client, calls, created };
}

describe('on a server with a built-in key set', () => {
  test('one client, built with the root keys, the built-in set and a store for this issuer', async () => {
    const { licensing, created } = setup();
    await licensing.activate('KEY-1');
    await licensing.launchCheck();
    await licensing.verifyOffline();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      baseUrl: `${DEMO}/v1`,
      rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
      keySet: BUILT_IN[DEMO],
    });
    expect(created[0].publicKey).toBeUndefined();
  });

  test('the store keeps each issuer apart, and keeps what is there', async () => {
    const { created, licensing, keySetStore } = setup();
    await keySetStore.set({ 'https://other.example': { payload: 'x' } });
    await licensing.activate('KEY-1');
    const { keySetStore: store } = created[0];
    expect(store.get()).toBeNull();
    await store.set({ payload: 'newer' });
    expect(store.get()).toEqual({ payload: 'newer' });
    expect(keySetStore.get()).toEqual({ 'https://other.example': { payload: 'x' }, [DEMO]: { payload: 'newer' } });
  });

  test('the launch check waits for the current set, and never pins or compares a public key', async () => {
    const { licensing, calls } = setup();
    await licensing.activate('KEY-1');
    calls.length = 0;
    const result = await licensing.launchCheck();
    expect(result).toMatchObject({ state: 'ok', publicKeyChanged: false, keySetUpdated: false });
    expect(calls).toContainEqual(['refreshKeySet', undefined]);
    expect(calls).not.toContain('getPublicKey');
  });

  test('reports a newer set, however the SDK learned of it during the check', async () => {
    const ctx = setup();
    const newer = withSequence(BUILT_IN[DEMO], payloadOf(BUILT_IN[DEMO]).sequence + 1);
    // As if the SDK took it from the export or a background refresh, before
    // the launch check's own refresh call.
    await ctx.licensing.activate('KEY-1');
    ctx.client.verifyKey = async () => {
      await ctx.created[0].keySetStore.set(newer);
      return { valid: true };
    };
    expect((await ctx.licensing.launchCheck()).keySetUpdated).toBe(true);
  });

  test('a built-in set that does not verify: the license is still good, and the error is named', async () => {
    const { licensing } = setup({
      overrides: {
        refreshKeySet: async () => {
          throw new Error('key set: root signature does not verify');
        },
      },
    });
    await licensing.activate('KEY-1');
    expect(await licensing.launchCheck()).toMatchObject({ state: 'ok', keySetError: 'key set: root signature does not verify' });
  });

  test("a saved file that no longer verifies is dropped when a fresh one couldn't be saved", async () => {
    const ctx = setup();
    await ctx.licensing.activate('KEY-1');
    ctx.client.exportOfflineLicense = async () => {
      throw new Error('export failed');
    };
    ctx.client.verifySignedFile = async () => false;
    expect(await ctx.licensing.launchCheck()).toMatchObject({ state: 'ok', offlineFileDropped: true });
    expect(ctx.vault.get().offlineFile).toBeNull();
  });

  test('the offline file is verified by the key-set client, with no public key fetched', async () => {
    const { licensing, calls, created } = setup();
    await licensing.activate('KEY-1');
    calls.length = 0;
    expect(await licensing.verifyOffline()).toMatchObject({ valid: true });
    expect(calls).toEqual(['verifySignedFile']);
    expect(created).toHaveLength(1);
  });

  test('a file the SDK refuses is refused; a check that throws says so', async () => {
    const refused = setup({ overrides: { verifySignedFile: async () => false } });
    await refused.licensing.activate('KEY-1');
    expect(await refused.licensing.verifyOffline()).toMatchObject({ valid: false, reason: 'file_refused' });
    const broken = setup({
      overrides: {
        verifySignedFile: async () => {
          throw new Error('built-in key set does not verify');
        },
      },
    });
    await broken.licensing.activate('KEY-1');
    expect(await broken.licensing.verifyOffline()).toMatchObject({
      valid: false,
      reason: 'verifier_error',
      message: 'built-in key set does not verify',
    });
  });

  test("the seed's public-key fingerprint isn't used", async () => {
    const { licensing, calls } = setup();
    expect(await licensing.seedKeyMatchesServer()).toBeNull();
    expect(calls).not.toContain('getPublicKey');
  });

  test('there is no key to pin', async () => {
    const { licensing } = setup();
    await licensing.activate('KEY-1');
    await expect(licensing.trustNewPublicKey()).rejects.toThrow(/key set/);
    expect(await licensing.checkPublicKeyUnchanged()).toBe(true);
  });

  test('deactivating forgets the license but keeps the key sets', async () => {
    const { licensing, vault, keySetStore } = setup();
    await licensing.activate('KEY-1');
    await keySetStore.set({ [DEMO]: BUILT_IN[DEMO] });
    await licensing.deactivate();
    expect(vault.get()).toBeNull();
    expect(keySetStore.get()).toEqual({ [DEMO]: BUILT_IN[DEMO] });
  });

  test('status shows the set in use: the built-in one, or a newer one seen since', async () => {
    const { licensing, keySetStore } = setup();
    const builtIn = payloadOf(BUILT_IN[DEMO]);
    expect(licensing.status().trust).toMatchObject({
      mode: 'key_set',
      issuer: DEMO,
      sequence: builtIn.sequence,
      activeKeyId: builtIn.keys.find((k) => k.status === 'active').key_id,
    });
    await keySetStore.set({ [DEMO]: withSequence(BUILT_IN[DEMO], builtIn.sequence + 1) });
    expect(licensing.status().trust.sequence).toBe(builtIn.sequence + 1);
    // An older stored set (from an earlier build) doesn't win.
    await keySetStore.set({ [DEMO]: withSequence(BUILT_IN[DEMO], builtIn.sequence - 1) });
    expect(licensing.status().trust.sequence).toBe(builtIn.sequence);
  });
});

describe('on a server with no built-in key set', () => {
  test('the public key is pinned as before', async () => {
    const { licensing, created, calls } = setup({ serverUrl: 'http://localhost:3001/v1' });
    await licensing.activate('KEY-1');
    expect(calls).toContain('getPublicKey');
    expect(created[0].rootKeys).toBeUndefined();
    expect(licensing.status().trust).toEqual({ mode: 'pinned' });
    await licensing.verifyOffline();
    expect(created.some((o) => o.publicKey === 'PUBLIC KEY')).toBe(true);
  });

  test('changing the server URL builds a new client for it', async () => {
    let serverUrl = `${DEMO}/v1`;
    const created = [];
    const licensing = createLicensing({
      createClient: (options) => (created.push(options), { verifyKey: async () => ({}) }),
      vault: memoryStore(),
      state: { get: () => ({}), update: () => {} },
      settings: () => ({ serverUrl, productUuid: PRODUCT }),
      instanceId: () => 'machine-1',
      rootKeys: CASAZIUM_HOSTED_ROOT_KEYS,
      builtInKeySets: BUILT_IN,
      keySetStore: memoryStore(),
    });
    await licensing.activate('KEY-1').catch(() => {});
    serverUrl = 'http://localhost:3001/v1';
    await licensing.activate('KEY-1').catch(() => {});
    expect(created.map((o) => [o.baseUrl, Boolean(o.rootKeys)])).toEqual([
      [`${DEMO}/v1`, true],
      ['http://localhost:3001/v1', false],
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { MAX_DAYS_OFFLINE, createLicensing } from '../main/licensing.js';
import { classifyError, createRecordingFetch, mask } from '../main/calls.js';

const PRODUCT = 'product-uuid-1';
const DAY = 24 * 60 * 60 * 1000;
const httpError = (status, message = 'refused') => Object.assign(new Error(`failed with ${status}: ${message}`), { status });
const offlineFile = (key = 'KEY-1', extra = {}) => ({ license: { key, tier: 'pro', expires_at: '2099-01-01T00:00:00.000Z', ...extra }, signature: 'sig' });

// In-memory stand-ins for the app's storage.
function memory() {
  let record = null;
  let data = {};
  return {
    vault: { get: () => record, set: (v) => (record = v), clear: () => (record = null) },
    state: { get: () => data, update: (patch) => (data = { ...data, ...patch }) },
  };
}

// A fake SDK client; each test overrides what it needs. It records calls.
function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    activate: async (key, id) => (calls.push(['activate', key, id]), { activated: true, token: 'tok-1' }),
    verifyKey: async (key, uuid) => (calls.push(['verifyKey', key, uuid]), { valid: true, tier: 'pro', product_id: 'demo', expires_at: '2099-01-01T00:00:00.000Z' }),
    validate: async () => ({ valid: true }),
    deactivate: async (key, token) => (calls.push(['deactivate', key, token]), { deactivated: true }),
    exportOfflineLicense: async (key) => offlineFile(key),
    getPublicKey: async () => (calls.push(['getPublicKey']), 'PUBLIC KEY'),
    verifySignedFile: async () => true,
    getUsageReport: async () => ({ metrics: [] }),
    trackUsage: async () => ({ ok: true }),
  };
  return Object.assign(client, overrides);
}

function setup(overrides = {}, { now = () => 1_000 * DAY, productUuid = PRODUCT, builtInPublicKey = null } = {}) {
  const store = memory();
  const client = fakeClient(overrides);
  const options = [];
  const licensing = createLicensing({
    createClient: (o) => (options.push(o), client),
    ...store,
    settings: () => ({ serverUrl: 'https://l.example.test/v1', productUuid }),
    instanceId: () => 'machine-1',
    builtInPublicKey,
    now,
  });
  return { licensing, store, client, options };
}

// Activates normally, then swaps in the overrides for what follows.
async function activated(overrides = {}, opts = {}) {
  const ctx = setup({}, opts);
  await ctx.licensing.activate('KEY-1');
  Object.assign(ctx.client, overrides);
  ctx.client.calls.length = 0;
  return ctx;
}

describe('activate', () => {
  test('checks the key, then takes a seat, keeps the token and saves an offline file', async () => {
    const { licensing, store, client } = setup();
    const result = await licensing.activate('  KEY-1  ');
    expect(result.outcome).toBe('activated');
    expect(client.calls.map((c) => c[0]).slice(0, 2)).toEqual(['verifyKey', 'activate']);
    expect(store.vault.get()).toMatchObject({ key: 'KEY-1', token: 'tok-1', publicKey: 'PUBLIC KEY' });
    expect(store.vault.get().offlineFile.signature).toBe('sig');
  });

  test('a key the server refuses takes no seat', async () => {
    const { licensing, store, client } = setup({ verifyKey: async () => Promise.reject(httpError(403, 'License is not active')) });
    expect(await licensing.activate('KEY-1')).toMatchObject({ outcome: 'refused', status: 403 });
    expect(client.calls.some((c) => c[0] === 'activate')).toBe(false);
    expect(store.vault.get()).toBeNull();
  });

  test('a key for another product takes no seat', async () => {
    const mismatch = new Error('verifyKey: license belongs to a different product (product_uuid mismatch)');
    const { licensing, client } = setup({ verifyKey: async () => Promise.reject(mismatch) });
    expect((await licensing.activate('KEY-1')).outcome).toBe('refused');
    expect(client.calls.some((c) => c[0] === 'activate')).toBe(false);
  });

  test('refuses without a product UUID, before calling the server', async () => {
    const { licensing, client } = setup({}, { productUuid: '' });
    await expect(licensing.activate('KEY-1')).rejects.toMatchObject({ code: 'no_product' });
    expect(client.calls).toEqual([]);
  });

  test("gives the seat back if the token can't be stored", async () => {
    const { licensing, store, client } = setup();
    store.vault.set = () => {
      throw new Error('keychain refused');
    };
    await expect(licensing.activate('KEY-1')).rejects.toThrow('keychain refused');
    expect(client.calls.at(-1)).toEqual(['deactivate', 'KEY-1', 'tok-1']);
  });

  test("a failed export doesn't fail the activation", async () => {
    const { licensing, store } = setup({ exportOfflineLicense: async () => Promise.reject(new TypeError('fetch failed')) });
    expect(await licensing.activate('KEY-1')).toMatchObject({ outcome: 'activated', offlineFile: null });
    expect(store.vault.get().token).toBe('tok-1');
  });

  test('already activated with no token: asks for the seat to be freed, saves nothing', async () => {
    const { licensing, store } = setup({ activate: async () => ({ activated: true, alreadyActivated: true }) });
    expect((await licensing.activate('KEY-1')).outcome).toBe('already_activated_without_token');
    expect(store.vault.get()).toBeNull();
  });
});

describe('the launch check', () => {
  test('ok when the license is good and this machine is activated; the file is refreshed', async () => {
    const { licensing, store } = await activated({ exportOfflineLicense: async (key) => offlineFile(key, { tier: 'business' }) });
    expect((await licensing.launchCheck()).state).toBe('ok');
    expect(store.vault.get().offlineFile.license.tier).toBe('business');
  });

  test("seat_freed: the license is good but this machine isn't activated - and the file is dropped", async () => {
    const { licensing, store } = await activated({ validate: async () => ({ valid: false }) });
    expect((await licensing.launchCheck()).state).toBe('seat_freed');
    expect(store.vault.get()).toMatchObject({ key: 'KEY-1', token: null, offlineFile: null });
    expect(licensing.status()).toMatchObject({ hasKey: true, activated: false });
    expect(await licensing.launchCheck({ offline: true })).toMatchObject({ state: 'offline', valid: false, reason: 'no_file' });
  });

  test("refused on a 403 or 404 - and going offline afterwards doesn't undo it", async () => {
    for (const status of [403, 404]) {
      const { licensing } = await activated({ verifyKey: async () => Promise.reject(httpError(status)) });
      expect(await licensing.launchCheck()).toMatchObject({ state: 'refused', status });
      expect(await licensing.launchCheck({ offline: true })).toMatchObject({ valid: false, reason: 'no_file' });
    }
  });

  test('a product mismatch is refused, not "offline"', async () => {
    const mismatch = new Error('verifyKey: license belongs to a different product (product_uuid mismatch)');
    const { licensing } = await activated({ verifyKey: async () => Promise.reject(mismatch) });
    expect((await licensing.launchCheck()).state).toBe('refused');
  });

  test('falls back to the offline file when the server is unreachable, rate limiting or failing', async () => {
    for (const err of [new TypeError('fetch failed'), httpError(429), httpError(503)]) {
      const { licensing } = await activated({ verifyKey: async () => Promise.reject(err) });
      expect(await licensing.launchCheck()).toMatchObject({ state: 'offline', valid: true, daysLeft: MAX_DAYS_OFFLINE });
    }
  });

  test('offline mode skips the network entirely', async () => {
    const { licensing, client } = await activated();
    expect(await licensing.launchCheck({ offline: true })).toMatchObject({ state: 'offline', forced: true, valid: true });
    expect(client.calls).toEqual([]);
  });

  test('builds clients with one retry, not the SDK default', async () => {
    const { licensing, options } = await activated();
    await licensing.launchCheck();
    expect(options.filter((o) => o.baseUrl).every((o) => o.retries === 1)).toBe(true);
  });

  test('no_key before anything is activated', async () => {
    expect((await setup().licensing.launchCheck()).state).toBe('no_key');
  });
});

describe('offline', () => {
  test(`stops working after ${MAX_DAYS_OFFLINE} days without a good online check`, async () => {
    let time = 1_000 * DAY;
    const { licensing } = await activated({}, { now: () => time });
    time += (MAX_DAYS_OFFLINE - 1) * DAY;
    expect(await licensing.verifyOffline()).toMatchObject({ valid: true, daysLeft: 1 });
    time += 2 * DAY;
    expect(await licensing.verifyOffline()).toMatchObject({ valid: false, reason: 'offline_too_long' });
  });

  test('a good online check restarts the offline allowance', async () => {
    let time = 1_000 * DAY;
    const { licensing } = await activated({}, { now: () => time });
    time += 10 * DAY;
    expect((await licensing.launchCheck()).state).toBe('ok');
    time += 10 * DAY;
    expect(await licensing.verifyOffline()).toMatchObject({ valid: true });
  });

  test('a clock that went back asks for an online check instead', async () => {
    let time = 1_000 * DAY;
    const { licensing } = await activated({}, { now: () => time });
    await licensing.verifyOffline();
    time -= DAY;
    expect(await licensing.verifyOffline()).toMatchObject({ valid: false, reason: 'clock_went_back' });
  });

  test('a file for another key is refused, even when it verifies', async () => {
    const { licensing, store } = await activated();
    store.vault.set({ ...store.vault.get(), offlineFile: offlineFile('SOMEONE-ELSES-KEY') });
    expect(await licensing.verifyOffline()).toMatchObject({ valid: false, reason: 'not_this_key' });
  });

  test('a file the SDK rejects is refused', async () => {
    const { licensing } = await activated({ verifySignedFile: async () => false });
    expect(await licensing.verifyOffline()).toMatchObject({ valid: false, reason: 'file_refused' });
  });

  test('is verified with the pinned public key and the product UUID', async () => {
    let seen;
    const { licensing, options } = await activated({ verifySignedFile: async (file, uuid) => ((seen = uuid), true) });
    await licensing.verifyOffline();
    expect(seen).toBe(PRODUCT);
    expect(options.at(-1)).toEqual({ publicKey: 'PUBLIC KEY' });
  });

  test('a public key shipped in the app is used, and never fetched', async () => {
    const { licensing, client, options } = await activated({}, { builtInPublicKey: 'SHIPPED KEY' });
    await licensing.verifyOffline();
    expect(options.at(-1)).toEqual({ publicKey: 'SHIPPED KEY' });
    expect(client.calls.some((c) => c[0] === 'getPublicKey')).toBe(false);
    await expect(licensing.trustNewPublicKey()).rejects.toThrow(/new release/);
  });
});

describe('deactivate', () => {
  test('frees the seat with the token, then forgets the license', async () => {
    const { licensing, store, client } = await activated();
    await licensing.deactivate();
    expect(client.calls).toContainEqual(['deactivate', 'KEY-1', 'tok-1']);
    expect(store.vault.get()).toBeNull();
  });

  test('forgets a license the server no longer has', async () => {
    const { licensing, store } = await activated({ deactivate: async () => Promise.reject(httpError(404, 'License key not found')) });
    expect((await licensing.deactivate()).outcome).toBe('deactivated');
    expect(store.vault.get()).toBeNull();
  });

  test("keeps it when the server can't be reached, so the seat can still be freed", async () => {
    const { licensing, store } = await activated({ deactivate: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(licensing.deactivate()).rejects.toThrow('fetch failed');
    expect(store.vault.get().key).toBe('KEY-1');
  });
});

describe('seats - demo only', () => {
  async function withSeats(limit = 2) {
    const active = new Map();
    let next = 0;
    const ctx = setup({
      activate: async (_key, id) => {
        if (active.has(id)) return { activated: true, alreadyActivated: true };
        if (active.size >= limit) return Promise.reject(httpError(403, 'Activation limit exceeded for this license key'));
        const token = `tok-${++next}`;
        active.set(id, token);
        return { activated: true, token };
      },
      deactivate: async (_key, token) => {
        for (const [id, t] of active) if (t === token) return active.delete(id), { deactivated: true };
        return { deactivated: false };
      },
      validate: async (_key, id) => ({ valid: active.has(id) }),
    });
    await ctx.licensing.activate('KEY-1');
    return { ...ctx, active };
  }

  test('a simulated second machine takes the second seat; a third is refused at the limit', async () => {
    const { licensing, active } = await withSeats();
    expect(await licensing.simulateAnotherMachine()).toMatchObject({ outcome: 'activated', machine: 2 });
    expect([...active.keys()]).toEqual(['machine-1', 'machine-1:machine-2']);
    expect(await licensing.simulateAnotherMachine()).toMatchObject({ outcome: 'refused', machine: 3, message: /limit/ });
    expect(licensing.status().simulatedMachines).toBe(1);
  });

  test('freeing the simulated machines frees their seats and keeps this one', async () => {
    const { licensing, active } = await withSeats();
    await licensing.simulateAnotherMachine();
    expect(await licensing.freeSimulatedMachines()).toEqual({ outcome: 'freed', count: 1 });
    expect([...active.keys()]).toEqual(['machine-1']);
  });

  test("this machine's seat freed elsewhere: seat_freed, and reactivate fixes it", async () => {
    const { licensing } = await withSeats();
    await licensing.simulateAnotherMachine();
    expect(await licensing.freeThisSeatElsewhere()).toEqual({ outcome: 'freed' });
    expect((await licensing.launchCheck()).state).toBe('seat_freed');
    expect((await licensing.reactivate()).outcome).toBe('activated');
    expect((await licensing.launchCheck()).state).toBe('ok');
    expect(licensing.status().simulatedMachines).toBe(1);
  });

  test("freeing this seat reports a token the server didn't recognise", async () => {
    const { licensing, active } = await withSeats();
    active.clear();
    expect(await licensing.freeThisSeatElsewhere()).toEqual({ outcome: 'not_activated' });
  });

  test('deactivate also frees the simulated machines', async () => {
    const { licensing, active } = await withSeats();
    await licensing.simulateAnotherMachine();
    await licensing.deactivate();
    expect(active.size).toBe(0);
  });
});

describe('a changed public key - demo only', () => {
  test('the launch check flags it; trusting the new key re-pins it and replaces the offline file', async () => {
    const { licensing, store, client } = await activated();
    expect((await licensing.launchCheck()).publicKeyChanged).toBe(false);
    client.getPublicKey = async () => 'NEW PUBLIC KEY';
    expect((await licensing.launchCheck()).publicKeyChanged).toBe(true);
    expect((await licensing.trustNewPublicKey()).outcome).toBe('repinned');
    expect(store.vault.get().publicKey).toBe('NEW PUBLIC KEY');
    expect((await licensing.launchCheck()).publicKeyChanged).toBe(false);
  });

  test("a failure fetching the key during the launch check doesn't fail the check", async () => {
    const { licensing, client } = await activated();
    client.getPublicKey = async () => Promise.reject(new TypeError('fetch failed'));
    expect(await licensing.launchCheck()).toMatchObject({ state: 'ok', publicKeyChanged: false });
  });
});

describe("the demo server's seed.json - demo only", () => {
  const SEED = {
    generated_at: '2026-10-16T04:00:00.000Z',
    server_url: 'https://l.example.test/v1',
    product_uuid: PRODUCT,
    public_key_sha256: crypto.createHash('sha256').update('PUBLIC KEY').digest('hex'),
    get_key_url: 'https://buy.stripe.com/test_x',
    keys: {
      revoked: { key: 'REVOKED-KEY-0001', offline_file: offlineFile('REVOKED-KEY-0001') },
      expired: { key: 'EXPIRED-KEY-0002', offline_file: offlineFile('EXPIRED-KEY-0002') },
      business: { key: 'BUSINESS-KEY-0003' },
    },
  };

  function withSeed(overrides = {}, seed = SEED, helperUrl = 'https://demo.example.test') {
    const store = memory();
    const client = fakeClient(overrides);
    const fetched = [];
    const licensing = createLicensing({
      createClient: () => client,
      ...store,
      settings: () => ({ serverUrl: 'https://l.example.test/v1', productUuid: PRODUCT, helperUrl }),
      instanceId: () => 'machine-1',
      fetch: async (url) => (fetched.push(url), new Response(JSON.stringify(seed), { status: 200 })),
    });
    return { licensing, store, client, fetched };
  }

  test('loads seed.json from the helper and says whether it matches the settings', async () => {
    const { licensing, fetched } = withSeed();
    expect(await licensing.loadSeed()).toMatchObject({ loaded: true, matchesSettings: true, kinds: ['revoked', 'expired', 'business'] });
    expect(fetched).toEqual(['https://demo.example.test/seed.json']);
  });

  test('a seed for another server is loaded but marked as not matching', async () => {
    const { licensing } = withSeed({}, { ...SEED, server_url: 'https://other.example.test/v1' });
    expect((await licensing.loadSeed()).matchesSettings).toBe(false);
  });

  test('no helper URL: nothing is fetched and any old seed is dropped', async () => {
    const { licensing, store, fetched } = withSeed({}, SEED, '');
    store.state.update({ seed: SEED });
    expect(await licensing.loadSeed()).toEqual({ loaded: false, reason: 'no_helper' });
    expect(fetched).toEqual([]);
    expect(licensing.seedSummary()).toBeNull();
  });

  test('a malformed seed.json is refused, including a key entry without a key', async () => {
    await expect(withSeed({}, { hello: 'world' }).licensing.loadSeed()).rejects.toThrow(/expected shape/);
    await expect(withSeed({}, { ...SEED, keys: { revoked: { key: 42 } } }).licensing.loadSeed()).rejects.toThrow(/expected shape/);
  });

  test('revoked: refused online, its file still verifies offline; nothing is activated', async () => {
    const { licensing, client } = withSeed({ verifyKey: async () => Promise.reject(httpError(403, 'License is not active')) });
    await licensing.loadSeed();
    expect(await licensing.tryDemoKey('revoked')).toMatchObject({ keyHint: '…0001', online: { state: 'refused', status: 403 }, offline: { valid: true } });
    expect(client.calls.some((c) => c[0] === 'activate')).toBe(false);
  });

  test('business: verified online, with its tier; it has no file', async () => {
    const { licensing } = withSeed({ verifyKey: async () => ({ valid: true, tier: 'business' }) });
    await licensing.loadSeed();
    const result = await licensing.tryDemoKey('business');
    expect(result.online).toMatchObject({ state: 'ok', license: { tier: 'business' } });
    expect(result.offline).toBeNull();
  });

  test('an unknown kind, an inherited name, or no seed is an error', async () => {
    const { licensing } = withSeed();
    await expect(licensing.tryDemoKey('revoked')).rejects.toThrow(/No "revoked" key/);
    await licensing.loadSeed();
    await expect(licensing.tryDemoKey('constructor')).rejects.toThrow(/No "constructor" key/);
  });

  test("the seed's key fingerprint is checked against the server's public key", async () => {
    const good = withSeed();
    await good.licensing.loadSeed();
    expect(await good.licensing.seedKeyMatchesServer()).toBe(true);
    const bad = withSeed({}, { ...SEED, public_key_sha256: 'f'.repeat(64) });
    await bad.licensing.loadSeed();
    expect(await bad.licensing.seedKeyMatchesServer()).toBe(false);
  });
});

describe('classifyError', () => {
  test.each([
    [httpError(400), 'refused'],
    [httpError(403), 'refused'],
    [httpError(404), 'refused'],
    [new Error('verifyKey: license belongs to a different product (product_uuid mismatch)'), 'refused'],
    [httpError(429), 'unreachable'],
    [httpError(500), 'unreachable'],
    [new TypeError('fetch failed'), 'unreachable'],
  ])('%s -> %s', (err, kind) => expect(classifyError(err)).toBe(kind));
});

describe('the recording fetch', () => {
  test('records each call with the key and token masked, and passes the response through', async () => {
    const recorded = [];
    const recordingFetch = createRecordingFetch({
      baseFetch: async () => new Response(JSON.stringify({ activated: true, token: 'secret-token-9999' }), { status: 200 }),
      onCall: (call) => recorded.push(call),
      secrets: () => ['LICENSE-KEY-ABCD'],
    });
    const res = await recordingFetch('https://l.example.test/v1/activate-license', {
      method: 'POST',
      body: JSON.stringify({ key: 'LICENSE-KEY-ABCD', instance_id: 'machine-1' }),
    });
    expect(await res.json()).toEqual({ activated: true, token: 'secret-token-9999' });
    expect(recorded[0].request).toEqual({ key: '****ABCD', instance_id: '****ne-1' });
    expect(recorded[0].response.token).toBe('****9999');
  });

  test('masks a key in the URL path', async () => {
    const recorded = [];
    const recordingFetch = createRecordingFetch({
      baseFetch: async () => new Response('{}', { status: 200 }),
      onCall: (call) => recorded.push(call),
      secrets: () => ['LICENSE-KEY-ABCD'],
    });
    await recordingFetch('https://l.example.test/v1/export-license/LICENSE-KEY-ABCD/offline');
    expect(recorded[0].url).toBe('https://l.example.test/v1/export-license/****ABCD/offline');
  });

  test("doesn't keep a huge response in the log, but passes it through whole", async () => {
    const recorded = [];
    const big = JSON.stringify({ data: 'x'.repeat(100_000) });
    const recordingFetch = createRecordingFetch({ baseFetch: async () => new Response(big, { status: 200 }), onCall: (c) => recorded.push(c) });
    const res = await recordingFetch('https://l.example.test/v1/x');
    expect((await res.text()).length).toBe(big.length);
    expect(recorded[0].response).toMatch(/not shown/);
  });

  test('records a network failure, and still throws it', async () => {
    const recorded = [];
    const recordingFetch = createRecordingFetch({ baseFetch: async () => Promise.reject(new TypeError('fetch failed')), onCall: (c) => recorded.push(c) });
    await expect(recordingFetch('https://l.example.test/v1/verify-license', { method: 'POST', body: '{}' })).rejects.toThrow('fetch failed');
    expect(recorded[0].error).toBe('fetch failed');
  });

  test('mask keeps only the last four characters', () => {
    expect(mask('abcdefgh')).toBe('****efgh');
    expect(mask('abc')).toBe('****');
  });
});

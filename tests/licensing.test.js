import { describe, expect, test } from 'vitest';
import { createLicensing } from '../main/licensing.js';
import { classifyError, createRecordingFetch, mask } from '../main/calls.js';

const PRODUCT = 'product-uuid-1';
const httpError = (status, message = 'refused') => Object.assign(new Error(`failed with ${status}: ${message}`), { status });

// In-memory stand-ins for the app's storage.
function memory() {
  let secret = null;
  let data = {};
  return {
    secrets: { get: () => secret, set: (v) => (secret = v), clear: () => (secret = null) },
    state: { get: () => data, update: (patch) => (data = { ...data, ...patch }) },
  };
}

// A fake SDK client; each test overrides what it needs.
function fakeClient(overrides = {}) {
  return {
    activate: async () => ({ activated: true, token: 'tok-1' }),
    verifyKey: async () => ({ valid: true, tier: 'pro', product_id: 'demo', expires_at: '2099-01-01T00:00:00.000Z' }),
    validate: async () => ({ valid: true }),
    deactivate: async () => ({ deactivated: true }),
    exportOfflineLicense: async () => ({ license: { key: 'k', tier: 'pro', expires_at: '2099-01-01T00:00:00.000Z' }, signature: 'sig' }),
    getPublicKey: async () => 'PUBLIC KEY',
    verifySignedFile: async () => true,
    getUsageReport: async () => ({ metrics: [] }),
    trackUsage: async () => ({ tracked: true }),
    ...overrides,
  };
}

function setup(overrides = {}, { now = () => 1_000_000 } = {}) {
  const store = memory();
  const calls = [];
  const client = fakeClient(overrides);
  const licensing = createLicensing({
    createClient: (options) => {
      calls.push(options);
      return client;
    },
    ...store,
    settings: () => ({ serverUrl: 'https://l.example.test/v1', productUuid: PRODUCT }),
    instanceId: () => 'machine-1',
    now,
  });
  return { licensing, store, calls, client };
}

describe('activate', () => {
  test('keeps the key and token, and saves an offline file straight away', async () => {
    const { licensing, store } = setup();
    const result = await licensing.activate('  KEY-1  ');
    expect(result.outcome).toBe('activated');
    expect(result.license.tier).toBe('pro');
    expect(store.secrets.get()).toEqual({ key: 'KEY-1', token: 'tok-1', simulated: [] });
    expect(store.state.get().offlineFile.signature).toBe('sig');
    expect(store.state.get().publicKey).toBe('PUBLIC KEY');
  });

  test('already activated with no token: asks for the seat to be freed, saves nothing', async () => {
    const { licensing, store } = setup({ activate: async () => ({ activated: true, alreadyActivated: true }) });
    expect((await licensing.activate('KEY-1')).outcome).toBe('already_activated_without_token');
    expect(store.secrets.get()).toBeNull();
  });
});

describe('the launch check', () => {
  // Activates normally, then swaps in the overrides for the launch check.
  async function activated(overrides = {}) {
    const ctx = setup();
    await ctx.licensing.activate('KEY-1');
    Object.assign(ctx.client, overrides);
    return ctx;
  }

  test('ok when the license is good and this machine is activated', async () => {
    const { licensing } = await activated();
    expect((await licensing.launchCheck()).state).toBe('ok');
  });

  test("seat_freed when the license is good but this machine isn't activated any more", async () => {
    const { licensing } = await activated({ validate: async () => ({ valid: false }) });
    expect((await licensing.launchCheck()).state).toBe('seat_freed');
  });

  test('refused on a 403 or 404 - a real answer, not a network problem', async () => {
    const { licensing } = await activated();
    for (const status of [403, 404]) {
      const ctx = await activated({ verifyKey: async () => Promise.reject(httpError(status)) });
      const result = await ctx.licensing.launchCheck();
      expect(result.state).toBe('refused');
      expect(result.status).toBe(status);
    }
    expect((await licensing.launchCheck()).state).toBe('ok');
  });

  test('falls back to the offline file when the server is unreachable, rate limiting or failing', async () => {
    for (const err of [new TypeError('fetch failed'), httpError(429), httpError(503)]) {
      const { licensing } = await activated({ verifyKey: async () => Promise.reject(err) });
      const result = await licensing.launchCheck();
      expect(result.state).toBe('offline');
      expect(result.valid).toBe(true);
    }
  });

  test('offline mode skips the network entirely', async () => {
    let networkCalls = 0;
    const { licensing } = await activated({
      verifyKey: async () => {
        networkCalls += 1;
        return { valid: true };
      },
    });
    networkCalls = 0;
    const result = await licensing.launchCheck({ offline: true });
    expect(result).toMatchObject({ state: 'offline', forced: true, valid: true });
    expect(networkCalls).toBe(0);
  });

  test('no_key before anything is activated', async () => {
    expect((await setup().licensing.launchCheck()).state).toBe('no_key');
  });
});

describe('the offline file', () => {
  test('is verified with the pinned public key and the product UUID', async () => {
    let seen;
    const { licensing, calls } = setup({
      verifySignedFile: async (file, uuid) => {
        seen = { file, uuid };
        return true;
      },
    });
    await licensing.activate('KEY-1');
    expect((await licensing.verifyOffline()).valid).toBe(true);
    expect(seen.uuid).toBe(PRODUCT);
    expect(calls.at(-1)).toEqual({ publicKey: 'PUBLIC KEY' });
  });

  test('warns when the clock has gone backwards since it was last seen', async () => {
    let time = 2_000_000;
    const { licensing } = setup({}, { now: () => time });
    await licensing.activate('KEY-1');
    await licensing.verifyOffline();
    time = 1_000_000;
    expect((await licensing.verifyOffline()).clockWentBack).toBe(true);
  });

  test('says so when there is no file yet', async () => {
    const { licensing, store } = setup();
    store.state.update({ publicKey: 'PUBLIC KEY' });
    expect(await licensing.verifyOffline()).toEqual({ valid: false, reason: 'no_file' });
  });
});

describe('deactivate', () => {
  test('frees the seat with the token, then forgets the key and the file', async () => {
    let freed;
    const { licensing, store } = setup({ deactivate: async (key, token) => (freed = { key, token }) });
    await licensing.activate('KEY-1');
    await licensing.deactivate();
    expect(freed).toEqual({ key: 'KEY-1', token: 'tok-1' });
    expect(store.secrets.get()).toBeNull();
    expect(store.state.get().offlineFile).toBeNull();
  });
});

describe('classifyError', () => {
  test.each([
    [httpError(400), 'refused'],
    [httpError(403), 'refused'],
    [httpError(404), 'refused'],
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
    expect(recorded[0].status).toBe(200);
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

  test('records a network failure, and still throws it', async () => {
    const recorded = [];
    const recordingFetch = createRecordingFetch({
      baseFetch: async () => Promise.reject(new TypeError('fetch failed')),
      onCall: (call) => recorded.push(call),
    });
    await expect(recordingFetch('https://l.example.test/v1/verify-license', { method: 'POST', body: '{}' })).rejects.toThrow('fetch failed');
    expect(recorded[0].error).toBe('fetch failed');
  });

  test('mask keeps only the last four characters', () => {
    expect(mask('abcdefgh')).toBe('****efgh');
    expect(mask('abc')).toBe('****');
  });
});

describe('seats, for the demo', () => {
  async function activatedWithSeats(limit = 2) {
    const active = new Map(); // id -> token
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
        for (const [id, t] of active) if (t === token) active.delete(id);
        return { deactivated: true };
      },
      validate: async (_key, id) => ({ valid: active.has(id) }),
    });
    await ctx.licensing.activate('KEY-1');
    return { ...ctx, active };
  }

  test('a simulated second machine takes the second seat; a third is refused at the limit', async () => {
    const { licensing, active } = await activatedWithSeats();
    expect(await licensing.simulateAnotherMachine()).toMatchObject({ outcome: 'activated', machine: 2 });
    expect([...active.keys()]).toEqual(['machine-1', 'machine-1:machine-2']);
    const third = await licensing.simulateAnotherMachine();
    expect(third).toMatchObject({ outcome: 'refused', machine: 3 });
    expect(third.message).toMatch(/limit/);
    expect(licensing.status().simulatedMachines).toBe(1);
  });

  test('freeing the simulated machines frees their seats and keeps this one', async () => {
    const { licensing, active } = await activatedWithSeats();
    await licensing.simulateAnotherMachine();
    expect(await licensing.freeSimulatedMachines()).toEqual({ outcome: 'freed', count: 1 });
    expect([...active.keys()]).toEqual(['machine-1']);
    expect(licensing.status()).toMatchObject({ activated: true, simulatedMachines: 0 });
  });

  test("this machine's seat freed elsewhere: the launch check says seat_freed, and reactivate fixes it", async () => {
    const { licensing, active } = await activatedWithSeats();
    await licensing.simulateAnotherMachine();
    expect(await licensing.freeThisSeatElsewhere()).toEqual({ outcome: 'freed' });
    expect(active.has('machine-1')).toBe(false);
    expect(licensing.status()).toMatchObject({ hasKey: true, activated: false });
    expect((await licensing.launchCheck()).state).toBe('seat_freed');

    expect((await licensing.reactivate()).outcome).toBe('activated');
    expect((await licensing.launchCheck()).state).toBe('ok');
    // Re-activating kept the simulated machine.
    expect(licensing.status().simulatedMachines).toBe(1);
  });

  test('deactivate also frees the simulated machines', async () => {
    const { licensing, active } = await activatedWithSeats();
    await licensing.simulateAnotherMachine();
    await licensing.deactivate();
    expect(active.size).toBe(0);
  });
});

describe('a changed public key', () => {
  test('the launch check flags it; trusting the new key re-pins it and replaces the offline file', async () => {
    const ctx = setup();
    await ctx.licensing.activate('KEY-1');
    expect((await ctx.licensing.launchCheck()).publicKeyChanged).toBe(false);

    ctx.client.getPublicKey = async () => 'NEW PUBLIC KEY';
    ctx.client.exportOfflineLicense = async () => ({ license: { key: 'k', tier: 'pro' }, signature: 'new-sig' });
    expect((await ctx.licensing.launchCheck()).publicKeyChanged).toBe(true);

    expect((await ctx.licensing.trustNewPublicKey()).outcome).toBe('repinned');
    expect(ctx.store.state.get().publicKey).toBe('NEW PUBLIC KEY');
    expect(ctx.store.state.get().offlineFile.signature).toBe('new-sig');
    expect((await ctx.licensing.launchCheck()).publicKeyChanged).toBe(false);
  });

  test("a failure fetching the key during the launch check doesn't fail the check", async () => {
    const ctx = setup();
    await ctx.licensing.activate('KEY-1');
    ctx.client.getPublicKey = async () => Promise.reject(new TypeError('fetch failed'));
    expect(await ctx.licensing.launchCheck()).toMatchObject({ state: 'ok', publicKeyChanged: false });
  });
});

describe("the demo server's seed.json", () => {
  const SEED = {
    generated_at: '2026-10-16T04:00:00.000Z',
    server_url: 'https://l.example.test/v1',
    product_uuid: PRODUCT,
    public_key_sha256: 'will-be-set',
    get_key_url: 'https://buy.stripe.com/test_x',
    keys: {
      revoked: { key: 'REVOKED-KEY-0001', offline_file: { license: { key: 'r', expires_at: '2099-01-01T00:00:00Z' }, signature: 's' } },
      expired: { key: 'EXPIRED-KEY-0002', offline_file: { license: { key: 'e', expires_at: '2000-01-01T00:00:00Z' }, signature: 's' } },
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
      fetch: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify(seed), { status: 200 });
      },
    });
    return { licensing, store, client, fetched };
  }

  test('loads seed.json from the helper and says whether it matches the settings', async () => {
    const { licensing, fetched } = withSeed();
    const result = await licensing.loadSeed();
    expect(fetched).toEqual(['https://demo.example.test/seed.json']);
    expect(result).toMatchObject({ loaded: true, matchesSettings: true, getKeyUrl: 'https://buy.stripe.com/test_x', kinds: ['revoked', 'expired', 'business'] });
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

  test('a malformed seed.json is refused', async () => {
    const { licensing } = withSeed({}, { hello: 'world' });
    await expect(licensing.loadSeed()).rejects.toThrow(/expected shape/);
  });

  test('revoked: refused online, its file still verifies offline; nothing is activated', async () => {
    let activated = false;
    const { licensing } = withSeed({
      verifyKey: async () => Promise.reject(httpError(403, 'License is not active')),
      verifySignedFile: async (file) => file.license.key === 'r',
      activate: async () => {
        activated = true;
        return { token: 't' };
      },
    });
    await licensing.loadSeed();
    const result = await licensing.tryDemoKey('revoked');
    expect(result).toMatchObject({ kind: 'revoked', keyHint: '…0001', online: { state: 'refused', status: 403 }, offline: { valid: true } });
    expect(activated).toBe(false);
  });

  test('business: verified online, with its tier; it has no file', async () => {
    const { licensing } = withSeed({ verifyKey: async () => ({ valid: true, tier: 'business', product_id: 'casazium-demo' }) });
    await licensing.loadSeed();
    const result = await licensing.tryDemoKey('business');
    expect(result.online).toMatchObject({ state: 'ok', license: { tier: 'business' } });
    expect(result.offline).toBeNull();
  });

  test('an unknown kind, or no seed, is an error', async () => {
    const { licensing } = withSeed();
    await expect(licensing.tryDemoKey('revoked')).rejects.toThrow(/No "revoked" key/);
  });

  test("the seed's key fingerprint is checked against the server's public key", async () => {
    const crypto = await import('node:crypto');
    const digest = crypto.createHash('sha256').update('PUBLIC KEY').digest('hex');
    const good = withSeed({}, { ...SEED, public_key_sha256: digest });
    await good.licensing.loadSeed();
    expect(await good.licensing.seedKeyMatchesServer()).toBe(true);
    const bad = withSeed({}, { ...SEED, public_key_sha256: 'f'.repeat(64) });
    await bad.licensing.loadSeed();
    expect(await bad.licensing.seedKeyMatchesServer()).toBe(false);
  });
});

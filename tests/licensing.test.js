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
    expect(store.secrets.get()).toEqual({ key: 'KEY-1', token: 'tok-1' });
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

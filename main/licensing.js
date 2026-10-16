// All of the app's licensing, in one place and free of Electron, so it
// can be read on its own and tested. main.js wires it to Electron:
// storage, the machine id and the fetch.
//
// The four moments from the desktop guide:
//   activate()     - once per machine; keeps the activation token
//   launchCheck()  - once per start: is the license good, and is THIS
//                    machine still activated on it?
//   offline        - when the server can't be reached, a signed license
//                    file verified with the public key alone, for at most
//                    MAX_DAYS_OFFLINE since the last good online check
//   deactivate()   - frees this machine's seat, so the key can move
//
// Sections marked DEMO ONLY exist to show several machines, or keys in
// states you can't reach yourself, from one computer. A real app leaves
// them out.

import crypto from 'node:crypto';
import { classifyError } from './calls.js';

// How long the app keeps working without reaching the server. The offline
// file's own expiry is the license's (a perpetual license's file never
// expires), so it can't be the limit: without one, a revoked user could
// stay offline forever. Choose your own; 14 days covers a holiday.
export const MAX_DAYS_OFFLINE = 14;
const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {(options: object) => object} deps.createClient - builds an SDK client
 * @param {object} deps.vault - encrypted storage for everything the license
 *   decision depends on: { get(): object | null, set(object), clear() }.
 *   In the app it's safeStorage (the OS keychain), so editing a file on disk
 *   can't forge a pass.
 * @param {object} deps.state - plain storage for things that aren't secret
 *   (the demo's seed.json): { get(): object, update(patch) }
 * @param {() => {serverUrl: string, productUuid: string, helperUrl?: string}} deps.settings
 * @param {() => string} deps.instanceId - this machine's id for this app
 * @param {string|null} [deps.builtInPublicKey] - your server's public key,
 *   shipped in the app: what a real app should do. When it's null (this
 *   demo, whose server is configurable) the key is fetched once and pinned.
 * @param {typeof fetch} [deps.fetch] - for the demo helper's seed.json
 * @param {() => number} [deps.now]
 */
export function createLicensing({
  createClient,
  vault,
  state,
  settings,
  instanceId,
  builtInPublicKey = null,
  fetch = globalThis.fetch,
  now = () => Date.now(),
}) {
  // One retry, not the SDK's default three: with a 5-second timeout per
  // attempt, a server that doesn't answer would otherwise hold up the
  // launch check for 20 seconds before the offline fallback.
  const client = () => createClient({ baseUrl: settings().serverUrl, retries: 1 });
  const productUuid = () => settings().productUuid;

  const record = () => vault.get();
  const update = (patch) => vault.set({ ...record(), ...patch });

  function requireKey() {
    const saved = record();
    if (!saved?.key) throw Object.assign(new Error('No license key on this machine yet'), { code: 'no_key' });
    return saved;
  }

  function requireProduct() {
    if (!productUuid()) {
      throw Object.assign(new Error("Set the product UUID first: it's how the app knows a license is for this product"), {
        code: 'no_product',
      });
    }
  }

  // --- The public key ---------------------------------------------------
  // Offline files are verified with the server's public key. A real app
  // ships it (builtInPublicKey). This demo can point at any server, so it
  // fetches the key once and pins it in the vault - DEMO ONLY: trusting a
  // key on first use is weaker than shipping it.
  async function publicKey() {
    if (builtInPublicKey) return builtInPublicKey;
    const pinned = record()?.publicKey;
    if (pinned) return pinned;
    const fetched = await client().getPublicKey();
    update({ publicKey: fetched });
    return fetched;
  }

  async function checkPublicKeyUnchanged() {
    const expected = builtInPublicKey ?? record()?.publicKey;
    if (!expected) return true;
    return (await client().getPublicKey()) === expected;
  }

  // DEMO ONLY: accept a changed server key (a rebuilt demo server). A real
  // app that ships its key gets a new key only with a new release.
  async function trustNewPublicKey() {
    if (builtInPublicKey) throw new Error('This app ships its public key; a new key comes with a new release');
    update({ publicKey: await client().getPublicKey() });
    const file = await exportOffline();
    return { outcome: 'repinned', offlineFile: file };
  }

  // --- The offline file -----------------------------------------------

  async function exportOffline() {
    const { key } = requireKey();
    const file = await client().exportOfflineLicense(key);
    await publicKey();
    update({ offlineFile: file });
    return describeFile(file);
  }

  /**
   * Verifies the saved offline file with the public key alone - no network.
   * Valid only when:
   *  - the file is for this key and this product, signed by the server, and
   *    not expired (verifySignedFile);
   *  - the last good online check was at most MAX_DAYS_OFFLINE ago;
   *  - the clock hasn't gone back since the app last ran. Rolling the clock
   *    back is the usual way to stretch an expiry, so then the app asks for
   *    an online check instead. This deters casual tampering; it isn't
   *    protection against someone who controls the machine.
   */
  async function verifyOffline() {
    const saved = record();
    if (!saved?.offlineFile) return { valid: false, reason: 'no_file' };
    const current = now();
    const lastSeenAt = saved.lastSeenAt ?? 0;
    if (current < lastSeenAt) return { valid: false, reason: 'clock_went_back' };
    update({ lastSeenAt: current });

    if (saved.offlineFile.license?.key !== saved.key) return { valid: false, reason: 'not_this_key' };
    const key = await publicKey().catch(() => null);
    if (!key) return { valid: false, reason: 'no_public_key' };
    if (!(await createClient({ publicKey: key }).verifySignedFile(saved.offlineFile, productUuid()))) {
      return { valid: false, reason: 'file_refused', file: describeFile(saved.offlineFile) };
    }
    const offlineFor = current - (saved.lastCheckedAt ?? 0);
    const daysLeft = Math.floor((MAX_DAYS_OFFLINE * DAY - offlineFor) / DAY);
    if (daysLeft < 0) return { valid: false, reason: 'offline_too_long', file: describeFile(saved.offlineFile) };
    return { valid: true, daysLeft, file: describeFile(saved.offlineFile) };
  }

  // --- Activation -----------------------------------------------------

  async function activate(key) {
    requireProduct();
    const trimmed = key.trim();
    // Check the key before taking a seat: a key for another product, or a
    // revoked one, shouldn't use up a machine.
    let license;
    try {
      license = await client().verifyKey(trimmed, productUuid());
    } catch (err) {
      if (classifyError(err) === 'refused') return { outcome: 'refused', message: err.message, status: err.status ?? null };
      throw err;
    }
    const result = await client().activate(trimmed, instanceId());
    if (result.alreadyActivated && !result.token) {
      // Activated on this machine before, but the token was lost (a
      // reinstall, cleared storage). The token is returned only once, so
      // the seat has to be freed - from the license portal - and the
      // machine activated again.
      return { outcome: 'already_activated_without_token' };
    }
    const previous = record();
    try {
      vault.set({
        key: trimmed,
        token: result.token,
        lastCheckedAt: now(),
        lastSeenAt: now(),
        // Same key: keep the pinned key and the demo's simulated machines.
        publicKey: previous?.key === trimmed ? previous.publicKey : previous?.publicKey,
        simulated: previous?.key === trimmed ? previous.simulated ?? [] : [],
      });
    } catch (err) {
      // Couldn't store the token: give the seat back now, while we still
      // have it, rather than leave a seat nobody can free.
      await client().deactivate(trimmed, result.token).catch(() => {});
      throw err;
    }
    // Saved straight away, so the app keeps working if the network goes.
    // A failure here isn't a failed activation: the next launch check
    // tries again.
    const offlineFile = await exportOffline().catch(() => null);
    return { outcome: 'activated', license: describeLicense(license), offlineFile };
  }

  // Activates this machine again with the stored key - after its seat
  // was freed elsewhere. The page never sees the full key, so it asks for
  // this rather than calling activate(key).
  async function reactivate() {
    return activate(requireKey().key);
  }

  /**
   * Once per start, never on a timer.
   * @returns {Promise<object>} state:
   *   ok          - license good, this machine activated
   *   seat_freed  - license good, but this machine's seat was freed elsewhere
   *   refused     - the server says no: revoked, expired or unknown key
   *   offline     - no usable answer; the offline file decides (`valid`)
   *   no_key      - nothing activated on this machine
   */
  async function launchCheck({ offline = false } = {}) {
    if (!record()?.key) return { state: 'no_key' };
    if (offline) return { state: 'offline', forced: true, ...(await verifyOffline()) };
    requireProduct();
    const { key } = record();
    try {
      const license = await client().verifyKey(key, productUuid());
      const { valid } = await client().validate(key, instanceId());
      if (!valid) {
        // Not activated here any more: the token is no use now, and the
        // offline file mustn't keep the app working either. The key stays,
        // so the machine can be activated again.
        update({ offlineFile: null, token: null });
        return { state: 'seat_freed', license: describeLicense(license) };
      }
      update({ lastCheckedAt: now(), lastSeenAt: Math.max(now(), record().lastSeenAt ?? 0) });
      // Refresh the file, so its expiry and terms follow the server's.
      await exportOffline().catch(() => {});
      // The server answered, so this is the time to notice a changed
      // signing key, before an offline check relies on the old one.
      const publicKeyChanged = !(await checkPublicKeyUnchanged().catch(() => true));
      return { state: 'ok', license: describeLicense(license), publicKeyChanged };
    } catch (err) {
      if (classifyError(err) === 'refused') {
        // A real answer - revoked, expired, unknown key. Drop the offline
        // file, or going offline would undo the refusal.
        update({ offlineFile: null });
        return { state: 'refused', message: err.message, status: err.status ?? null };
      }
      return { state: 'offline', message: err.message, ...(await verifyOffline()) };
    }
  }

  // Frees this machine's seat and forgets the license. If the server says
  // the license or activation no longer exists (refused), there's no seat
  // to free: forget it anyway. Only a server that can't be reached keeps
  // it, so the seat can still be freed later.
  async function deactivate() {
    const { key, token, simulated = [] } = requireKey();
    const free = async (t) => {
      try {
        await client().deactivate(key, t);
      } catch (err) {
        if (classifyError(err) !== 'refused') throw err;
      }
    };
    for (const machine of simulated) await free(machine.token).catch(() => {});
    if (token) await free(token);
    vault.clear();
    return { outcome: 'deactivated' };
  }

  // --- Usage ------------------------------------------------------------

  async function usage() {
    const { key } = requireKey();
    return client().getUsageReport(key);
  }

  async function trackUsage(metric) {
    const { key, token } = requireKey();
    return client().trackUsage(key, token, metric, 1);
  }

  function status() {
    let saved;
    try {
      saved = record();
    } catch (err) {
      return { hasKey: false, storageError: err.message, instanceId: instanceId() };
    }
    return {
      hasKey: Boolean(saved?.key),
      keyHint: saved?.key ? `…${saved.key.slice(-4)}` : null,
      activated: Boolean(saved?.token),
      simulatedMachines: (saved?.simulated ?? []).length,
      offlineFile: saved?.offlineFile ? describeFile(saved.offlineFile) : null,
      lastCheckedAt: saved?.lastCheckedAt ?? null,
      maxDaysOffline: MAX_DAYS_OFFLINE,
      instanceId: instanceId(),
    };
  }

  // --- Seats - DEMO ONLY ------------------------------------------------
  // A real app activates once, as itself. These let one machine show what
  // happens on several: other machines taking seats, the limit, and this
  // machine's seat being freed from somewhere else.

  // Activates the key under another machine id, as a second (then third)
  // computer would. The demo license allows two machines, so the third
  // is refused by the server.
  async function simulateAnotherMachine() {
    const saved = requireKey();
    const simulated = saved.simulated ?? [];
    const machine = simulated.length + 2;
    const id = `${instanceId()}:machine-${machine}`;
    try {
      const result = await client().activate(saved.key, id);
      if (!result.token) return { outcome: 'already_activated_without_token', machine };
      update({ simulated: [...(record().simulated ?? []), { id, token: result.token }] });
      return { outcome: 'activated', machine };
    } catch (err) {
      if (classifyError(err) === 'refused') return { outcome: 'refused', machine, message: err.message };
      throw err;
    }
  }

  async function freeSimulatedMachines() {
    const saved = requireKey();
    const simulated = saved.simulated ?? [];
    for (const machine of simulated) {
      await client()
        .deactivate(saved.key, machine.token)
        .catch((err) => {
          if (classifyError(err) !== 'refused') throw err;
        });
    }
    update({ simulated: [] });
    return { outcome: 'freed', count: simulated.length };
  }

  // Frees this machine's seat as the license portal or another machine
  // would - with this machine's token - but keeps the key stored here, so
  // the next launch check finds the license good and this machine no
  // longer activated: the case validate() exists to catch.
  async function freeThisSeatElsewhere() {
    const saved = requireKey();
    if (!saved.token) return { outcome: 'not_activated' };
    const result = await client().deactivate(saved.key, saved.token);
    if (result?.deactivated === false) return { outcome: 'not_activated' };
    update({ token: null });
    return { outcome: 'freed' };
  }

  // --- The demo server's seed.json - DEMO ONLY ---------------------------
  // The demo helper publishes keys a visitor can't create on their own -
  // revoked, expired, a higher tier - with offline files exported before
  // they were revoked or backdated. They're only ever verified, never
  // activated: they're shared by everyone trying the demo.

  async function loadSeed() {
    const helperUrl = settings().helperUrl;
    if (!helperUrl) {
      state.update({ seed: null });
      return { loaded: false, reason: 'no_helper' };
    }
    const res = await fetch(`${helperUrl.replace(/\/$/, '')}/seed.json`);
    if (!res.ok) throw Object.assign(new Error(`seed.json: the demo helper answered ${res.status}`), { status: res.status });
    const seed = await res.json();
    const keysOk =
      seed?.keys && typeof seed.keys === 'object' && Object.values(seed.keys).every((entry) => typeof entry?.key === 'string');
    if (typeof seed?.server_url !== 'string' || typeof seed?.product_uuid !== 'string' || !keysOk) {
      throw new Error("seed.json isn't in the expected shape");
    }
    state.update({ seed });
    return { loaded: true, ...describeSeed(seed) };
  }

  function describeSeed(seed) {
    return {
      serverUrl: seed.server_url,
      productUuid: seed.product_uuid,
      generatedAt: seed.generated_at,
      getKeyUrl: seed.get_key_url ?? null,
      kinds: Object.keys(seed.keys ?? {}),
      // The seed is for one server; pointed at another, its keys mean nothing.
      matchesSettings: seed.server_url === settings().serverUrl && seed.product_uuid === settings().productUuid,
    };
  }

  function seedSummary() {
    const seed = state.get().seed;
    return seed ? describeSeed(seed) : null;
  }

  // The helper publishes a fingerprint of the server's public key, from a
  // separate host: a second way to notice the app is talking to a
  // different server than the demo's.
  async function seedKeyMatchesServer() {
    const seed = state.get().seed;
    if (!seed?.public_key_sha256) return null;
    const serverKey = await client().getPublicKey();
    return crypto.createHash('sha256').update(serverKey).digest('hex') === seed.public_key_sha256;
  }

  /**
   * Checks a seeded key online (verifyKey) and, if the seed has one, its
   * offline file (verifySignedFile). Never activates it.
   */
  async function tryDemoKey(kind) {
    const seed = state.get().seed;
    const entry = seed?.keys && Object.hasOwn(seed.keys, kind) ? seed.keys[kind] : null;
    if (!entry) throw Object.assign(new Error(`No "${kind}" key in seed.json`), { code: 'no_seed' });
    let online;
    try {
      const license = await client().verifyKey(entry.key, seed.product_uuid);
      online = { state: 'ok', license: describeLicense(license) };
    } catch (err) {
      online =
        classifyError(err) === 'refused'
          ? { state: 'refused', status: err.status ?? null, message: err.message }
          : { state: 'unreachable', message: err.message };
    }
    let offline = null;
    if (entry.offline_file) {
      const offlineClient = createClient({ publicKey: await publicKey() });
      offline = {
        valid: await offlineClient.verifySignedFile(entry.offline_file, seed.product_uuid),
        file: describeFile(entry.offline_file),
      };
    }
    return { kind, keyHint: `…${entry.key.slice(-4)}`, online, offline };
  }

  return {
    activate,
    reactivate,
    launchCheck,
    deactivate,
    exportOffline,
    verifyOffline,
    usage,
    trackUsage,
    status,
    checkPublicKeyUnchanged,
    trustNewPublicKey,
    simulateAnotherMachine,
    freeSimulatedMachines,
    freeThisSeatElsewhere,
    loadSeed,
    seedSummary,
    seedKeyMatchesServer,
    tryDemoKey,
  };
}

function describeLicense(license) {
  return {
    tier: license.tier ?? null,
    productId: license.product_id ?? null,
    expiresAt: license.expires_at ?? null,
    limits: license.limits ?? null,
    status: license.status ?? null,
  };
}

function describeFile(file) {
  const license = file?.license ?? {};
  return { tier: license.tier ?? null, expiresAt: license.expires_at ?? null };
}

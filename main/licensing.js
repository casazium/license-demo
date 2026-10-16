// All of the app's licensing, in one place and free of Electron, so it
// can be read on its own and tested. main.js wires it to Electron:
// storage, the machine id and the fetch.
//
// The four moments from the desktop guide:
//   activate()     - once per machine; keeps the activation token
//   launchCheck()  - once per start: is the license good, and is THIS
//                    machine still activated on it?
//   offline        - a signed license file, verified with the public key
//                    alone, when the server can't be reached
//   deactivate()   - frees this machine's seat, so the key can move

import { classifyError } from './calls.js';

/**
 * @param {object} deps
 * @param {(options: object) => object} deps.createClient - builds an SDK client
 * @param {object} deps.secrets - { get(): {key, token} | null, set({key, token}), clear() }
 * @param {object} deps.state - { get(): object, update(patch) } for non-secret data
 * @param {() => {serverUrl: string, productUuid: string}} deps.settings
 * @param {() => string} deps.instanceId - this machine's id for this app
 * @param {() => number} [deps.now]
 */
export function createLicensing({ createClient, secrets, state, settings, instanceId, now = () => Date.now() }) {
  const client = () => createClient({ baseUrl: settings().serverUrl });
  const productUuid = () => settings().productUuid;

  function requireKey() {
    const saved = secrets.get();
    if (!saved?.key) throw Object.assign(new Error('No license key on this machine yet'), { code: 'no_key' });
    return saved;
  }

  // The server's public key, fetched once and pinned. A different key
  // later means a different server (or a server rebuilt with new keys),
  // and an offline file signed by one won't verify with the other.
  async function publicKey() {
    const pinned = state.get().publicKey;
    if (pinned) return pinned;
    const fetched = await client().getPublicKey();
    state.update({ publicKey: fetched });
    return fetched;
  }

  async function checkPublicKeyUnchanged() {
    const pinned = state.get().publicKey;
    if (!pinned) return true;
    return (await client().getPublicKey()) === pinned;
  }

  // After the server's key really did change (a rebuilt server, a
  // rotated key): pin the new one, and replace the offline file, which
  // was signed with the old key and won't verify any more.
  async function trustNewPublicKey() {
    state.update({ publicKey: await client().getPublicKey() });
    const file = await exportOffline();
    return { outcome: 'repinned', offlineFile: file };
  }

  async function exportOffline() {
    const { key } = requireKey();
    const file = await client().exportOfflineLicense(key);
    await publicKey();
    state.update({ offlineFile: file });
    return describeFile(file);
  }

  // Verifies the saved offline file with the public key alone - no
  // network. Its expiry is checked against this machine's clock, so the
  // app remembers the latest time it has seen and warns if the clock has
  // gone backwards (the usual way to stretch an expired file).
  async function verifyOffline() {
    const { offlineFile, publicKey: pinned, lastSeenAt } = state.get();
    if (!offlineFile) return { valid: false, reason: 'no_file' };
    if (!pinned) return { valid: false, reason: 'no_public_key' };
    const current = now();
    const clockWentBack = typeof lastSeenAt === 'number' && current < lastSeenAt;
    if (!clockWentBack) state.update({ lastSeenAt: current });
    const offlineClient = createClient({ publicKey: pinned });
    const valid = await offlineClient.verifySignedFile(offlineFile, productUuid());
    return { valid, clockWentBack, file: describeFile(offlineFile) };
  }

  async function activate(key) {
    const trimmed = key.trim();
    const result = await client().activate(trimmed, instanceId());
    if (result.alreadyActivated && !result.token) {
      // Activated on this machine before, but the token was lost (a
      // reinstall, cleared storage). The token is returned only once, so
      // the seat has to be freed - from the license portal - and the
      // machine activated again.
      return { outcome: 'already_activated_without_token' };
    }
    // Re-activating the same key keeps the demo's simulated machines.
    const previous = secrets.get();
    secrets.set({ key: trimmed, token: result.token, simulated: previous?.key === trimmed ? previous.simulated ?? [] : [] });
    const license = await client().verifyKey(trimmed, productUuid());
    // Saved straight away, so the app keeps working if the network goes.
    const file = await exportOffline();
    return { outcome: 'activated', license: describeLicense(license), offlineFile: file };
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
   *   offline     - no answer from the server; the offline file decides
   *   no_key      - nothing activated on this machine
   */
  async function launchCheck({ offline = false } = {}) {
    if (!secrets.get()?.key) return { state: 'no_key' };
    if (offline) return { state: 'offline', forced: true, ...(await verifyOffline()) };
    const { key } = secrets.get();
    try {
      const license = await client().verifyKey(key, productUuid());
      const { valid } = await client().validate(key, instanceId());
      state.update({ lastCheckedAt: now() });
      // The server answered, so this is the time to notice a changed
      // signing key, before an offline check relies on the old one.
      const publicKeyChanged = !(await checkPublicKeyUnchanged().catch(() => true));
      if (!valid) return { state: 'seat_freed', license: describeLicense(license), publicKeyChanged };
      return { state: 'ok', license: describeLicense(license), publicKeyChanged };
    } catch (err) {
      if (classifyError(err) === 'refused') return { state: 'refused', message: err.message, status: err.status };
      return { state: 'offline', message: err.message, ...(await verifyOffline()) };
    }
  }

  async function deactivate() {
    const { key, token, simulated = [] } = requireKey();
    for (const machine of simulated) await client().deactivate(key, machine.token).catch(() => {});
    if (token) await client().deactivate(key, token);
    secrets.clear();
    state.update({ offlineFile: null });
    return { outcome: 'deactivated' };
  }

  // --- Seats, for the demo -------------------------------------------
  // A real app activates once, as itself. These let one machine show
  // what happens on several: other machines taking seats, the limit,
  // and this machine's seat being freed from somewhere else.

  // Activates the key under another machine id, as a second (then third)
  // computer would. The demo license allows two machines, so the third
  // is refused by the server.
  async function simulateAnotherMachine() {
    const saved = requireKey();
    const simulated = saved.simulated ?? [];
    const id = `${instanceId()}:machine-${simulated.length + 2}`;
    try {
      const result = await client().activate(saved.key, id);
      if (!result.token) return { outcome: 'already_activated_without_token', machine: simulated.length + 2 };
      secrets.set({ ...saved, simulated: [...simulated, { id, token: result.token }] });
      return { outcome: 'activated', machine: simulated.length + 2, machines: simulated.length + 2 };
    } catch (err) {
      if (classifyError(err) === 'refused') return { outcome: 'refused', machine: simulated.length + 2, message: err.message };
      throw err;
    }
  }

  async function freeSimulatedMachines() {
    const saved = requireKey();
    for (const machine of saved.simulated ?? []) await client().deactivate(saved.key, machine.token);
    secrets.set({ ...saved, simulated: [] });
    return { outcome: 'freed', count: (saved.simulated ?? []).length };
  }

  // Frees this machine's seat as the license portal or another machine
  // would - with this machine's token - but keeps the key stored here, so
  // the next launch check finds the license good and this machine no
  // longer activated: the case validate() exists to catch.
  async function freeThisSeatElsewhere() {
    const saved = requireKey();
    if (!saved.token) return { outcome: 'not_activated' };
    await client().deactivate(saved.key, saved.token);
    secrets.set({ ...saved, token: null });
    return { outcome: 'freed' };
  }

  async function usage() {
    const { key } = requireKey();
    return client().getUsageReport(key);
  }

  async function trackUsage(metric) {
    const { key, token } = requireKey();
    return client().trackUsage(key, token, metric, 1);
  }

  function status() {
    const saved = secrets.get();
    const { offlineFile, lastCheckedAt } = state.get();
    return {
      hasKey: Boolean(saved?.key),
      keyHint: saved?.key ? `…${saved.key.slice(-4)}` : null,
      activated: Boolean(saved?.token),
      simulatedMachines: (saved?.simulated ?? []).length,
      offlineFile: offlineFile ? describeFile(offlineFile) : null,
      lastCheckedAt: lastCheckedAt ?? null,
      instanceId: instanceId(),
    };
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
  return { tier: license.tier ?? null, expiresAt: license.expires_at ?? null, issuedAt: license.issued_at ?? null };
}

// Where the app keeps things.
//
// The vault holds everything the license decision depends on - the key,
// the activation token, the offline license file (which contains the key),
// the pinned public key, and when the app last checked online - encrypted
// with safeStorage (the OS keychain on macOS and Windows). Editing a file
// on disk can't forge a pass, and the key isn't readable on disk.
//
// Plain JSON in the app's user-data folder holds only the settings and the
// demo server's seed.json, which is public.
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const file = (name) => path.join(app.getPath('userData'), name);

// Write to a temporary file, then rename over the old one: a crash halfway
// through leaves the old file, never a torn one.
function writeAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
}

function jsonFile(name, defaults) {
  const read = () => {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file(name), 'utf8')) };
    } catch {
      return { ...defaults };
    }
  };
  const write = (value) => writeAtomic(file(name), JSON.stringify(value, null, 2));
  return { get: read, update: (patch) => write({ ...read(), ...patch }), replace: write };
}

export const state = jsonFile('state.json', { seed: null });

// The Casazium demo server, so the app works as soon as it's installed.
// The product UUID comes from the demo helper's seed.json at start; point
// the app at your own server in its Server settings.
export const DEFAULT_SETTINGS = {
  serverUrl: 'https://demo-license-api.casazium.com/v1',
  productUuid: '',
  // The demo server's helper, which publishes seed.json. Empty for any
  // other server.
  helperUrl: 'https://demo-license.casazium.com',
};
export const settings = jsonFile('settings.json', DEFAULT_SETTINGS);

// On Linux without a secret service, safeStorage falls back to a backend
// that encrypts with a fixed password - stored, but not protected. The
// app says so instead of claiming keychain storage.
export async function secretStorageProtected() {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  if (process.platform !== 'linux') return true;
  return safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

const vaultFile = () => file('license.bin');

// safeStorage encrypts and decrypts asynchronously (its synchronous
// methods are deprecated in Electron 45 and removed in 46). The vault is
// decrypted once, at start (load), and kept in memory, so reading it stays
// synchronous. A write is encrypted and saved before the copy in memory
// changes, and callers await it, so a failed save is never mistaken for a
// saved one. Writes run one at a time, in order.
let current; // undefined until load(); null when nothing is stored
let unreadable = null;
let writes = Promise.resolve();

const unreadableError = () =>
  Object.assign(new Error("The stored license can't be read (the system keychain refused, or the file is damaged)"), {
    code: 'vault_unreadable',
  });

export const vault = {
  // Call once, after the app is ready and before anything reads the vault.
  // Never throws: a vault that exists but can't be read makes get() throw
  // rather than look like "no license".
  async load() {
    current = undefined;
    unreadable = null;
    let encrypted;
    try {
      encrypted = fs.readFileSync(vaultFile());
    } catch (err) {
      if (err.code === 'ENOENT') {
        current = null;
        return;
      }
      unreadable = err;
      return;
    }
    let decrypted;
    try {
      decrypted = await safeStorage.decryptStringAsync(encrypted);
      current = JSON.parse(decrypted.result);
    } catch {
      unreadable = unreadableError();
      return;
    }
    // The keychain's key has changed (rotated, or a stronger one is now
    // available): save it again under the new one. If that fails, the old
    // file still decrypts, so carry on.
    if (decrypted.shouldReEncrypt) await vault.set(current).catch(() => {});
  },
  // null when nothing is stored. A copy, so changing it changes nothing.
  get() {
    if (unreadable) throw unreadable;
    if (current === undefined) throw new Error('The vault was read before it was loaded');
    return current === null ? null : structuredClone(current);
  },
  set(value) {
    const copy = structuredClone(value);
    const write = writes.then(async () => {
      writeAtomic(vaultFile(), await safeStorage.encryptStringAsync(JSON.stringify(copy)));
      current = copy;
      unreadable = null;
    });
    writes = write.catch(() => {});
    return write;
  },
  clear() {
    const write = writes.then(() => {
      fs.rmSync(vaultFile(), { force: true });
      current = null;
      unreadable = null;
    });
    writes = write.catch(() => {});
    return write;
  },
};

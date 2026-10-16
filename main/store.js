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
export function secretStorageProtected() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  return safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

const vaultFile = () => file('license.bin');

export const vault = {
  // null when nothing is stored. A vault that exists but can't be read
  // (the keychain refused, or the file is damaged) throws rather than
  // looking like "no license".
  get() {
    let encrypted;
    try {
      encrypted = fs.readFileSync(vaultFile());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(safeStorage.decryptString(encrypted));
    } catch {
      throw Object.assign(new Error("The stored license can't be read (the system keychain refused, or the file is damaged)"), {
        code: 'vault_unreadable',
      });
    }
  },
  set(value) {
    writeAtomic(vaultFile(), safeStorage.encryptString(JSON.stringify(value)));
  },
  clear() {
    fs.rmSync(vaultFile(), { force: true });
  },
};

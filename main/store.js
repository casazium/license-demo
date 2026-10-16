// Where the app keeps things. The license key and activation token go in
// safeStorage (the OS keychain on macOS and Windows); everything else -
// settings, the offline license file, timestamps - in plain JSON in the
// app's user-data folder.
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

function jsonFile(name, defaults) {
  const file = () => path.join(app.getPath('userData'), name);
  const read = () => {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
    } catch {
      return { ...defaults };
    }
  };
  const write = (value) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(value, null, 2));
  };
  return { get: read, update: (patch) => write({ ...read(), ...patch }), replace: write };
}

export const state = jsonFile('state.json', { offlineFile: null, publicKey: null, lastSeenAt: null, lastCheckedAt: null });

export const DEFAULT_SETTINGS = {
  // The demo server once it exists; a local server until then.
  serverUrl: 'http://localhost:3001/v1',
  productUuid: '',
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

const secretFile = () => path.join(app.getPath('userData'), 'license.bin');

export const secrets = {
  get() {
    try {
      const encrypted = fs.readFileSync(secretFile());
      return JSON.parse(safeStorage.decryptString(encrypted));
    } catch {
      return null;
    }
  },
  set(value) {
    fs.mkdirSync(path.dirname(secretFile()), { recursive: true });
    fs.writeFileSync(secretFile(), safeStorage.encryptString(JSON.stringify(value)));
  },
  clear() {
    fs.rmSync(secretFile(), { force: true });
  },
};

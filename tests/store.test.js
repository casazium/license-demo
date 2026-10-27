import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in for Electron: app.getPath points at a temporary folder, and
// safeStorage "encrypts" with a key the test can rotate. Only the async
// methods exist, as in Electron 46, so a call to a synchronous one fails.
const fake = vi.hoisted(() => ({ dir: '', key: 'k1', failEncrypt: false, available: true, backend: 'gnome_libsecret' }));

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => fake.available,
    getSelectedStorageBackend: () => fake.backend,
    encryptStringAsync: async (text) => {
      if (fake.failEncrypt) throw new Error('keychain refused');
      return Buffer.from(`${fake.key}:${Buffer.from(text).toString('base64')}`);
    },
    decryptStringAsync: async (buffer) => {
      const [key, body] = buffer.toString().split(':');
      if (!body) throw new Error('not encrypted');
      return { result: Buffer.from(body, 'base64').toString(), shouldReEncrypt: key !== fake.key };
    },
  },
}));

// store.js keeps the vault in module state, so each test loads it fresh.
async function freshStore() {
  vi.resetModules();
  return import('../main/store.js');
}
const vaultPath = () => path.join(fake.dir, 'license.bin');

beforeEach(() => {
  fake.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-demo-store-'));
  Object.assign(fake, { key: 'k1', failEncrypt: false, available: true, backend: 'gnome_libsecret' });
});
afterEach(() => fs.rmSync(fake.dir, { recursive: true, force: true }));

describe('the vault', () => {
  test('nothing stored: get() is null after load', async () => {
    const { vault } = await freshStore();
    await vault.load();
    expect(vault.get()).toBeNull();
  });

  test('reading before load is an error, not "no license"', async () => {
    const { vault } = await freshStore();
    expect(() => vault.get()).toThrow('before it was loaded');
  });

  test('saves encrypted, and a fresh start reads it back', async () => {
    const { vault } = await freshStore();
    await vault.load();
    await vault.set({ key: 'SECRET-KEY', token: 'tok' });
    expect(fs.readFileSync(vaultPath(), 'utf8')).not.toContain('SECRET-KEY');

    const again = (await freshStore()).vault;
    await again.load();
    expect(again.get()).toEqual({ key: 'SECRET-KEY', token: 'tok' });
  });

  test('get() returns a copy', async () => {
    const { vault } = await freshStore();
    await vault.load();
    await vault.set({ key: 'K', simulated: [] });
    vault.get().simulated.push('changed');
    expect(vault.get().simulated).toEqual([]);
  });

  test('a failed save rejects, and leaves memory and the file as they were', async () => {
    const { vault } = await freshStore();
    await vault.load();
    await vault.set({ key: 'K', token: 'old' });
    const before = fs.readFileSync(vaultPath());
    fake.failEncrypt = true;
    await expect(vault.set({ key: 'K', token: 'new' })).rejects.toThrow('keychain refused');
    expect(vault.get().token).toBe('old');
    expect(fs.readFileSync(vaultPath())).toEqual(before);
    // The next save still runs.
    fake.failEncrypt = false;
    await vault.set({ key: 'K', token: 'newer' });
    expect(vault.get().token).toBe('newer');
  });

  test('saves land in the order they were made', async () => {
    const { vault } = await freshStore();
    await vault.load();
    const first = vault.set({ n: 1 });
    const second = vault.set({ n: 2 });
    await Promise.all([first, second]);
    const again = (await freshStore()).vault;
    await again.load();
    expect(again.get()).toEqual({ n: 2 });
  });

  test('clear() removes it, after any save still in flight', async () => {
    const { vault } = await freshStore();
    await vault.load();
    const saving = vault.set({ key: 'K' });
    await vault.clear();
    await saving;
    expect(vault.get()).toBeNull();
    expect(fs.existsSync(vaultPath())).toBe(false);
  });

  test("a vault that can't be decrypted throws on get(), until a new one is saved", async () => {
    fs.writeFileSync(vaultPath(), 'damaged');
    const { vault } = await freshStore();
    await vault.load();
    expect(() => vault.get()).toThrow(expect.objectContaining({ code: 'vault_unreadable' }));
    await vault.set({ key: 'NEW' });
    expect(vault.get()).toEqual({ key: 'NEW' });
  });

  test('a rotated keychain key: the vault is saved again under the new one', async () => {
    const { vault } = await freshStore();
    await vault.load();
    await vault.set({ key: 'K' });
    expect(fs.readFileSync(vaultPath(), 'utf8').startsWith('k1:')).toBe(true);

    fake.key = 'k2';
    const again = (await freshStore()).vault;
    await again.load();
    expect(again.get()).toEqual({ key: 'K' });
    expect(fs.readFileSync(vaultPath(), 'utf8').startsWith('k2:')).toBe(true);
  });

  test('if saving under the new key fails, the old file still loads', async () => {
    const { vault } = await freshStore();
    await vault.load();
    await vault.set({ key: 'K' });
    fake.key = 'k2';
    fake.failEncrypt = true;
    const again = (await freshStore()).vault;
    await again.load();
    expect(again.get()).toEqual({ key: 'K' });
    expect(fs.readFileSync(vaultPath(), 'utf8').startsWith('k1:')).toBe(true);
  });
});

describe('secretStorageProtected', () => {
  test('false when the keychain is unavailable', async () => {
    fake.available = false;
    const { secretStorageProtected } = await freshStore();
    expect(await secretStorageProtected()).toBe(false);
  });

  test.runIf(process.platform === 'linux')('false on Linux with the fixed-password fallback', async () => {
    fake.backend = 'basic_text';
    const { secretStorageProtected } = await freshStore();
    expect(await secretStorageProtected()).toBe(false);
  });

  test('true with a keychain', async () => {
    const { secretStorageProtected } = await freshStore();
    expect(await secretStorageProtected()).toBe(true);
  });
});

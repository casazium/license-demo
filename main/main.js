// The main process: the window, its security settings, and the IPC the
// renderer uses. All licensing runs here - the renderer is a web page
// and is treated as untrusted (anyone can open its dev tools).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, shell } from 'electron';
import { CasaziumLicenseClient } from '@casazium/license-sdk';
import { createLicensing } from './licensing.js';
import { createRecordingFetch } from './calls.js';
import { appInstanceId } from './machine-id.js';
import { DEFAULT_SETTINGS, secretStorageProtected, secrets, settings, state } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Tests run the app against a throwaway data folder, never a real install.
if (process.env.LICENSE_DEMO_USER_DATA) app.setPath('userData', process.env.LICENSE_DEMO_USER_DATA);
const INDEX = path.join(here, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;

// Links the app may open in the system browser. Anything else is refused.
const EXTERNAL_HOSTS = new Set(['casazium.com', 'docs.casazium.com', 'buy.stripe.com']);

let window;
const calls = [];

const recordingFetch = createRecordingFetch({
  baseFetch: (url, init) => net.fetch(url, init),
  onCall(call) {
    calls.push(call);
    if (calls.length > 200) calls.shift();
    window?.webContents.send('calls:new', call);
  },
  secrets: () => [secrets.get()?.key].filter(Boolean),
});

const licensing = createLicensing({
  createClient: (options) => new CasaziumLicenseClient({ fetch: recordingFetch, ...options }),
  secrets,
  state,
  settings: () => settings.get(),
  instanceId: () => appInstanceId(settings.get().productUuid),
});

// A server URL must be https, except for a server on this machine.
function validServerUrl(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && local);
  } catch {
    return false;
  }
}

function openExternal(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') return false;
  const host = url.hostname;
  const portal = (() => {
    try {
      return host === new URL(settings.get().serverUrl).hostname;
    } catch {
      return false;
    }
  })();
  if (!EXTERNAL_HOSTS.has(host) && !portal) return false;
  shell.openExternal(url.href);
  return true;
}

// Every IPC handler checks the message came from the app's own page.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame?.url !== INDEX_URL) throw new Error('Refused: unexpected sender');
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status ?? null, code: err.code ?? null };
    }
  });
}

handle('licensing:status', () => ({ ...licensing.status(), secretsProtected: secretStorageProtected() }));
handle('licensing:activate', (key) => licensing.activate(String(key)));
handle('licensing:launchCheck', (options) => licensing.launchCheck({ offline: Boolean(options?.offline) }));
handle('licensing:deactivate', () => licensing.deactivate());
handle('licensing:reactivate', () => licensing.reactivate());
handle('licensing:simulateAnotherMachine', () => licensing.simulateAnotherMachine());
handle('licensing:freeSimulatedMachines', () => licensing.freeSimulatedMachines());
handle('licensing:freeThisSeatElsewhere', () => licensing.freeThisSeatElsewhere());
handle('licensing:trustNewPublicKey', () => licensing.trustNewPublicKey());
handle('licensing:exportOffline', () => licensing.exportOffline());
handle('licensing:verifyOffline', () => licensing.verifyOffline());
handle('licensing:usage', () => licensing.usage());
handle('licensing:trackUsage', () => licensing.trackUsage('api_calls_per_day'));
handle('settings:get', () => settings.get());
handle('settings:set', (next) => {
  const serverUrl = String(next?.serverUrl ?? '').trim();
  const productUuid = String(next?.productUuid ?? '').trim();
  if (!validServerUrl(serverUrl)) throw new Error('The server URL must be https (http only for localhost)');
  const previous = settings.get();
  settings.replace({ ...DEFAULT_SETTINGS, serverUrl, productUuid });
  // A different server has a different public key and different licenses.
  if (previous.serverUrl !== serverUrl) state.update({ publicKey: null, offlineFile: null });
  return settings.get();
});
handle('calls:list', () => calls);
handle('calls:clear', () => {
  calls.length = 0;
  return true;
});
handle('external:open', (url) => openExternal(String(url)));

function createWindow() {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Casazium License demo',
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.loadFile(INDEX);
}

app.on('web-contents-created', (_event, contents) => {
  // No new windows, and no navigating away from the app's page: links go
  // to the system browser, if they're on the allowlist.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) event.preventDefault();
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

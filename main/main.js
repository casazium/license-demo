// The main process: the window, its security settings, and the IPC the
// renderer uses. All licensing runs here - the renderer is a web page
// and is treated as untrusted (anyone can open its dev tools).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, net, session, shell } from 'electron';
import { CasaziumLicenseClient } from '@casazium/license-sdk';
import { createLicensing } from './licensing.js';
import { createRecordingFetch } from './calls.js';
import { appInstanceId } from './machine-id.js';
import { DEFAULT_SETTINGS, secretStorageProtected, settings, state, vault } from './store.js';

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
  secrets: () => {
    try {
      return [vault.get()?.key].filter(Boolean);
    } catch {
      return [];
    }
  },
});

const licensing = createLicensing({
  createClient: (options) => new CasaziumLicenseClient({ fetch: recordingFetch, ...options }),
  vault,
  state,
  // A real app passes its server's public key here (builtInPublicKey), so
  // the offline check trusts nothing it downloads. This demo can point at
  // any server, so it fetches the key once and pins it instead.
  builtInPublicKey: null,
  settings: () => settings.get(),
  instanceId: () => appInstanceId(settings.get().productUuid),
  fetch: recordingFetch,
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

// Opens a link in the system browser, only for https URLs on the
// allowlist. Anything else - including a URL the page made up - is refused.
function openExternal(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.has(url.hostname)) return false;
  shell.openExternal(url.href);
  return true;
}

// Licensing actions run one at a time: two button presses at once mustn't
// read and write the stored license in between each other's awaits.
let queue = Promise.resolve();
const serialized = (fn) => (...args) => {
  const run = queue.then(() => fn(...args));
  queue = run.catch(() => {});
  return run;
};

// Every IPC handler checks the message came from the app's own page.
function handle(channel, fn) {
  const run = channel.startsWith('licensing:') || channel.startsWith('seed:') || channel.startsWith('demo:') || channel === 'settings:set'
    ? serialized(fn)
    : fn;
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame?.url !== INDEX_URL) throw new Error('Refused: unexpected sender');
    try {
      return { ok: true, value: await run(...args) };
    } catch (err) {
      // A 404 ending ": Not Found" is a route the server doesn't have.
      const error = err.status === 404 && /: Not Found$/.test(err.message)
        ? `${err.message}. The server doesn't have this route: check the server URL ends in /v1, and that it's License Server 1.21.0 or later.`
        : err.message;
      return { ok: false, error, status: err.status ?? null, code: err.code ?? null };
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
// Loads the demo helper's seed.json. On a fresh install - no product UUID
// set and no license stored - it also adopts the seed's server and product,
// so the demo works without any setup.
handle('seed:load', async () => {
  const seed = await licensing.loadSeed();
  const current = settings.get();
  if (seed.loaded && !current.productUuid && !licensing.status().hasKey && validServerUrl(seed.serverUrl)) {
    settings.replace({ ...current, serverUrl: seed.serverUrl, productUuid: seed.productUuid });
    return { ...licensing.seedSummary(), loaded: true, applied: true };
  }
  return seed;
});
handle('seed:summary', () => licensing.seedSummary());
handle('seed:keyMatchesServer', () => licensing.seedKeyMatchesServer());
handle('demo:try', (kind) => licensing.tryDemoKey(String(kind)));
// The stored key and token belong to the server they were activated on:
// switching server or product while they're stored would send them to the
// new one. Deactivate first.
function refuseWhileLicensed(next) {
  const current = settings.get();
  if (next.serverUrl === current.serverUrl && next.productUuid === current.productUuid) return;
  if (licensing.status().hasKey) {
    throw new Error('Deactivate this machine before changing the server or product: the stored license belongs to this one');
  }
}

// Points the app at the server the seed describes.
handle('seed:apply', () => {
  const seed = licensing.seedSummary();
  if (!seed) throw new Error('No seed.json loaded');
  if (!validServerUrl(seed.serverUrl)) throw new Error("seed.json's server URL isn't https");
  refuseWhileLicensed({ serverUrl: seed.serverUrl, productUuid: seed.productUuid });
  settings.replace({ ...settings.get(), serverUrl: seed.serverUrl, productUuid: seed.productUuid });
  return settings.get();
});
handle('demo:getKey', () => {
  const url = licensing.seedSummary()?.getKeyUrl;
  if (!url) throw new Error('This demo server has no purchase link');
  if (!openExternal(url)) throw new Error('The purchase link is not on the allowed list');
  return true;
});
handle('settings:get', () => settings.get());
handle('settings:set', (next) => {
  const serverUrl = String(next?.serverUrl ?? '').trim();
  const productUuid = String(next?.productUuid ?? '').trim();
  const helperUrl = String(next?.helperUrl ?? '').trim();
  if (!validServerUrl(serverUrl)) throw new Error('The server URL must be https (http only for localhost)');
  if (helperUrl && !validServerUrl(helperUrl)) throw new Error('The demo helper URL must be https (http only for localhost)');
  refuseWhileLicensed({ serverUrl, productUuid });
  settings.replace({ ...DEFAULT_SETTINGS, serverUrl, productUuid, helperUrl });
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
  // Electron has no right-click menu of its own: without this, pasting a
  // key with the mouse doesn't work. Built from Electron's standard roles,
  // so it gives the page nothing new.
  contents.on('context-menu', (_event, params) => {
    const template = params.isEditable
      ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : params.selectionText
        ? [{ role: 'copy' }]
        : [];
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
});

app.whenReady().then(() => {
  // The app needs no camera, microphone, notifications or anything else a
  // page can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// The only bridge between the page and the main process: a fixed set of
// calls. The page gets no Node, no Electron APIs and no SDK - only these.
// CommonJS, because a sandboxed preload can't be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('licensing', {
  status: call('licensing:status'),
  activate: call('licensing:activate'),
  launchCheck: call('licensing:launchCheck'),
  deactivate: call('licensing:deactivate'),
  exportOffline: call('licensing:exportOffline'),
  verifyOffline: call('licensing:verifyOffline'),
  usage: call('licensing:usage'),
  trackUsage: call('licensing:trackUsage'),
});

contextBridge.exposeInMainWorld('app', {
  getSettings: call('settings:get'),
  saveSettings: call('settings:set'),
  openExternal: call('external:open'),
  calls: call('calls:list'),
  clearCalls: call('calls:clear'),
  onCall: (listener) => ipcRenderer.on('calls:new', (_event, entry) => listener(entry)),
});

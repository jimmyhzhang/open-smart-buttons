// Preload for every app window (sandboxed, so CommonJS). window.osbNative is the renderer's only way
// into the main process: a fixed set of calls, each checked again in main.ts.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => {
  if (typeof fn !== 'function') return () => {};
  const handler = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('osbNative', Object.freeze({
  getState: () => ipcRenderer.invoke('osb:state'),
  onState: (fn) => listen('osb:native-state', fn),
  onMenu: (fn) => listen('osb:menu', fn),
  command: (name, arg) => ipcRenderer.invoke('osb:command', String(name), arg),
  setPref: (key, value) => ipcRenderer.invoke('osb:set-pref', String(key), value),
  setApiKey: (key) => ipcRenderer.invoke('osb:set-api-key', key === null ? null : String(key)),
  contextMenu: (items) => ipcRenderer.invoke('osb:context-menu', items),
}));

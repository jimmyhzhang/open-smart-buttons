// Preload for every app window (sandboxed, so CommonJS). window.sdpNative is the renderer's only way
// into the main process: a fixed set of calls, each checked again in main.ts.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => {
  if (typeof fn !== 'function') return () => {};
  const handler = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('sdpNative', Object.freeze({
  getState: () => ipcRenderer.invoke('sdp:state'),
  onState: (fn) => listen('sdp:native-state', fn),
  onMenu: (fn) => listen('sdp:menu', fn),
  command: (name, arg) => ipcRenderer.invoke('sdp:command', String(name), arg),
  setPref: (key, value) => ipcRenderer.invoke('sdp:set-pref', String(key), value),
  setApiKey: (key) => ipcRenderer.invoke('sdp:set-api-key', key === null ? null : String(key)),
  contextMenu: (items) => ipcRenderer.invoke('sdp:context-menu', items),
}));

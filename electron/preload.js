const { contextBridge, ipcRenderer } = require('electron');

const pcmHandlers = new Map();
let pcmSeq = 0;
ipcRenderer.on('native-pcm', (_e, b64) => {
  for (const fn of pcmHandlers.values()) {
    try { fn(b64); } catch {}
  }
});

contextBridge.exposeInMainWorld('cbopkaAPI', {
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  setServerUrl: (url) => ipcRenderer.invoke('set-server-url', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  setContentProtection: (on) => ipcRenderer.invoke('set-content-protection', on),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  askMicrophone: () => ipcRenderer.invoke('ask-microphone'),
  resetMicrophone: () => ipcRenderer.invoke('reset-microphone'),
  openMicSettings: () => ipcRenderer.invoke('open-mic-settings'),
  openSoundSettings: () => ipcRenderer.invoke('open-sound-settings'),
  openRecordingPanel: () => ipcRenderer.invoke('open-recording-panel'),
  unlockMicrophone: () => ipcRenderer.invoke('unlock-microphone'),
  startNativeMic: () => ipcRenderer.invoke('native-mic-start'),
  stopNativeMic: () => ipcRenderer.invoke('native-mic-stop'),
  onNativePcm: (cb) => {
    const id = ++pcmSeq;
    pcmHandlers.set(id, cb);
    return id;
  },
  offNativePcm: (id) => { pcmHandlers.delete(id); return true; },
  listMics: () => ipcRenderer.invoke('list-mics'),
  platform: process.platform,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, name) => cb(name)),
  onGame: (cb) => ipcRenderer.on('game', (_e, name) => cb(name))
});

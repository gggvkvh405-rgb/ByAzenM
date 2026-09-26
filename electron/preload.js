const { contextBridge, ipcRenderer } = require('electron');

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
  listMics: () => ipcRenderer.invoke('list-mics'),
  platform: process.platform,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, name) => cb(name)),
  onGame: (cb) => ipcRenderer.on('game', (_e, name) => cb(name))
});

/**
 * PeopleSafe SDLC Journal — Electron Preload Script
 * Exposes a safe API to the renderer via contextBridge.
 * Sandbox-compatible: no fs or path imports.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),

  // File I/O
  saveFile: (filePath, data) => ipcRenderer.invoke('file:save', filePath, data),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // App events from main process → renderer
  onLock: (callback) => ipcRenderer.on('app:lock', callback),
  onNavigate: (callback) => ipcRenderer.on('app:navigate', (_event, view) => callback(view)),
  onSave: (callback) => ipcRenderer.on('app:save', callback),
  onExport: (callback) => ipcRenderer.on('app:export', callback),
  onWindowBlur: (callback) => ipcRenderer.on('window:blur', callback),
  onWindowFocus: (callback) => ipcRenderer.on('window:focus', callback),
  onUpdateAvailable: (callback) => ipcRenderer.on('update:available', (_event, info) => callback(info)),
  onNotificationClick: (callback) => ipcRenderer.on('notification:click', callback),

  // Platform info
  platform: process.platform
});

// Inject the electron-bridge.js via IPC (sandbox-safe — no fs access needed)
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const bridgeCode = await ipcRenderer.invoke('bridge:code');
    const script = document.createElement('script');
    script.textContent = bridgeCode;
    document.body.appendChild(script);
  } catch (e) {
    console.error('Failed to load electron-bridge:', e);
  }
});

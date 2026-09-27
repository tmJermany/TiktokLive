'use strict';

/**
 * Security bridge: exposes a small, explicit API to the overlay page. The
 * renderer has no Node.js access and can only reach these IPC channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  getSettings: () => ipcRenderer.invoke('overlay:get-settings'),

  /** @param {{ username?: string, demo?: boolean }} request */
  connect: (request) =>
    ipcRenderer.invoke('overlay:connect', {
      username: String(request?.username ?? ''),
      demo: Boolean(request?.demo)
    }),

  disconnect: () => ipcRenderer.invoke('overlay:disconnect'),

  /** Copies text (e.g. a donor's username) to the clipboard. */
  copyText: (text) => ipcRenderer.invoke('overlay:copy', String(text ?? '')),

  /** @param {'moneygun' | 'galaxy' | 'rose'} effect */
  testGift: (effect) => ipcRenderer.invoke('overlay:test-gift', String(effect)),

  /** @param {'minimize' | 'close' | 'toggle-pin' | 'fit-9-16'} action */
  windowAction: (action) => ipcRenderer.invoke('overlay:window', String(action)),

  /** Resize from the corner grip: phase 'start', then 'move'/'end' with the pointer offset. */
  resize: (phase, dx = 0, dy = 0) =>
    ipcRenderer.invoke('overlay:resize', { phase: String(phase), dx: Number(dx), dy: Number(dy) }),

  /**
   * Subscribes to connector events ({ type, data }). Returns an unsubscribe function.
   * @param {(event: { type: string, data: object }) => void} callback
   */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('overlay:event', listener);
    return () => ipcRenderer.removeListener('overlay:event', listener);
  }
});

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

  /** @param {'moneygun' | 'galaxy' | 'rose'} effect */
  testGift: (effect) => ipcRenderer.invoke('overlay:test-gift', String(effect)),

  /** @param {'minimize' | 'close' | 'toggle-pin'} action */
  windowAction: (action) => ipcRenderer.invoke('overlay:window', String(action)),

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

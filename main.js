'use strict';

/**
 * Electron entry point: creates the floating overlay window, owns the TikTok
 * connection, resolves profile pictures, and relays events to the renderer
 * (plus an optional localhost WebSocket feed for OBS or other tools).
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard, ipcMain, session, screen } = require('electron');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const {
  TikTokConnector,
  EFFECTS,
  normalizeUsername,
  generateAvatar
} = require('./tiktok-connector');

const START_IN_DEMO = process.argv.includes('--demo');
const BROADCAST_PORT = parsePort(process.env.OVERLAY_WS_PORT, 21213);
const AVATAR_CACHE_LIMIT = 300;
const AVATAR_MAX_BYTES = 512 * 1024;
const STREAM_ASPECT_RATIO = 9 / 16;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 320;

if (process.platform === 'linux') {
  // Required for transparent windows on most Linux compositors.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

let mainWindow = null;
let broadcastServer = null;
const connector = new TikTokConnector();

// ---------------------------------------------------------------------------
// Settings (remembers the last username)
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('Could not save settings:', err.message);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Avatars: fetched in the main process so the renderer can keep a strict CSP
// (images only from data: URLs) and TikTok's CDN never sees the overlay page.
// ---------------------------------------------------------------------------

const avatarCache = new Map();

async function resolveAvatar(user) {
  const fallback = generateAvatar(user.username);
  const url = user.avatarUrl;
  if (!url || url.startsWith('data:')) return url || fallback;
  if (avatarCache.has(url)) return avatarCache.get(url);

  let dataUrl = fallback;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 4000,
      maxContentLength: AVATAR_MAX_BYTES,
      headers: { Accept: 'image/webp,image/png,image/jpeg,image/*' }
    });
    const type = String(response.headers['content-type'] || '').split(';')[0].trim();
    if (/^image\/(png|jpe?g|webp|gif|avif)$/i.test(type)) {
      dataUrl = `data:${type};base64,${Buffer.from(response.data).toString('base64')}`;
    }
  } catch {
    // Keep the generated fallback avatar.
  }

  avatarCache.set(url, dataUrl);
  if (avatarCache.size > AVATAR_CACHE_LIMIT) {
    avatarCache.delete(avatarCache.keys().next().value);
  }
  return dataUrl;
}

// ---------------------------------------------------------------------------
// Event relay
// ---------------------------------------------------------------------------

function sendToRenderer(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:event', { type, data });
  }
  broadcast(type, data);
}

/** Resolves avatars while preserving event order. */
function orderedRelay(type) {
  let chain = Promise.resolve();
  return (event) => {
    chain = chain
      .then(async () => {
        const avatar = await resolveAvatar(event.user);
        sendToRenderer(type, { ...event, user: { ...event.user, avatar } });
      })
      .catch((err) => console.error(`Failed to relay ${type}:`, err));
  };
}

connector.on('gift', orderedRelay('gift'));
// Chat is only used to look up donors' last messages, so skip avatar downloads.
connector.on('chat', (data) => sendToRenderer('chat', data));
connector.on('viewers', (data) => sendToRenderer('viewers', data));
connector.on('status', (data) => sendToRenderer('status', data));
connector.on('log', (message) => console.warn(message));

// ---------------------------------------------------------------------------
// Local WebSocket feed (ws://127.0.0.1:21213) for OBS browser sources etc.
// Set OVERLAY_WS_PORT=off to disable.
// ---------------------------------------------------------------------------

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(0|off|false|no)$/i.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function isAllowedOrigin(origin) {
  // Non-browser clients and local files send no Origin (or "null"); web pages
  // are only accepted from localhost so random websites can't read the feed.
  if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function startBroadcastServer() {
  if (!BROADCAST_PORT) return;
  broadcastServer = new WebSocketServer({
    host: '127.0.0.1',
    port: BROADCAST_PORT,
    verifyClient: ({ origin }) => isAllowedOrigin(origin)
  });
  broadcastServer.on('listening', () => {
    console.log(`Event feed available at ws://127.0.0.1:${BROADCAST_PORT}`);
  });
  broadcastServer.on('error', (err) => {
    console.warn(`Event feed disabled (${err.code || err.message}).`);
    broadcastServer = null;
  });
}

function broadcast(type, data) {
  if (!broadcastServer) return;
  const payload = JSON.stringify({ type, data });
  for (const client of broadcastServer.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** The last saved window position/size, if it's still on a connected screen. */
function savedBounds() {
  const saved = readSettings().windowBounds;
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 &&
    saved.y < a.y + a.height - 40 && saved.y + saved.height > a.y + 40);
  if (!visible) return null;
  return {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(MIN_WIDTH, Math.round(saved.width)),
    height: Math.max(MIN_HEIGHT, Math.round(saved.height))
  };
}

function defaultBounds() {
  // 9:16, the same shape as a TikTok LIVE.
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.min(820, workArea.height - 40);
  const width = Math.round(height * STREAM_ASPECT_RATIO);
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + Math.round((workArea.height - height) / 2)
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...(savedBounds() || defaultBounds()),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    fullscreenable: false,
    title: 'TikTok LIVE Overlay',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'overlay.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // The overlay is a single local page: never navigate or open new windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Remember where you leave the window and how big it is.
  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
        writeSettings({ windowBounds: mainWindow.getBounds() });
      }
    }, 400);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    clearTimeout(saveTimer);
    mainWindow = null;
  });
}

/** Resizing from the in-window grip (works even where the OS can't resize transparent windows). */
let resizeStart = null;

function resizeWindow({ phase, dx, dy }) {
  if (!mainWindow) return;
  if (phase === 'start') {
    resizeStart = mainWindow.getBounds();
    return;
  }
  if (!resizeStart || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  mainWindow.setBounds({
    ...resizeStart,
    width: Math.max(MIN_WIDTH, Math.round(resizeStart.width + dx)),
    height: Math.max(MIN_HEIGHT, Math.round(resizeStart.height + dy))
  });
  if (phase === 'end') resizeStart = null;
}

/** Makes the window exactly 9:16, keeping its height and centre. */
function fitToStreamShape() {
  const bounds = mainWindow.getBounds();
  const width = Math.max(MIN_WIDTH, Math.round(bounds.height * STREAM_ASPECT_RATIO));
  const height = Math.round(width / STREAM_ASPECT_RATIO);
  mainWindow.setBounds({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y,
    width,
    height
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unauthorized sender');
    }
    return handler(...args);
  });
}

function registerIpc() {
  handle('overlay:get-settings', () => ({
    lastUsername: readSettings().lastUsername || '',
    autoStart: START_IN_DEMO ? 'demo' : null,
    feedUrl: broadcastServer ? `ws://127.0.0.1:${BROADCAST_PORT}` : null
  }));

  handle('overlay:connect', async (request = {}) => {
    const demo = Boolean(request.demo);
    const username = demo ? request.username : normalizeUsername(request.username);
    if (!demo && !username) {
      return { ok: false, error: 'Enter a valid TikTok username (letters, numbers, "." and "_").' };
    }
    try {
      const result = await connector.connect(username, { demo });
      if (result.mode === 'live') writeSettings({ lastUsername: result.username });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('overlay:disconnect', async () => {
    await connector.disconnect();
    return { ok: true };
  });

  handle('overlay:copy', async (text) => {
    const value = String(text ?? '').slice(0, 500);
    if (!value) return { ok: false };
    // Newer Electron versions make clipboard calls async; await covers both.
    await clipboard.writeText(value);
    return { ok: true };
  });

  handle('overlay:click-through', (on) => {
    // Windows and macOS keep sending mouse moves while clicks pass through,
    // which the page needs to turn clicks back on over its controls. Linux
    // can't, so there the window keeps its clicks.
    if (!mainWindow || !['win32', 'darwin'].includes(process.platform)) return null;
    mainWindow.setIgnoreMouseEvents(Boolean(on), { forward: true });
    return null;
  });

  handle('overlay:resize', (request = {}) => {
    resizeWindow({ phase: String(request.phase), dx: Number(request.dx), dy: Number(request.dy) });
    return null;
  });

  handle('overlay:test-gift', (effect) => {
    if (!Object.values(EFFECTS).includes(effect)) return { ok: false };
    connector.triggerTestGift(effect);
    return { ok: true };
  });

  handle('overlay:window', (action) => {
    if (!mainWindow) return null;
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        return null;
      case 'close':
        mainWindow.close();
        return null;
      case 'fit-9-16':
        fitToStreamShape();
        return null;
      case 'toggle-pin': {
        const pinned = !mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(pinned, 'floating');
        return { pinned };
      }
      default:
        return null;
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // The overlay needs no camera, mic, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    registerIpc();
    startBroadcastServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    connector.disconnect().catch(() => {});
    broadcastServer?.close();
  });
}

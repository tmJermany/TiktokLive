'use strict';

/**
 * TikTok LIVE connection handler.
 *
 * Connects to a creator's LIVE stream using only their username (no API
 * credentials) through the `tiktok-live-connector` library, and exposes a
 * built-in demo mode that simulates gifts and chat for testing effects.
 *
 * Every event is normalised into a small, stable shape before it leaves this
 * module, so the rest of the app never touches raw TikTok payloads:
 *
 *   gift    { id, effect, giftName, giftId, count, diamonds, user, timestamp }
 *   chat    { id, text, user, timestamp }
 *   viewers { count }
 *   status  { state, mode, username, message?, roomId? }
 *
 *   user    { id, username, nickname, avatarUrl }
 */

const { EventEmitter } = require('node:events');

const EFFECTS = Object.freeze({
  MONEY_GUN: 'moneygun',
  GALAXY: 'galaxy',
  ROSE: 'rose'
});

const DEMO_USERNAME = 'demo';
const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;

/**
 * Accepts "@name", "name", or a full TikTok URL and returns the bare
 * username, or null when the input can't be a valid TikTok handle.
 */
function normalizeUsername(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  const urlMatch = value.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (urlMatch) value = urlMatch[1];
  value = value.replace(/^@+/, '');
  return USERNAME_PATTERN.test(value) ? value : null;
}

/**
 * Maps a TikTok gift to one of the three overlay effects. Known gifts match by
 * name; anything else falls back to its coin value so big gifts stay epic.
 */
function classifyGift({ name, diamonds } = {}) {
  const key = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (key.includes('moneygun')) return EFFECTS.MONEY_GUN;
  if (key.includes('galaxy')) return EFFECTS.GALAXY;
  if (key.includes('rose')) return EFFECTS.ROSE;
  const value = Number(diamonds) || 0;
  if (value >= 1000) return EFFECTS.GALAXY;
  if (value >= 500) return EFFECTS.MONEY_GUN;
  return EFFECTS.ROSE;
}

function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeXml(str) {
  return str.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Deterministic avatar (initials on a gradient) as an SVG data URL. Used for
 * demo users and as the fallback whenever a real profile picture can't load.
 */
function generateAvatar(name) {
  const label = String(name || '?');
  const hash = hashString(label);
  const hueA = hash % 360;
  const hueB = (hueA + 40 + ((hash >> 9) % 80)) % 360;
  const initials = escapeXml(
    label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
  );
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="hsl(${hueA},80%,58%)"/>` +
    `<stop offset="1" stop-color="hsl(${hueB},75%,42%)"/>` +
    '</linearGradient></defs>' +
    '<rect width="64" height="64" rx="32" fill="url(#g)"/>' +
    '<text x="32" y="41" font-family="Segoe UI,Helvetica,Arial,sans-serif" ' +
    `font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text>` +
    '</svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Picks the first usable avatar URL from the various TikTok user shapes. */
function extractAvatarUrl(user = {}) {
  const candidates = [
    user.profilePictureUrl,
    user.profilePicture?.url,
    user.profilePicture?.urlList,
    user.profilePicture?.urls,
    user.avatarThumb?.urlList,
    user.avatarThumb?.url
  ];
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : [candidate];
    const url = list.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (url) return url;
  }
  return null;
}

function normalizeUser(raw = {}) {
  const username = String(raw.uniqueId || raw.username || raw.displayId || 'viewer');
  return {
    id: String(raw.userId || raw.id || username),
    username,
    nickname: String(raw.nickname || username),
    avatarUrl: extractAvatarUrl(raw)
  };
}

/** Converts a raw tiktok-live-connector gift event; null while a streak is still running. */
function normalizeGift(data = {}) {
  const details = data.giftDetails || {};
  const extended = data.extendedGiftInfo || {};
  const giftType = details.giftType ?? data.giftType;
  if (giftType === 1 && !data.repeatEnd) return null;

  const giftName = details.giftName || extended.name || data.giftName || `Gift ${data.giftId ?? ''}`.trim();
  const diamonds = Number(details.diamondCount ?? extended.diamond_count ?? data.diamondCount) || 0;
  const count = Math.max(1, Number(data.repeatCount) || 1);

  return {
    id: String(data.msgId || data.common?.msgId || `${Date.now()}-${Math.random()}`),
    effect: classifyGift({ name: giftName, diamonds }),
    giftName,
    giftId: data.giftId ?? null,
    count,
    diamonds: diamonds * count,
    user: normalizeUser(data.user || data),
    timestamp: Date.now()
  };
}

function normalizeChat(data = {}) {
  const text = String(data.comment ?? data.content ?? '').trim();
  if (!text) return null;
  return {
    id: String(data.msgId || data.common?.msgId || `${Date.now()}-${Math.random()}`),
    text: text.slice(0, 300),
    user: normalizeUser(data.user || data),
    timestamp: Date.now()
  };
}

function describeError(err, username) {
  const name = err?.constructor?.name || err?.name || '';
  const message = String(err?.message || err || 'Unknown error');
  if (name === 'UserOfflineError' || /offline|not live|isn't live|LIVE has ended/i.test(message)) {
    return `@${username} is not LIVE right now. Start your LIVE and try again.`;
  }
  if (name === 'InvalidUniqueIdError' || /user not found|unique ?id/i.test(message)) {
    return `Couldn't find a TikTok account named @${username}.`;
  }
  if (name === 'SignatureRateLimitError' || /rate ?limit/i.test(message)) {
    return 'TikTok connection service is rate-limited. Wait a minute and try again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return 'Network error while reaching TikTok. Check your internet connection.';
  }
  return `Couldn't connect to @${username}: ${message}`;
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const DEMO_USERS = [
  ['yeri_santiago', 'Yeri 🌴'],
  ['carlitos.rd', 'Carlitos RD'],
  ['mariposa_809', 'Mariposa ✨'],
  ['elgranjuan', 'El Gran Juan'],
  ['luna.bachata', 'Luna Bachata'],
  ['pixel_king', 'PixelKing'],
  ['sofi.vlogs', 'Sofi Vlogs'],
  ['merengue_mike', 'Merengue Mike'],
  ['nina.gamer', 'Nina 🎮'],
  ['dj_caribe', 'DJ Caribe'],
  ['ana.cibaena', 'Ana Cibaeña'],
  ['stream_fan_01', 'StreamFan']
].map(([username, nickname], i) => ({
  id: `demo-${i}`,
  username,
  nickname,
  avatarUrl: generateAvatar(username)
}));

const DEMO_CHAT = [
  'Hello from Santiago! 🇩🇴',
  'Klk, qué lo que! 🔥',
  'This stream is fire 🔥🔥',
  'Saludos desde la capital 👋',
  'Pick me please!! 🙏',
  'First time here, love it',
  'Can you play some bachata?',
  'Que viva el Cibao 💚',
  'LET\'S GOOO 🚀',
  'Who else is watching at night? 🌙',
  'Big shoutout to the mods 🙌',
  'Tremendo live hoy 😂',
  'How long have you been streaming?',
  'Send the galaxy!! 🌌',
  'I\'m sharing this with my friends',
  '¿De dónde eres?',
  'Rose train 🌹🌹🌹',
  'W stream',
  'Tap tap tap ❤️❤️❤️',
  'Say hi to my mom 😅'
];

const DEMO_GIFTS = {
  [EFFECTS.ROSE]: { giftName: 'Rose', giftId: 5655, diamonds: 1, counts: [1, 3, 5, 10, 25, 99] },
  [EFFECTS.MONEY_GUN]: { giftName: 'Money Gun', giftId: 7168, diamonds: 500, counts: [1, 1, 2, 3] },
  [EFFECTS.GALAXY]: { giftName: 'Galaxy', giftId: 11046, diamonds: 1000, counts: [1, 1, 2] }
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomBetween = ([min, max]) => min + Math.random() * (max - min);

function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadTikTokLibrary() {
  try {
    return await import('tiktok-live-connector');
  } catch (err) {
    const wrapped = new Error(
      'The tiktok-live-connector package is not installed. Run "npm install" or use demo mode.'
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

class TikTokConnector extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {[number, number]} [options.demoGiftIntervalMs] random delay between demo gifts
   * @param {[number, number]} [options.demoChatIntervalMs] random delay between demo chat messages
   * @param {number} [options.demoFirstGiftMs] delay before the first demo gift
   * @param {number} [options.maxReconnectAttempts]
   * @param {number} [options.reconnectBaseDelayMs]
   * @param {() => Promise<object>} [options.loadLibrary] override for tests
   */
  constructor(options = {}) {
    super();
    this.options = {
      demoGiftIntervalMs: [10000, 15000],
      demoChatIntervalMs: [1500, 4000],
      demoFirstGiftMs: 2500,
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 2000,
      loadLibrary: loadTikTokLibrary,
      signApiKey: process.env.EULER_API_KEY || undefined,
      ...options
    };
    this.mode = null;
    this.username = null;
    this.connection = null;
    this.timers = new Set();
    this.session = 0;
    this.reconnectAttempts = 0;
    this.demoGiftCycle = [];
  }

  get isActive() {
    return this.mode !== null;
  }

  /**
   * Connects to `username`'s LIVE, or starts demo mode when `demo` is set or
   * the username is "demo". Resolves with { mode, username } once connected.
   */
  async connect(username, { demo = false } = {}) {
    await this.disconnect();
    const session = ++this.session;

    if (demo || String(username || '').trim().toLowerCase() === DEMO_USERNAME) {
      this._startDemo(session, normalizeUsername(username) || DEMO_USERNAME);
      return { mode: 'demo', username: this.username };
    }

    const normalized = normalizeUsername(username);
    if (!normalized) {
      throw new Error('Enter a valid TikTok username (letters, numbers, "." and "_").');
    }

    this.mode = 'live';
    this.username = normalized;
    this.reconnectAttempts = 0;
    await this._connectLive(session);
    return { mode: 'live', username: normalized };
  }

  async disconnect() {
    this.session++;
    this._clearTimers();
    const connection = this.connection;
    this.connection = null;
    const wasActive = this.isActive;
    const { mode, username } = this;
    this.mode = null;
    if (connection) {
      connection.removeAllListeners?.();
      try {
        await connection.disconnect();
      } catch {
        // Already closed; nothing to clean up.
      }
    }
    if (wasActive) this._status('disconnected', { mode, username });
  }

  /** Emits a test gift through the normal pipeline (works in live and demo mode). */
  triggerTestGift(effect) {
    const type = Object.values(EFFECTS).includes(effect) ? effect : EFFECTS.ROSE;
    this.emit('gift', this._demoGift(type));
  }

  // --- live -----------------------------------------------------------------

  async _connectLive(session) {
    const reconnecting = this.reconnectAttempts > 0;
    this._status(reconnecting ? 'reconnecting' : 'connecting', {
      message: reconnecting
        ? `Reconnecting (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})…`
        : `Connecting to @${this.username}…`
    });

    let lib;
    try {
      lib = await this.options.loadLibrary();
    } catch (err) {
      this._failLive(session, err.message);
      throw err;
    }
    if (session !== this.session) return;

    const { TikTokLiveConnection, WebcastEvent = {}, ControlEvent = {} } = lib;
    const connection = new TikTokLiveConnection(this.username, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      ...(this.options.signApiKey ? { signApiKey: this.options.signApiKey } : {})
    });
    this.connection = connection;

    const on = (event, fallback, handler) => {
      connection.on(event || fallback, (data) => {
        if (session === this.session) handler(data);
      });
    };

    on(WebcastEvent.GIFT, 'gift', (data) => {
      const gift = normalizeGift(data);
      if (gift) this.emit('gift', gift);
    });
    on(WebcastEvent.CHAT, 'chat', (data) => {
      const chat = normalizeChat(data);
      if (chat) this.emit('chat', chat);
    });
    on(WebcastEvent.ROOM_USER, 'roomUser', (data) => {
      const count = Number(data?.viewerCount ?? data?.totalUser);
      if (Number.isFinite(count)) this.emit('viewers', { count });
    });
    on(WebcastEvent.STREAM_END, 'streamEnd', () => {
      this._clearTimers();
      this.connection = null;
      this.mode = null;
      this._status('ended', { mode: 'live', message: `@${this.username}'s LIVE has ended.` });
      connection.disconnect().catch(() => {});
    });
    on(ControlEvent.DISCONNECTED, 'disconnected', () => {
      if (this.connection === connection) this._scheduleReconnect(session);
    });
    on(ControlEvent.ERROR, 'error', (err) => {
      this.emit('log', `TikTok connection error: ${err?.info || err?.exception?.message || err}`);
    });

    try {
      const state = await connection.connect();
      if (session !== this.session) return;
      this.reconnectAttempts = 0;
      this._status('connected', {
        roomId: state?.roomId ?? null,
        message: `Connected to @${this.username}'s LIVE`
      });
    } catch (err) {
      if (session !== this.session) return;
      const message = describeError(err, this.username);
      if (reconnecting && this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this._scheduleReconnect(session);
        return;
      }
      this._failLive(session, message);
      const wrapped = new Error(message);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  _failLive(session, message) {
    if (session !== this.session) return;
    this.connection = null;
    this.mode = null;
    this._status('error', { mode: 'live', message });
  }

  _scheduleReconnect(session) {
    if (session !== this.session) return;
    this.connection = null;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this._failLive(session, 'Lost connection to TikTok and could not reconnect.');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.options.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1);
    this._status('reconnecting', {
      message: `Connection lost. Retrying in ${Math.round(delay / 1000)}s…`
    });
    this._setTimer(() => {
      this._connectLive(session).catch(() => {
        // Failure is already reported through the status event.
      });
    }, delay);
  }

  // --- demo -----------------------------------------------------------------

  _startDemo(session, username) {
    this.mode = 'demo';
    this.username = username;
    this.demoGiftCycle = [];
    this._status('connected', { message: 'Demo mode: simulating gifts and chat' });

    const giftLoop = (delay) => {
      this._setTimer(() => {
        if (session !== this.session) return;
        this.emit('gift', this._demoGift(this._nextDemoEffect()));
        giftLoop(randomBetween(this.options.demoGiftIntervalMs));
      }, delay);
    };
    const chatLoop = (delay) => {
      this._setTimer(() => {
        if (session !== this.session) return;
        this.emit('chat', {
          id: `demo-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: pick(DEMO_CHAT),
          user: { ...pick(DEMO_USERS) },
          timestamp: Date.now()
        });
        chatLoop(randomBetween(this.options.demoChatIntervalMs));
      }, delay);
    };
    let viewers = 120 + Math.floor(Math.random() * 400);
    const viewerLoop = () => {
      this._setTimer(() => {
        if (session !== this.session) return;
        viewers = Math.max(12, viewers + Math.round((Math.random() - 0.4) * 25));
        this.emit('viewers', { count: viewers });
        viewerLoop();
      }, 5000);
    };

    this.emit('viewers', { count: viewers });
    giftLoop(this.options.demoFirstGiftMs);
    chatLoop(400);
    viewerLoop();
  }

  /** Cycles through all three effects in shuffled rounds so each gets tested. */
  _nextDemoEffect() {
    if (this.demoGiftCycle.length === 0) {
      this.demoGiftCycle = shuffled(Object.values(EFFECTS));
    }
    return this.demoGiftCycle.shift();
  }

  _demoGift(effect) {
    const spec = DEMO_GIFTS[effect];
    const count = pick(spec.counts);
    return {
      id: `demo-gift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      effect,
      giftName: spec.giftName,
      giftId: spec.giftId,
      count,
      diamonds: spec.diamonds * count,
      user: { ...pick(DEMO_USERS) },
      timestamp: Date.now()
    };
  }

  // --- helpers ----------------------------------------------------------------

  _status(state, extra = {}) {
    this.emit('status', { state, mode: this.mode, username: this.username, ...extra });
  }

  _setTimer(fn, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
  }

  _clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

module.exports = {
  TikTokConnector,
  EFFECTS,
  DEMO_USERNAME,
  normalizeUsername,
  classifyGift,
  normalizeGift,
  normalizeChat,
  extractAvatarUrl,
  generateAvatar,
  describeError
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  TikTokConnector,
  EFFECTS,
  normalizeUsername,
  classifyGift,
  normalizeGift,
  normalizeChat,
  generateAvatar
} = require('../tiktok-connector');

test('normalizeUsername accepts handles, @handles and profile URLs', () => {
  assert.equal(normalizeUsername('streamer_01'), 'streamer_01');
  assert.equal(normalizeUsername('  @Some.User  '), 'Some.User');
  assert.equal(normalizeUsername('https://www.tiktok.com/@creator.rd/live'), 'creator.rd');
  assert.equal(normalizeUsername('bad name'), null);
  assert.equal(normalizeUsername('@'), null);
  assert.equal(normalizeUsername('<script>'), null);
  assert.equal(normalizeUsername(undefined), null);
});

test('classifyGift maps known gifts by name and unknown gifts by value', () => {
  assert.equal(classifyGift({ name: 'Money Gun', diamonds: 500 }), EFFECTS.MONEY_GUN);
  assert.equal(classifyGift({ name: 'Galaxy', diamonds: 1000 }), EFFECTS.GALAXY);
  assert.equal(classifyGift({ name: 'Rose', diamonds: 1 }), EFFECTS.ROSE);
  assert.equal(classifyGift({ name: 'Lion', diamonds: 29999 }), EFFECTS.GALAXY);
  assert.equal(classifyGift({ name: 'Corgi', diamonds: 599 }), EFFECTS.MONEY_GUN);
  assert.equal(classifyGift({ name: 'Finger Heart', diamonds: 5 }), EFFECTS.ROSE);
});

test('normalizeGift skips streaks in progress and reports the final count', () => {
  const base = {
    giftId: 5655,
    user: {
      userId: '42',
      uniqueId: 'fan',
      nickname: 'Big Fan',
      profilePicture: { url: ['https://p16.example.com/avatar.webp'] }
    },
    giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1 },
    common: { msgId: 'abc' }
  };
  assert.equal(normalizeGift({ ...base, repeatCount: 3, repeatEnd: 0 }), null);

  const gift = normalizeGift({ ...base, repeatCount: 7, repeatEnd: 1 });
  assert.equal(gift.effect, EFFECTS.ROSE);
  assert.equal(gift.count, 7);
  assert.equal(gift.diamonds, 7);
  assert.equal(gift.id, 'abc');
  assert.deepEqual(gift.user, {
    id: '42',
    username: 'fan',
    nickname: 'Big Fan',
    avatarUrl: 'https://p16.example.com/avatar.webp'
  });
});

test('normalizeGift handles non-streakable gifts immediately', () => {
  const gift = normalizeGift({
    giftId: 7168,
    repeatCount: 1,
    repeatEnd: 0,
    user: { uniqueId: 'rich' },
    giftDetails: { giftName: 'Money Gun', diamondCount: 500, giftType: 2 }
  });
  assert.equal(gift.effect, EFFECTS.MONEY_GUN);
  assert.equal(gift.diamonds, 500);
  assert.equal(gift.user.avatarUrl, null);
});

test('normalizeChat trims text and ignores empty messages', () => {
  assert.equal(normalizeChat({ comment: '   ', user: { uniqueId: 'x' } }), null);
  const chat = normalizeChat({ comment: ' hola ', user: { uniqueId: 'x', nickname: 'X' } });
  assert.equal(chat.text, 'hola');
  assert.equal(chat.user.nickname, 'X');
});

test('generateAvatar returns a deterministic, escaped SVG data URL', () => {
  const a = generateAvatar('yeri_santiago');
  assert.equal(a, generateAvatar('yeri_santiago'));
  assert.match(a, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(a.split(',')[1], 'base64').toString();
  assert.match(svg, />YE</);
  assert.doesNotMatch(Buffer.from(generateAvatar('<&>').split(',')[1], 'base64').toString(), /<&>/);
});

test('demo mode emits chat, viewers and rotates through all three gift effects', async () => {
  const connector = new TikTokConnector({
    demoGiftIntervalMs: [5, 10],
    demoChatIntervalMs: [5, 10],
    demoFirstGiftMs: 5
  });
  const gifts = [];
  const chats = [];
  const statuses = [];
  connector.on('gift', (g) => gifts.push(g));
  connector.on('chat', (c) => chats.push(c));
  connector.on('status', (s) => statuses.push(s.state));

  const result = await connector.connect('', { demo: true });
  assert.deepEqual(result, { mode: 'demo', username: 'demo' });

  await new Promise((resolve) => setTimeout(resolve, 700));
  await connector.disconnect();

  assert.ok(gifts.length >= 3, `expected at least 3 gifts, got ${gifts.length}`);
  assert.deepEqual(new Set(gifts.slice(0, 3).map((g) => g.effect)), new Set(Object.values(EFFECTS)));
  assert.ok(chats.length > 0);
  for (const gift of gifts) {
    assert.ok(gift.user.username && gift.user.avatarUrl.startsWith('data:image/svg+xml'));
    assert.ok(gift.count >= 1 && gift.diamonds >= 1);
  }
  assert.deepEqual(statuses, ['connected', 'disconnected']);

  // No events after disconnecting.
  const before = gifts.length + chats.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gifts.length + chats.length, before);
});

function fakeLibrary({ failWith } = {}) {
  const instances = [];
  class TikTokLiveConnection extends EventEmitter {
    constructor(username, options) {
      super();
      this.username = username;
      this.options = options;
      instances.push(this);
    }
    async connect() {
      if (failWith) throw failWith;
      return { roomId: '7777' };
    }
    async disconnect() {
      this.disconnected = true;
    }
  }
  class UserOfflineError extends Error {}
  return {
    instances,
    UserOfflineError,
    lib: {
      TikTokLiveConnection,
      UserOfflineError,
      WebcastEvent: { GIFT: 'gift', CHAT: 'chat', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd' },
      ControlEvent: { DISCONNECTED: 'disconnected', ERROR: 'error' }
    }
  };
}

test('live mode connects by username and relays normalised events', async () => {
  const fake = fakeLibrary();
  const connector = new TikTokConnector({ loadLibrary: async () => fake.lib });
  const events = [];
  for (const type of ['gift', 'chat', 'viewers', 'status']) {
    connector.on(type, (data) => events.push([type, data]));
  }

  const result = await connector.connect('@my.stream');
  assert.deepEqual(result, { mode: 'live', username: 'my.stream' });
  const [connection] = fake.instances;
  assert.equal(connection.username, 'my.stream');

  connection.emit('chat', { comment: 'hi', user: { uniqueId: 'a', nickname: 'A' } });
  connection.emit('gift', {
    repeatCount: 1,
    repeatEnd: 0,
    user: { uniqueId: 'b' },
    giftDetails: { giftName: 'Galaxy', diamondCount: 1000, giftType: 2 }
  });
  connection.emit('roomUser', { viewerCount: 321 });

  const types = events.map(([type]) => type);
  assert.deepEqual(types, ['status', 'status', 'chat', 'gift', 'viewers']);
  assert.equal(events[1][1].state, 'connected');
  assert.equal(events[1][1].roomId, '7777');
  assert.equal(events[3][1].effect, EFFECTS.GALAXY);
  assert.equal(events[4][1].count, 321);

  connection.emit('streamEnd');
  assert.equal(events.at(-1)[1].state, 'ended');
  assert.equal(connector.isActive, false);
});

test('live mode reports a friendly error when the user is not live', async () => {
  const fake = fakeLibrary();
  fake.lib.TikTokLiveConnection.prototype.connect = async () => {
    throw new fake.UserOfflineError('The requested user isn\'t online :(');
  };
  const connector = new TikTokConnector({ loadLibrary: async () => fake.lib });
  const statuses = [];
  connector.on('status', (s) => statuses.push(s));

  await assert.rejects(connector.connect('offline_user'), /@offline_user is not LIVE right now/);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(connector.isActive, false);
});

test('live mode fails cleanly when the library cannot be loaded', async () => {
  const connector = new TikTokConnector({
    loadLibrary: async () => {
      throw new Error('library missing');
    }
  });
  await assert.rejects(connector.connect('someone'), /library missing/);
  assert.equal(connector.isActive, false);
});

test('live mode reconnects after an unexpected disconnect', async () => {
  const fake = fakeLibrary();
  const connector = new TikTokConnector({ loadLibrary: async () => fake.lib, reconnectBaseDelayMs: 5 });
  const statuses = [];
  connector.on('status', (s) => statuses.push(s.state));

  await connector.connect('streamer');
  fake.instances[0].emit('disconnected', { code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(fake.instances.length, 2);
  assert.deepEqual(statuses, ['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected']);
  await connector.disconnect();
});

test('rejects invalid usernames before touching the network', async () => {
  let loaded = false;
  const connector = new TikTokConnector({
    loadLibrary: async () => {
      loaded = true;
      return fakeLibrary().lib;
    }
  });
  await assert.rejects(connector.connect('not a username!'), /valid TikTok username/);
  assert.equal(loaded, false);
});

/**
 * Overlay renderer: username setup, gift alerts + effects, and the chat panel
 * with viewer selection. Talks to the main process only through
 * window.overlayAPI (see preload.js).
 */
(function () {
  'use strict';

  const api = window.overlayAPI;
  const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;
  const MAX_CHAT_ITEMS = 80;
  const MAX_VISIBLE_TOASTS = 3;
  const MIN_ALERT_MS = 4000;

  const GIFT_META = {
    moneygun: { icon: '💸' },
    galaxy: { icon: '🌌' },
    rose: { icon: '🌹' }
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'),
    status: $('status'),
    statusText: $('status-text'),
    form: $('setup-form'),
    input: $('username'),
    field: document.querySelector('.field'),
    connect: $('btn-connect'),
    demo: $('btn-demo'),
    error: $('setup-error'),
    viewers: $('stat-viewers'),
    coins: $('stat-coins'),
    modeBadge: $('mode-badge'),
    alert: $('gift-alert'),
    alertAvatar: $('alert-avatar'),
    alertName: $('alert-name'),
    alertGift: $('alert-gift'),
    alertCount: $('alert-count'),
    alertIcon: $('alert-icon'),
    toasts: $('toasts'),
    spotlight: $('spotlight'),
    spotlightAvatar: $('spotlight-avatar'),
    spotlightName: $('spotlight-name'),
    spotlightText: $('spotlight-text'),
    chatList: $('chat-list'),
    chatJump: $('chat-jump'),
    fx: $('fx')
  };

  const effects = new window.OverlayEffects.EffectsEngine(el.fx);
  const numberFormat = new Intl.NumberFormat();

  const state = {
    view: 'setup',
    connecting: false,
    mode: null,
    username: '',
    coins: 0,
    chat: new Map(), // message id -> { message, node }
    selectedId: null,
    epicQueue: [],
    epicPlaying: false
  };

  // -------------------------------------------------------------------------
  // Setup / connection
  // -------------------------------------------------------------------------

  function cleanUsername(value) {
    let v = String(value || '').trim();
    const url = v.match(/tiktok\.com\/@([^/?#\s]+)/i);
    if (url) v = url[1];
    return v.replace(/^@+/, '');
  }

  function setView(view) {
    state.view = view;
    el.app.dataset.view = view;
    if (view === 'setup') {
      requestAnimationFrame(() => el.input.focus());
    }
  }

  function setStatus(stateName, text) {
    el.status.dataset.state = stateName;
    el.statusText.textContent = text;
    el.status.title = text;
  }

  function showError(message) {
    el.error.textContent = message || '';
    el.field.classList.toggle('invalid', Boolean(message));
  }

  function setConnecting(connecting, button) {
    state.connecting = connecting;
    el.connect.disabled = connecting;
    el.demo.disabled = connecting;
    el.input.disabled = connecting;
    el.connect.classList.toggle('loading', connecting && button === el.connect);
    el.connect.querySelector('.btn-label').textContent =
      connecting && button === el.connect ? 'Connecting…' : 'Connect';
  }

  async function connect({ demo = false } = {}) {
    if (state.connecting) return;
    const username = cleanUsername(el.input.value);

    if (!demo && !USERNAME_PATTERN.test(username)) {
      showError(
        username
          ? 'That doesn\'t look like a TikTok username. Use letters, numbers, "." or "_".'
          : 'Enter your TikTok username to connect.'
      );
      el.input.focus();
      return;
    }

    showError('');
    resetSession();
    setConnecting(true, demo ? el.demo : el.connect);
    setStatus('connecting', demo ? 'Starting demo…' : `Connecting to @${username}…`);

    let result;
    try {
      result = await api.connect({ username: demo ? username || 'demo' : username, demo });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    setConnecting(false);

    if (!result.ok) {
      setStatus('error', 'Not connected');
      showError(`${result.error} You can also try demo mode.`);
      el.input.focus();
      return;
    }

    enterLive(result);
  }

  /** Clears per-session UI. Runs before connecting so early events aren't wiped. */
  function resetSession() {
    state.coins = 0;
    el.coins.textContent = '0';
    el.viewers.textContent = '0';
    stopEpics();
    resetChat();
  }

  function enterLive({ mode, username }) {
    state.mode = mode;
    state.username = username;
    el.modeBadge.hidden = mode !== 'demo';
    setView('live');
  }

  async function disconnect() {
    await api.disconnect();
    state.mode = null;
    stopEpics();
    effects.clear();
    clearSelection();
    setStatus('idle', 'Not connected');
    setView('setup');
  }

  /** Accept chat/viewer events while connecting too: they can beat the connect reply. */
  function acceptingEvents() {
    return state.view === 'live' || state.connecting;
  }

  function handleStatus(status) {
    const who = status.username && status.username !== 'demo' ? `@${status.username}` : '';
    switch (status.state) {
      case 'connecting':
        setStatus('connecting', status.message || 'Connecting…');
        break;
      case 'reconnecting':
        setStatus('reconnecting', status.message || 'Reconnecting…');
        break;
      case 'connected':
        setStatus('connected', status.mode === 'demo' ? 'Demo mode' : `LIVE ${who}`);
        break;
      case 'ended':
        setStatus('ended', 'LIVE ended');
        addSystemMessage(status.message || 'The LIVE has ended.');
        break;
      case 'error':
        setStatus('error', 'Connection lost');
        if (state.view === 'live') addSystemMessage(status.message || 'Connection error.');
        break;
      case 'disconnected':
        if (state.view === 'setup') setStatus('idle', 'Not connected');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Gifts: epic gifts play one at a time; roses play immediately as toasts
  // -------------------------------------------------------------------------

  function handleGift(gift) {
    if (state.view !== 'live') return;
    state.coins += Number(gift.diamonds) || 0;
    el.coins.textContent = numberFormat.format(state.coins);

    if (gift.effect === 'rose') {
      effects.play('rose', { count: gift.count });
      showToast(gift);
      return;
    }
    state.epicQueue.push(gift);
    if (!state.epicPlaying) playNextEpic();
  }

  let epicTimer = null;
  function stopEpics() {
    clearTimeout(epicTimer);
    state.epicQueue = [];
    state.epicPlaying = false;
  }

  function playNextEpic() {
    const gift = state.epicQueue.shift();
    if (!gift || state.view !== 'live') {
      state.epicPlaying = false;
      return;
    }
    state.epicPlaying = true;

    const duration = effects.play(gift.effect, { count: gift.count });
    if (gift.effect === 'galaxy') {
      el.app.classList.remove('shake');
      void el.app.offsetWidth; // restart the CSS animation
      el.app.classList.add('shake');
    }

    const alertMs = Math.max(MIN_ALERT_MS, duration - 800);
    showAlert(gift, alertMs);
    epicTimer = setTimeout(playNextEpic, Math.max(alertMs, duration - 1500) + 400);
  }

  let alertTimer = null;
  function showAlert(gift, ms) {
    clearTimeout(alertTimer);
    el.alert.dataset.effect = gift.effect;
    el.alert.classList.remove('leaving');
    el.alertAvatar.src = gift.user.avatar;
    el.alertAvatar.alt = gift.user.nickname;
    el.alertName.textContent = gift.user.nickname;
    el.alertName.title = `@${gift.user.username}`;
    el.alertGift.textContent = gift.giftName;
    el.alertCount.textContent = gift.count > 1 ? `×${gift.count}` : '';
    el.alertIcon.textContent = (GIFT_META[gift.effect] || GIFT_META.rose).icon;
    el.alert.hidden = false;
    // Restart the entry animation for back-to-back alerts.
    el.alert.style.animation = 'none';
    void el.alert.offsetWidth;
    el.alert.style.animation = '';

    alertTimer = setTimeout(() => {
      el.alert.classList.add('leaving');
      alertTimer = setTimeout(() => {
        el.alert.hidden = true;
      }, 350);
    }, ms);
  }

  function showToast(gift) {
    const toast = document.createElement('div');
    toast.className = 'toast';

    const avatar = document.createElement('img');
    avatar.className = 'toast-avatar';
    avatar.src = gift.user.avatar;
    avatar.alt = '';

    const text = document.createElement('span');
    text.className = 'toast-text';
    const name = document.createElement('b');
    name.textContent = gift.user.nickname;
    text.append(name, ` sent ${gift.giftName}${gift.count > 1 ? ` ×${gift.count}` : ''} 🌹`);

    toast.append(avatar, text);
    el.toasts.prepend(toast);

    while (el.toasts.children.length > MAX_VISIBLE_TOASTS) {
      el.toasts.lastElementChild.remove();
    }
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  // -------------------------------------------------------------------------
  // Chat + viewer selection
  // -------------------------------------------------------------------------

  function isNearBottom() {
    const list = el.chatList;
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function scrollToBottom() {
    el.chatList.scrollTop = el.chatList.scrollHeight;
    el.chatJump.hidden = true;
  }

  function resetChat() {
    state.chat.clear();
    state.selectedId = null;
    el.chatList.replaceChildren(emptyChatNode());
    el.spotlight.hidden = true;
    el.chatJump.hidden = true;
  }

  function emptyChatNode() {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = 'Waiting for chat messages…';
    return li;
  }

  function appendChatNode(li) {
    const stick = isNearBottom();
    el.chatList.querySelector('.chat-empty')?.remove();
    el.chatList.append(li);

    while (state.chat.size > MAX_CHAT_ITEMS) {
      const [oldestId, oldest] = state.chat.entries().next().value;
      if (oldestId === state.selectedId) {
        // Keep the selected message alive; drop the next-oldest instead.
        const entries = [...state.chat.entries()];
        const [id, entry] = entries[1];
        entry.node.remove();
        state.chat.delete(id);
      } else {
        oldest.node.remove();
        state.chat.delete(oldestId);
      }
    }

    if (stick) scrollToBottom();
    else el.chatJump.hidden = false;
  }

  function handleChat(message) {
    if (!acceptingEvents()) return;

    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item';
    button.dataset.id = message.id;
    button.title = `Select @${message.user.username}`;

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = message.user.avatar;
    avatar.alt = '';

    const content = document.createElement('div');
    content.className = 'chat-content';
    const name = document.createElement('span');
    name.className = 'chat-name';
    name.textContent = message.user.nickname;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = message.text;
    content.append(name, text);

    button.append(avatar, content);
    li.append(button);

    state.chat.set(message.id, { message, node: li });
    appendChatNode(li);
  }

  function addSystemMessage(text) {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = text;
    const stick = isNearBottom();
    el.chatList.append(li);
    if (stick) scrollToBottom();
  }

  function selectMessage(id, { fromRandom = false } = {}) {
    const entry = state.chat.get(id);
    if (!entry) return;
    if (state.selectedId === id && !fromRandom) {
      clearSelection();
      return;
    }
    el.chatList.querySelector('.chat-item.selected')?.classList.remove('selected');
    const button = entry.node.querySelector('.chat-item');
    button.classList.add('selected');
    state.selectedId = id;

    const { user, text } = entry.message;
    el.spotlightAvatar.src = user.avatar;
    el.spotlightAvatar.alt = user.nickname;
    el.spotlightName.textContent = `${user.nickname}  ·  @${user.username}`;
    el.spotlightText.textContent = text;
    el.spotlight.hidden = false;

    if (fromRandom) {
      button.classList.remove('picked');
      void button.offsetWidth;
      button.classList.add('picked');
      button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function clearSelection() {
    el.chatList.querySelector('.chat-item.selected')?.classList.remove('selected');
    state.selectedId = null;
    el.spotlight.hidden = true;
  }

  /** Picks a random viewer (each chatter weighted equally) and selects their latest message. */
  function pickRandomViewer() {
    const latestByUser = new Map();
    for (const [id, { message }] of state.chat) {
      latestByUser.set(message.user.username, id);
    }
    const ids = [...latestByUser.values()];
    if (!ids.length) return;
    const id = ids[Math.floor(Math.random() * ids.length)];
    selectMessage(id, { fromRandom: true });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function testGift(effect) {
    if (state.view === 'live') api.testGift(effect);
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
  el.demo.addEventListener('click', () => connect({ demo: true }));
  el.input.addEventListener('input', () => showError(''));

  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-random').addEventListener('click', pickRandomViewer);
  $('btn-spotlight-close').addEventListener('click', clearSelection);
  el.chatJump.addEventListener('click', scrollToBottom);
  el.chatList.addEventListener('scroll', () => {
    if (isNearBottom()) el.chatJump.hidden = true;
  });
  el.chatList.addEventListener('click', (event) => {
    const item = event.target.closest('.chat-item');
    if (item) selectMessage(item.dataset.id);
  });
  document.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', () => testGift(button.dataset.test));
  });

  $('btn-minimize').addEventListener('click', () => api.windowAction('minimize'));
  $('btn-close').addEventListener('click', () => api.windowAction('close'));
  $('btn-pin').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const result = await api.windowAction('toggle-pin');
    if (!result) return;
    button.setAttribute('aria-pressed', String(result.pinned));
    button.title = `Keep on top (${result.pinned ? 'on' : 'off'})`;
  });

  el.app.addEventListener('animationend', (event) => {
    if (event.animationName === 'shake') el.app.classList.remove('shake');
  });

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'Escape') clearSelection();
    if (event.key === '1') testGift('moneygun');
    if (event.key === '2') testGift('galaxy');
    if (event.key === '3') testGift('rose');
  });

  api.onEvent(({ type, data }) => {
    switch (type) {
      case 'gift':
        handleGift(data);
        break;
      case 'chat':
        handleChat(data);
        break;
      case 'viewers':
        if (acceptingEvents()) el.viewers.textContent = numberFormat.format(data.count);
        break;
      case 'status':
        handleStatus(data);
        break;
    }
  });

  (async function init() {
    setView('setup');
    const settings = await api.getSettings();
    if (settings.lastUsername) {
      el.input.value = settings.lastUsername;
      el.input.select();
    }
    if (settings.autoStart === 'demo') connect({ demo: true });
  })();
})();

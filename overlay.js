/**
 * Overlay renderer: username setup, gift alerts + effects, and the big-donor
 * selector (Money Gun / Galaxy donors with their last chat message). Talks to the main process only through
 * window.overlayAPI (see preload.js).
 */
(function () {
  'use strict';

  const api = window.overlayAPI;
  const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;
  const MAX_DONORS = 200;
  const MAX_REMEMBERED_CHATTERS = 1000;
  const MAX_VISIBLE_TOASTS = 3;
  const MIN_ALERT_MS = 4000;
  const DONOR_PANEL_MS = 20000; // how long the donor list stays up after a donation
  const HUD_IDLE_MS = 2500; // hide streamer controls after the mouse stops moving

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
    spotlightHandle: $('spotlight-handle'),
    spotlightText: $('spotlight-text'),
    spotlightGifts: $('spotlight-gifts'),
    chatList: $('chat-list'),
    donors: $('donors'),
    hud: $('hud'),
    hudNotice: $('hud-notice'),
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
    donors: new Map(), // username -> { user, message, gifts, coins, node }, oldest donation first
    lastMessages: new Map(), // username -> { text, timestamp } for every chatter
    selectedUser: null,
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
    resetDonors();
    showNotice('');
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
    closeDonorPanel();
    showNotice('');
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
        showNotice(status.message || 'Reconnecting…');
        break;
      case 'connected':
        setStatus('connected', status.mode === 'demo' ? 'Demo mode' : `LIVE ${who}`);
        showNotice('');
        break;
      case 'ended':
        setStatus('ended', 'LIVE ended');
        showNotice(status.message || 'The LIVE has ended.');
        break;
      case 'error':
        setStatus('error', 'Connection lost');
        if (state.view === 'live') showNotice(status.message || 'Connection error.');
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

    if (!isBigGift(gift)) {
      effects.play('rose', { count: gift.count });
      showToast(gift);
      return;
    }
    addDonor(gift);
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
  // Big donors: one row per Money Gun / Galaxy donor with their last message
  // -------------------------------------------------------------------------

  /** Gifts that make someone a "big donor" (Money Gun, Galaxy, or equally valuable gifts). */
  function isBigGift(gift) {
    return gift.effect === 'moneygun' || gift.effect === 'galaxy';
  }

  /**
   * Remembers every viewer's latest message (not displayed) so a donor's last
   * message is known even if they chatted before donating.
   */
  function rememberMessage(message) {
    const key = message.user.username;
    state.lastMessages.delete(key);
    state.lastMessages.set(key, { text: message.text, timestamp: message.timestamp });
    if (state.lastMessages.size > MAX_REMEMBERED_CHATTERS) {
      state.lastMessages.delete(state.lastMessages.keys().next().value);
    }
  }

  function handleChat(message) {
    if (!acceptingEvents()) return;
    rememberMessage(message);

    const donor = state.donors.get(message.user.username);
    if (!donor) return;
    donor.message = state.lastMessages.get(message.user.username);
    renderDonor(donor);
    flash(donor.node.querySelector('.chat-item'), 'updated');
    if (state.selectedUser === donor.user.username) renderSpotlight();
  }

  function addDonor(gift) {
    const key = gift.user.username;
    let donor = state.donors.get(key);
    if (donor) {
      state.donors.delete(key); // re-insert so the Map stays oldest-first
    } else {
      donor = {
        user: gift.user,
        message: state.lastMessages.get(key) || null,
        gifts: { moneygun: 0, galaxy: 0 },
        coins: 0,
        node: createDonorNode(key)
      };
    }
    donor.user = gift.user;
    donor.gifts[gift.effect] += gift.count;
    donor.coins += Number(gift.diamonds) || 0;
    state.donors.set(key, donor);

    renderDonor(donor);
    el.chatList.querySelector('.chat-empty')?.remove();
    el.chatList.prepend(donor.node); // newest donation on top
    el.chatList.scrollTop = 0;
    el.donors.classList.remove('empty');
    trimDonors();
    openDonorPanel();
    if (state.selectedUser === key) renderSpotlight();
  }

  function trimDonors() {
    for (const [key, donor] of state.donors) {
      if (state.donors.size <= MAX_DONORS) break;
      if (key === state.selectedUser) continue;
      donor.node.remove();
      state.donors.delete(key);
    }
  }

  function createDonorNode(username) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item donor';
    button.dataset.username = username;
    button.title = `Select @${username}`;

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.alt = '';

    const content = document.createElement('div');
    content.className = 'chat-content';
    const name = document.createElement('span');
    name.className = 'chat-name';
    const text = document.createElement('span');
    text.className = 'chat-text';
    content.append(name, text);

    const badges = document.createElement('span');
    badges.className = 'donor-badges';

    button.append(avatar, content, badges);
    li.append(button);
    return li;
  }

  function giftSummary(gifts) {
    return ['moneygun', 'galaxy']
      .filter((effect) => gifts[effect] > 0)
      .map((effect) => `${GIFT_META[effect].icon}×${gifts[effect]}`)
      .join(' ');
  }

  /** Row format: "username: last message", or just "username" if they haven't chatted. */
  function renderDonor(donor) {
    const { node, user, message } = donor;
    node.querySelector('.chat-avatar').src = user.avatar;
    node.querySelector('.chat-name').textContent = message ? `${user.username}:` : user.username;
    node.querySelector('.chat-text').textContent = message ? message.text : '';
    node.querySelector('.donor-badges').textContent = giftSummary(donor.gifts);
  }

  function flash(node, className) {
    node.classList.remove(className);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(className);
  }

  function resetDonors() {
    state.donors.clear();
    state.lastMessages.clear();
    state.selectedUser = null;
    el.chatList.replaceChildren(emptyDonorsNode());
    el.donors.classList.add('empty');
    closeDonorPanel();
    el.spotlight.hidden = true;
  }

  function emptyDonorsNode() {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = 'Money Gun and Galaxy donors appear here';
    return li;
  }

  // -------------------------------------------------------------------------
  // Visibility: keep the stream clean
  // -------------------------------------------------------------------------

  /** Shows the donor list for a while after a donation, then fades it out. */
  let donorPanelTimer = null;
  function openDonorPanel() {
    el.donors.classList.add('open');
    clearTimeout(donorPanelTimer);
    donorPanelTimer = setTimeout(() => el.donors.classList.remove('open'), DONOR_PANEL_MS);
  }

  function closeDonorPanel() {
    clearTimeout(donorPanelTimer);
    el.donors.classList.remove('open');
  }

  /**
   * Streamer-only messages (reconnecting, LIVE ended…) go in the HUD, which
   * stays visible while a notice is showing.
   */
  function showNotice(text) {
    el.hudNotice.textContent = text || '';
    el.hudNotice.hidden = !text;
    el.app.classList.toggle('attention', Boolean(text));
  }

  /** The HUD appears while the mouse moves over the window and fades when idle. */
  let pointerTimer = null;
  function setPointerActive(active) {
    el.app.classList.toggle('pointer-active', active);
  }

  document.addEventListener('mousemove', (event) => {
    setPointerActive(true);
    clearTimeout(pointerTimer);
    // Keep controls up while you're using them.
    if (event.target.closest('.hud, .donor-column')) return;
    pointerTimer = setTimeout(() => setPointerActive(false), HUD_IDLE_MS);
  });
  document.documentElement.addEventListener('mouseleave', () => {
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => setPointerActive(false), 400);
  });

  function selectDonor(username, { fromRandom = false } = {}) {
    const donor = state.donors.get(username);
    if (!donor) return;
    if (state.selectedUser === username && !fromRandom) {
      clearSelection();
      return;
    }
    el.chatList.querySelector('.chat-item.selected')?.classList.remove('selected');
    const button = donor.node.querySelector('.chat-item');
    button.classList.add('selected');
    state.selectedUser = username;
    renderSpotlight();

    if (fromRandom) {
      flash(button, 'picked');
      button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function renderSpotlight() {
    const donor = state.donors.get(state.selectedUser);
    if (!donor) return;
    const { user, message } = donor;
    el.spotlightAvatar.src = user.avatar;
    el.spotlightAvatar.alt = user.nickname;
    el.spotlightName.textContent = user.nickname;
    el.spotlightHandle.textContent = `@${user.username}`;
    el.spotlightText.textContent = message ? message.text : 'No messages yet';
    el.spotlightText.classList.toggle('muted', !message);
    el.spotlightGifts.textContent = `Sent ${giftSummary(donor.gifts)}`;
    el.spotlight.hidden = false;
  }

  function clearSelection() {
    el.chatList.querySelector('.chat-item.selected')?.classList.remove('selected');
    state.selectedUser = null;
    el.spotlight.hidden = true;
  }

  /** Picks one big donor at random, each donor weighted equally. */
  function pickRandomDonor() {
    const usernames = [...state.donors.keys()];
    if (!usernames.length) return;
    selectDonor(usernames[Math.floor(Math.random() * usernames.length)], { fromRandom: true });
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
  $('btn-random').addEventListener('click', pickRandomDonor);
  $('btn-spotlight-close').addEventListener('click', clearSelection);
  el.chatList.addEventListener('click', (event) => {
    const item = event.target.closest('.chat-item');
    if (item) selectDonor(item.dataset.username);
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
    if (event.key === 'r' || event.key === 'R') {
      if (state.view === 'live') pickRandomDonor();
    }
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

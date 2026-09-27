/**
 * Overlay renderer: username setup, gift alerts + effects, and the donor
 * queue (Money Gun / Galaxy donors with their messages, so you can copy the
 * username they type). Talks to the main process only through
 * window.overlayAPI (see preload.js).
 */
(function () {
  'use strict';

  const api = window.overlayAPI;
  const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;
  const MAX_REMEMBERED_CHATTERS = 1000;
  const MESSAGES_PER_DONOR = 3; // most recent messages shown on a donor's card
  const EARLIER_MESSAGES_MS = 2 * 60 * 1000; // include messages sent up to 2 min before donating
  const MAX_VISIBLE_TOASTS = 3;
  const MIN_ALERT_MS = 4000;
  const HUD_IDLE_MS = 2500; // hide streamer controls this long after the mouse leaves them
  const HOT_ZONE_PX = 56; // rest the mouse in this strip at the top to show the controls
  const HOT_ZONE_DWELL_MS = 350;
  const CORNER_PX = 36; // bottom-right corner that shows the resize grip

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
    queue: $('queue'),
    queueList: $('queue-list'),
    queueCount: $('queue-count'),
    hud: $('hud'),
    hudNotice: $('hud-notice'),
    fx: $('fx')
  };

  const effects = new window.OverlayEffects.EffectsEngine(el.fx);
  const numberFormat = new Intl.NumberFormat();

  const state = {
    view: 'setup',
    connecting: false,
    resizing: false,
    mode: null,
    username: '',
    coins: 0,
    queue: new Map(), // username -> donor waiting to be handled, oldest first
    chatters: new Map(), // username -> their last few messages (every viewer)
    pickedUser: null,
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
    setClickThrough(view === 'live');
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
    resetQueue();
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
    clearPick();
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
  // Donor queue: Money Gun / Galaxy donors wait here with their messages
  // until you've entered their username and mark them done.
  // -------------------------------------------------------------------------

  /** Gifts that put someone in the queue (Money Gun, Galaxy, or equally valuable gifts). */
  function isBigGift(gift) {
    return gift.effect === 'moneygun' || gift.effect === 'galaxy';
  }

  /**
   * Remembers every viewer's recent messages (not displayed) so a donor's
   * username is available even if they typed it right before donating.
   */
  function rememberMessage(message) {
    const key = message.user.username;
    const recent = (state.chatters.get(key) || []).concat(message).slice(-MESSAGES_PER_DONOR);
    state.chatters.delete(key);
    state.chatters.set(key, recent);
    if (state.chatters.size > MAX_REMEMBERED_CHATTERS) {
      state.chatters.delete(state.chatters.keys().next().value);
    }
  }

  function handleChat(message) {
    if (!acceptingEvents()) return;
    rememberMessage(message);

    const donor = state.queue.get(message.user.username);
    if (!donor || message.timestamp < donor.resetAt) return;
    donor.messages = donor.messages.concat(message).slice(-MESSAGES_PER_DONOR);
    renderMessages(donor);
    flash(donor.node, 'updated');
  }

  function addDonor(gift) {
    const key = gift.user.username;
    let donor = state.queue.get(key);
    if (!donor) {
      // Start with anything they wrote shortly before donating.
      const since = Date.now() - EARLIER_MESSAGES_MS;
      donor = {
        user: gift.user,
        gifts: { moneygun: 0, galaxy: 0 },
        messages: (state.chatters.get(key) || []).filter((m) => m.timestamp >= since),
        resetAt: 0,
        copiedId: null,
        node: createDonorCard(key)
      };
      state.queue.set(key, donor);
      el.queueList.append(donor.node); // oldest donor first, like a line
      renderMessages(donor);
    }
    donor.user = gift.user;
    donor.gifts[gift.effect] += gift.count;
    renderDonorHead(donor);
    updateQueueState();
    flash(donor.node, 'updated');
    donor.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function createDonorCard(username) {
    const card = document.createElement('li');
    card.className = 'donor-card';
    card.dataset.username = username;

    const head = document.createElement('div');
    head.className = 'donor-head';

    const avatar = document.createElement('img');
    avatar.className = 'donor-avatar';
    avatar.alt = '';

    const id = document.createElement('div');
    id.className = 'donor-id';
    const name = document.createElement('span');
    name.className = 'donor-name';
    const handle = document.createElement('span');
    handle.className = 'donor-handle';
    const gifts = document.createElement('span');
    gifts.className = 'donor-gifts';
    const sub = document.createElement('div');
    sub.className = 'donor-sub';
    sub.append(handle, gifts);
    id.append(name, sub);

    const actions = document.createElement('div');
    actions.className = 'donor-actions';
    actions.append(
      actionButton('reset', '↻', 'Reset: clear their messages and wait for a new one'),
      actionButton('done', '✓', 'Done: remove from the queue')
    );

    head.append(avatar, id, actions);

    const messages = document.createElement('ol');
    messages.className = 'donor-messages';

    card.append(head, messages);
    return card;
  }

  function actionButton(action, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `donor-action ${action}`;
    button.dataset.action = action;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    return button;
  }

  function giftSummary(gifts) {
    return ['moneygun', 'galaxy']
      .filter((effect) => gifts[effect] > 0)
      .map((effect) => `${GIFT_META[effect].icon}×${gifts[effect]}`)
      .join(' ');
  }

  function renderDonorHead(donor) {
    const { node, user } = donor;
    node.querySelector('.donor-avatar').src = user.avatar;
    node.querySelector('.donor-name').textContent = user.nickname;
    node.querySelector('.donor-handle').textContent = `@${user.username}`;
    node.querySelector('.donor-gifts').textContent = giftSummary(donor.gifts);
  }

  /** A single word (no spaces) is most likely the username they were asked for. */
  function looksLikeUsername(text) {
    return /^\S{3,40}$/.test(text.trim());
  }

  function renderMessages(donor) {
    const list = donor.node.querySelector('.donor-messages');
    if (!donor.messages.length) {
      const waiting = document.createElement('li');
      waiting.className = 'donor-waiting';
      waiting.textContent = 'Waiting for their message…';
      list.replaceChildren(waiting);
      return;
    }
    list.replaceChildren(
      ...donor.messages.map((message) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'donor-message';
        button.dataset.id = message.id;
        button.title = 'Click to copy';
        button.classList.toggle('likely', looksLikeUsername(message.text));
        button.classList.toggle('copied', message.id === donor.copiedId);
        button.textContent = message.text;
        li.append(button);
        return li;
      })
    );
  }

  async function copyMessage(donor, messageId) {
    const message = donor.messages.find((m) => m.id === messageId);
    if (!message) return;
    const result = await api.copyText(message.text.trim());
    if (!result?.ok) return;
    donor.copiedId = message.id;
    renderMessages(donor);
  }

  /** Clears what they've written so far; only new messages will show. */
  function resetDonor(donor) {
    donor.resetAt = Date.now();
    donor.messages = [];
    donor.copiedId = null;
    renderMessages(donor);
  }

  function removeDonor(donor) {
    const key = donor.user.username;
    if (!state.queue.has(key)) return;
    state.queue.delete(key);
    if (state.pickedUser === key) state.pickedUser = null;
    donor.node.classList.add('leaving');
    setTimeout(() => {
      donor.node.remove();
      updateQueueState();
    }, 250);
    updateQueueState();
  }

  function updateQueueState() {
    const empty = state.queue.size === 0;
    el.queue.classList.toggle('empty', empty);
    el.queueCount.textContent = empty ? '' : String(state.queue.size);
  }

  function resetQueue() {
    state.queue.clear();
    state.chatters.clear();
    state.pickedUser = null;
    el.queueList.replaceChildren();
    updateQueueState();
  }

  function flash(node, className) {
    node.classList.remove(className);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(className);
  }

  /** Marks one waiting donor at random, each donor with an equal chance. */
  function pickRandomDonor() {
    const usernames = [...state.queue.keys()];
    if (!usernames.length) return;
    clearPick();
    state.pickedUser = usernames[Math.floor(Math.random() * usernames.length)];
    const node = state.queue.get(state.pickedUser).node;
    node.classList.add('picked');
    flash(node, 'updated');
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearPick() {
    el.queueList.querySelector('.donor-card.picked')?.classList.remove('picked');
    state.pickedUser = null;
  }

  // -------------------------------------------------------------------------
  // Visibility: keep the stream clean
  // -------------------------------------------------------------------------

  /**
   * Streamer-only messages (reconnecting, LIVE ended…) go in the HUD, which
   * stays visible while a notice is showing.
   */
  function showNotice(text) {
    el.hudNotice.textContent = text || '';
    el.hudNotice.hidden = !text;
    el.app.classList.toggle('attention', Boolean(text));
  }

  /**
   * While live, clicks pass through the overlay to whatever is behind it
   * (your browser, the game…), except over the controls, donor cards and
   * resize grip. The controls only appear when you rest the mouse on the
   * strip at the top, so using the window behind never shows them on stream.
   */
  let clickThrough = null;
  function setClickThrough(on) {
    if (on === clickThrough) return;
    clickThrough = on;
    api.setClickThrough(on);
  }

  let hideTimer = null;
  let dwellTimer = null;
  const pointerActive = () => el.app.classList.contains('pointer-active');

  function setPointerActive(active) {
    el.app.classList.toggle('pointer-active', active);
  }

  function keepControls() {
    clearTimeout(hideTimer);
    hideTimer = null;
    setPointerActive(true);
  }

  function hideControlsSoon(ms) {
    if (hideTimer || !pointerActive()) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      setPointerActive(false);
      updateClickThrough();
    }, ms);
  }

  const lastPointer = { x: -1, y: -1 };

  function updateClickThrough() {
    if (state.view !== 'live') return;
    const target = document.elementFromPoint(lastPointer.x, lastPointer.y);
    setClickThrough(!target?.closest('.hud, .donor-card, .resize-grip'));
  }

  function cancelDwell() {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }

  document.addEventListener('mousemove', (event) => {
    if (state.resizing) return;
    const { clientX: x, clientY: y } = event;
    lastPointer.x = x;
    lastPointer.y = y;
    el.app.classList.toggle('corner-active', x > innerWidth - CORNER_PX && y > innerHeight - CORNER_PX);

    const under = document.elementFromPoint(x, y);
    if (under?.closest('.hud')) {
      cancelDwell();
      keepControls();
    } else if (y < HOT_ZONE_PX) {
      if (!pointerActive() && !dwellTimer) {
        dwellTimer = setTimeout(() => {
          dwellTimer = null;
          keepControls();
          updateClickThrough();
        }, HOT_ZONE_DWELL_MS);
      }
    } else {
      cancelDwell();
      hideControlsSoon(HUD_IDLE_MS);
    }

    // Re-check after the classes above changed what's under the mouse.
    updateClickThrough();
  });

  document.documentElement.addEventListener('mouseleave', () => {
    if (state.resizing) return;
    cancelDwell();
    el.app.classList.remove('corner-active');
    hideControlsSoon(400);
    if (state.view === 'live') setClickThrough(true);
  });

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
  el.queueList.addEventListener('click', (event) => {
    const card = event.target.closest('.donor-card');
    const donor = card && state.queue.get(card.dataset.username);
    if (!donor) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'done') removeDonor(donor);
    else if (action === 'reset') resetDonor(donor);
    else {
      const message = event.target.closest('.donor-message');
      if (message) copyMessage(donor, message.dataset.id);
    }
  });
  document.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', () => testGift(button.dataset.test));
  });

  $('btn-minimize').addEventListener('click', () => api.windowAction('minimize'));
  $('btn-fit').addEventListener('click', () => api.windowAction('fit-9-16'));

  // Corner grip: the main process resizes from the size the window had when the drag began.
  const grip = $('resize-grip');
  let drag = null;
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    grip.setPointerCapture(event.pointerId);
    drag = { x: event.screenX, y: event.screenY, dx: 0, dy: 0, frame: 0 };
    state.resizing = true;
    api.resize('start');
  });
  grip.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.dx = event.screenX - drag.x;
    drag.dy = event.screenY - drag.y;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      api.resize('move', drag.dx, drag.dy);
    });
  });
  const endDrag = () => {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    api.resize('end', drag.dx, drag.dy);
    drag = null;
    state.resizing = false;
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
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
    if (event.key === 'Escape') clearPick();
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
    const settings = await api.getSettings();
    if (settings.autoStart === 'demo') {
      connect({ demo: true });
    } else if (settings.lastUsername) {
      // Reconnect to the saved username straight away.
      el.input.value = settings.lastUsername;
      connect();
    } else {
      setView('setup');
    }
  })();
})();

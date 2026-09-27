# TikTok LIVE Donation Overlay

A floating, always-on-top Electron overlay for TikTok LIVE. Enter your TikTok username and it connects to your stream. Gifts trigger full-window effects that show the donor's name and profile picture. Everyone who sends a Money Gun or Galaxy goes into a **donor queue** with their messages, so you can copy the username they type and mark them done. Regular chat is not shown.

- **Money Gun**: money guns fire from the bottom corners with muzzle flashes, sparks and gold light rays. Detailed banknotes and gold coins tumble in 3D at different depths, then rain down and pile up at the bottom.
- **Galaxy**: an impact cracks the screen (with a shockwave and colour fringes), the glass shatters in slow motion, a hyperspace jump opens onto a spiral galaxy with nebulae and a lens flare, and it all collapses into a supernova.
- **Roses**: roses, rosebuds and petals drift down with depth of field (distant ones soft, some large petals passing close), a soft pink glow and sparkles.

The effects scale with the window, and their drawings are rendered at the size they're shown, so they stay sharp in a big window. If your PC gets busy (game plus stream), the particle count drops automatically to keep things smooth.

You don't need a login or API keys, only your username.

## Quick start

```bash
npm install
npm start          # opens the overlay and asks for your TikTok username
npm run demo       # opens straight into demo mode
```

1. Type your username (`yourname`, `@yourname`, or your profile URL all work).
2. Press **Connect**. The overlay joins your LIVE and starts showing gifts and chat right away.
3. Your username is remembered. Next time the overlay reconnects to it automatically, without showing the setup screen.

To try it without going live, click **Try demo mode** (or type `demo`).

## Demo mode

Demo mode simulates a busy stream:

- A gift arrives every **10–15 seconds**. Each round of three plays Money Gun, Galaxy and Roses in a shuffled order, so every effect gets tested.
- Chat messages from simulated viewers (with generated avatars) arrive every 1.5–4 seconds.
- The viewer count moves up and down.

## Using the overlay

### Stream layout

The window is locked to **9:16**, the same shape as a TikTok LIVE, so you can place it over the part of your screen you stream. Only things meant for viewers are shown, and they stay out of TikTok's own interface:

| Zone | TikTok puts here | Overlay keeps clear |
| --- | --- | --- |
| Top ~15% | Your profile, "Gaming Ranking", "LIVE Goal" | Donor card starts below it |
| Bottom ~12% | Link / guests / share buttons | Donor queue sits above it |
| Sides ~11% | Cropped on tall phones (the video fills the phone's height) | Nothing important placed there |
| Bottom-left | Viewers' comments | Donor queue is on the right |

When nobody is donating, the overlay is **completely transparent**. Your stream looks exactly as it does without it.

- **Streamer controls** (title bar, viewers/coins, 🎲 Random pick, test buttons, Disconnect) appear only while your mouse moves over the window. They fade out 2.5 seconds after the mouse stops, but stay while you're pointing at them. If the connection drops or the LIVE ends, they stay visible with a message until it's resolved.
- **The donor queue** is hidden while it's empty. Donors appear in the lower-right when they send a Money Gun or Galaxy, and each one stays until you mark them done.
- **The ↻ and ✓ buttons** on each donor only show while your mouse is over the window, so they never appear on stream.

To adjust the zones, edit `--safe-top`, `--safe-bottom` and `--safe-x` in `overlay.css` (`.stage`).

> If you capture your whole screen, viewers also see the controls while your mouse is over the overlay. Move the mouse away, or use keyboard shortcuts, to keep the stream clean.

### Donor queue

Built for giveaways where donors type their username in chat:

1. Someone sends a **Money Gun or Galaxy**. The effect plays, and a card for them joins the queue. The oldest donor is at the top.
2. The card shows **only that person's messages**: up to their last 3, including anything they wrote in the 2 minutes before donating. It says "Waiting for their message…" until they write something.
3. **Click a message to copy it**, then paste it wherever you need it (for example, the site where you send the game). The copied message is marked **✓ Copied**.
4. If they wrote something that isn't their username, press **↻ Reset**. Their messages are cleared, and only what they write next appears.
5. When you're done with them, press **✓ Done** to remove the card.

Other details:

- One-word messages (no spaces) are highlighted, since those are most likely the username.
- If the same person donates again while they're waiting, their existing card is updated instead of adding a second one.
- Roses and other small gifts still play their effect and a small pop-up message, but they don't add anyone to the queue.
- The donor card at the top still appears automatically on each donation, then disappears.

| Action | How |
| --- | --- |
| Copy a message | Click it |
| Clear a donor's messages | **↻** on their card (visible while your mouse is over the window) |
| Remove a donor | **✓** on their card |
| Random donor pick | **🎲 Random pick** (or `R`) marks one waiting donor with 🎲, each with an equal chance. `Esc` clears it. |
| Test effects | The 💸 🌌 🌹 buttons, or keys `1` `2` `3`. These work in live mode too. |
| Move the window | Move the mouse over the overlay, then drag the title bar. |
| Always on top | The pin button in the title bar. |
| Change username | **Disconnect** |

How gifts map to effects:

| Gift | Effect |
| --- | --- |
| Money Gun | Money rain |
| Galaxy | Screen break + galaxy |
| Rose | Falling roses |
| Any other gift | By coin value: ≥ 1000 → Galaxy, ≥ 500 → Money Gun, otherwise Roses |

Big effects (Money Gun and Galaxy) play one at a time, so nobody's gift gets hidden behind someone else's. Roses play immediately and show a small toast. Combo streaks trigger once, when the streak ends, using the final count (for example "Rose ×25").

## How the live connection works

`tiktok-connector.js` uses [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector), which reads TikTok's public LIVE webcast from a username. It uses the free Euler Stream signing service by default. If you hit rate limits, you can set an optional key:

```bash
EULER_API_KEY=your_key npm start
```

The connector also:

- shows a clear message if the account isn't live, doesn't exist, or there's a network problem, and offers demo mode;
- reconnects automatically with backoff (5 attempts) if the connection drops;
- recognizes the end of a stream and shows "LIVE ended".

## Event feed for OBS and other tools (optional)

While running, the app publishes every event as JSON on `ws://127.0.0.1:21213`:

```json
{ "type": "gift", "data": { "effect": "galaxy", "giftName": "Galaxy", "count": 1, "diamonds": 1000, "user": { "username": "...", "nickname": "...", "avatar": "data:image/..." } } }
```

Event types are `gift`, `chat`, `viewers` and `status`. To save bandwidth on busy streams, `chat` events don't include a downloaded avatar; gift events do. The feed only listens on localhost. Browser pages are accepted only from local origins (file or localhost). Change the port with `OVERLAY_WS_PORT=9000`, or turn the feed off with `OVERLAY_WS_PORT=off`.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron entry point. Creates the floating window, owns the connector, fetches avatars, runs IPC and the event feed. |
| `preload.js` | Security bridge. Exposes only `window.overlayAPI` to the page. |
| `tiktok-connector.js` | Connection to TikTok LIVE by username, event normalization, and demo mode. |
| `effects.js` | Canvas effects engine (money rain, galaxy, roses). |
| `overlay.html` / `overlay.css` / `overlay.js` | UI: username setup, gift alerts, donor queue. |
| `test/` | Unit tests for the connector (`npm test`). |

## Security

- The renderer runs with `contextIsolation`, `sandbox`, and no Node.js integration. Navigation and pop-ups are blocked.
- A strict Content-Security-Policy allows only local scripts and styles, and images only from `data:` URLs.
- Profile pictures are downloaded by the main process (size-limited, with a timeout, image types only) and passed to the page as data URLs.
- Chat text and names are always inserted with `textContent`, never parsed as HTML.

## Troubleshooting

- **"@name is not LIVE right now"**: start your LIVE on TikTok first, then press Connect.
- **Black or white background on Linux**: your desktop needs a compositor for transparent windows (most modern desktops have one).
- **Running as root on Linux** (containers, CI): add `--no-sandbox`, for example `npx electron . --no-sandbox`.

## Development

```bash
npm test       # connector unit tests (demo mode, gift/chat normalization, reconnects, errors)
npm run lint   # syntax check for all scripts
```

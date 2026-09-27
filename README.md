# TikTok LIVE Donation Overlay

A floating, always-on-top Electron overlay for TikTok LIVE. Enter your TikTok username and it connects to your stream. Gifts trigger full-window effects that show the donor's name and profile picture. Below, a **big donor selector** lists everyone who sent a Money Gun or Galaxy, so you can pick among them. Regular chat is not shown.

- **Money Gun**: bills and coins fire from the bottom corners, then rain down across the window.
- **Galaxy**: the screen cracks, shatters, and opens onto a rotating spiral galaxy.
- **Roses**: roses and petals fall gently from the top.

You don't need a login or API keys, only your username.

## Quick start

```bash
npm install
npm start          # opens the overlay and asks for your TikTok username
npm run demo       # opens straight into demo mode
```

1. Type your username (`yourname`, `@yourname`, or your profile URL all work).
2. Press **Connect**. The overlay joins your LIVE and starts showing gifts and chat right away.
3. Your username is remembered for next time.

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
| Bottom ~12% | Link / guests / share buttons | Donor list sits above it |
| Sides ~11% | Cropped on tall phones (the video fills the phone's height) | Nothing important placed there |
| Bottom-left | Viewers' comments | Donor list is on the right |

When nobody is donating, the overlay is **completely transparent**. Your stream looks exactly as it does without it.

- **Streamer controls** (title bar, viewers/coins, 🎲 Random pick, test buttons, Disconnect) appear only while your mouse moves over the window. They fade out 2.5 seconds after the mouse stops, but stay while you're pointing at them. If the connection drops or the LIVE ends, they stay visible with a message until it's resolved.
- **The donor list** is hidden until someone sends a Money Gun or Galaxy. It then appears in the lower-right and fades out 20 seconds after the last big donation. Move your mouse over the overlay to bring it back and pick someone.
- **The Selected viewer card** stays on screen until you clear it (✕ or `Esc`).

To adjust the zones, edit `--safe-top`, `--safe-bottom` and `--safe-x` in `overlay.css` (`.stage`).

> If you capture your whole screen, viewers also see the controls while your mouse is over the overlay. Move the mouse away, or use keyboard shortcuts, to keep the stream clean.

### Big donor selector

The panel at the bottom lists **only viewers who sent a Money Gun or Galaxy**. Each donor gets one row:

```
username: their last chat message      💸×2 🌌×1
```

- If a donor hasn't chatted, the row shows just their username. Their message appears as soon as they write one. A message sent *before* donating counts too.
- The newest donation moves that donor to the top. Donors stay on the list for the whole session.
- The badges show how many Money Guns (💸) and Galaxies (🌌) each donor sent.
- Roses and other small gifts still play their effect and a small pop-up message, but they don't add anyone to the list.
- When someone donates, the donor card appears at the top automatically, then disappears. Their row stays in the list for the whole session, even while the list is faded out.

| Action | How |
| --- | --- |
| Select a donor | Click their row. They're pinned in the **Selected viewer** card (name, last message, gifts), which updates live if they chat again. Click again, or press `Esc`, to clear. |
| Random donor pick | **🎲 Random pick** (or `R`) picks one big donor, each donor with an equal chance. |
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
| `overlay.html` / `overlay.css` / `overlay.js` | UI: username setup, gift alerts, big donor selector. |
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

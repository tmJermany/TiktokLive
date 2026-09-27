# TikTok LIVE Donation Overlay

A floating, always-on-top Electron overlay for TikTok LIVE. Enter your TikTok username and it connects to your stream. Gifts trigger full-window effects that show the donor's name and profile picture, and live chat appears below so you can pick viewers.

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

| Action | How |
| --- | --- |
| Select a viewer | Click a chat message. It's pinned in the **Selected viewer** card. Click it again, or press `Esc`, to clear. |
| Random viewer pick | **🎲 Random pick** picks one recent chatter, each with an equal chance. |
| Test effects | The 💸 🌌 🌹 buttons, or keys `1` `2` `3`. These work in live mode too. |
| Move the window | Drag the title bar. |
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

Event types are `gift`, `chat`, `viewers` and `status`. The feed only listens on localhost. Browser pages are accepted only from local origins (file or localhost). Change the port with `OVERLAY_WS_PORT=9000`, or turn the feed off with `OVERLAY_WS_PORT=off`.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron entry point. Creates the floating window, owns the connector, fetches avatars, runs IPC and the event feed. |
| `preload.js` | Security bridge. Exposes only `window.overlayAPI` to the page. |
| `tiktok-connector.js` | Connection to TikTok LIVE by username, event normalization, and demo mode. |
| `effects.js` | Canvas effects engine (money rain, galaxy, roses). |
| `overlay.html` / `overlay.css` / `overlay.js` | UI: username setup, gift alerts, chat and viewer selection. |
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

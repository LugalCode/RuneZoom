# OSRS Item-Zoom 🔍

Multiplayer "guess the Old School RuneScape item before it sharpens" game —
skribbl.io-style. The icon starts massively zoomed in and zooms out over the
round; type the name; **fastest correct guess scores most**.

- **Difficulty pool** = top 350 items by real Grand Exchange 24h volume (most
  traded = most recognisable = fair). Reveal shows the live trade volume.
- **Server-authoritative**: clients only ever receive a numeric icon id, never
  the item name list (`items.json` is not served). Casual-grade anti-cheat.

## Run locally
```bash
cd game
npm install
npm start            # http://localhost:3000
```
Open two browser tabs to test solo, or share with friends on your LAN.

### Play with friends right now (no deploy)
Install [ngrok](https://ngrok.com), then:
```bash
ngrok http 3000
```
Share the `https://….ngrok-free.app` URL. Done.

## Deploy a permanent public URL
Push the `game/` folder to a GitHub repo, then either:

**Render** (free tier, sleeps when idle)
1. render.com → New → Blueprint → pick the repo (uses `render.yaml`).
2. Or New → Web Service → Build `npm install`, Start `node server.js`.

**Railway** (auto-detects Node, uses `Procfile`)
1. railway.app → New Project → Deploy from GitHub → pick the repo.

Both expose `PORT` via env var, which the server already reads.

## Refresh the item pool / volumes
Snapshots live in `../data/`. To re-pull and rebuild the pool + icons:
```bash
# from osrs/  (parent) refresh the API snapshots first, then:
cd game
python prep_items.py 350      # top N by volume -> items.json + public/icons/
```

## Files
| File | What |
|---|---|
| `server.js` | Express + Socket.IO, rooms, rounds, timer, scoring |
| `public/` | client UI (OSRS-styled), icons, fonts |
| `items.json` | server-side item pool (name/tier/volume) — **not** served |
| `prep_items.py` | rebuilds the pool + downloads icons |
| `test.js` | headless 2-player game-loop smoke test (`node test.js`) |

## Tuning
- Round count / time: host sets in the lobby (1–20 rounds, 10–60s).
- Zoom range: `MAX_ZOOM` / `MIN_ZOOM` in `public/client.js`.
- Scoring: speed formula in `server.js` (`guess` handler).
- Pool size / difficulty floor: `prep_items.py` (`TOP_N`, `TIERS`).

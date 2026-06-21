#!/usr/bin/env python3
"""Build the game's item pool: top items by 24h GE volume (= most recognisable
= fair to guess), download their icons, and write public/items.json.

Usage:  python prep_items.py [top_n]
"""
import json, pathlib, sys, urllib.parse, urllib.request, time

HERE = pathlib.Path(__file__).parent
DATA = HERE.parent / "data"                 # reuse osrs/data snapshots
ICONS = HERE / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)
UA = "tropehunter-osrs-game/1.0 (contact: samuelcjgreenwell@gmail.com)"

TOP_N = int(sys.argv[1]) if len(sys.argv) > 1 else 350

TIERS = [(300_000, "common"), (60_000, "frequent"), (12_000, "uncommon"),
         (2_500, "rare"), (0, "obscure")]
def tier_of(v):
    for floor, label in TIERS:
        if v >= floor:
            return label
    return "obscure"

mapping = json.loads((DATA / "mapping.json").read_text(encoding="utf-8"))
vol = json.loads((DATA / "vol24h.json").read_text(encoding="utf-8"))["data"]

pool = []
for it in mapping:
    name = it["name"]
    if any(c in name for c in "()") or name != name.strip():
        continue
    v = vol.get(str(it["id"]))
    if not v:
        continue
    total = (v.get("highPriceVolume") or 0) + (v.get("lowPriceVolume") or 0)
    if total <= 0:
        continue
    pool.append({"id": it["id"], "name": name, "icon": it["icon"],
                 "vol": total, "tier": tier_of(total)})

pool.sort(key=lambda p: p["vol"], reverse=True)
pool = pool[:TOP_N]

items = []
ok = fail = 0
for p in pool:
    dest = ICONS / f"{p['id']}.png"
    if not dest.exists():
        url = "https://oldschool.runescape.wiki/images/" + urllib.parse.quote(p["icon"].replace(" ", "_"))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                dest.write_bytes(r.read())
        except Exception as e:
            print("  fail:", p["name"], e)
            fail += 1
            continue
    ok += 1
    # only ship what's needed to the client (NOT a giveaway beyond the icon)
    items.append({"id": p["id"], "name": p["name"], "tier": p["tier"], "vol": p["vol"]})

# server-side only (NOT under public/) so names aren't trivially fetchable
(HERE / "items.json").write_text(json.dumps(items), encoding="utf-8")
print(f"pool={len(items)} icons_ok={ok} fail={fail}  -> items.json (server-side)")

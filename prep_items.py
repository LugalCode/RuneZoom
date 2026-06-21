#!/usr/bin/env python3
"""Build the game's item pool: top items by 24h GE volume (= most recognisable
= fair to guess), download their icons, and write items.json.

Usage:  python prep_items.py [top_n] [--refresh]
        --refresh re-pulls the live API snapshots into ./data
"""
import json, pathlib, sys, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"                         # self-contained, fetched on demand
DATA.mkdir(exist_ok=True)
ICONS = HERE / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)
UA = "runezoom/1.0 (contact: samuelcjgreenwell@gmail.com)"
API = "https://prices.runescape.wiki/api/v1/osrs"

args = [a for a in sys.argv[1:] if not a.startswith("--")]
TOP_N = int(args[0]) if args else 350
REFRESH = "--refresh" in sys.argv            # re-pull API snapshots

def fetch_json(name, url):
    dest = DATA / name
    if REFRESH or not dest.exists():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            dest.write_bytes(r.read())
        print("fetched", name)
    return json.loads(dest.read_text(encoding="utf-8"))

TIERS = [(300_000, "common"), (60_000, "frequent"), (12_000, "uncommon"),
         (2_500, "rare"), (0, "obscure")]
def tier_of(v):
    for floor, label in TIERS:
        if v >= floor:
            return label
    return "obscure"

mapping = fetch_json("mapping.json", f"{API}/mapping")
vol = fetch_json("vol24h.json", f"{API}/24h")["data"]

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

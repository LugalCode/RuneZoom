#!/usr/bin/env python3
"""Build the game's item pool, download icons, and write items.json.

We pull a deep slice of tradeable items (volume is only a difficulty *signal*,
not a quality gate — the iconic gear actually trades less than bulk consumables),
then strip out the stuff that guesses badly at zoom:
  - VARIANTS: poisoned (p)/(p+), potion doses (4), enchanted bolts (e), (unf),
    (u), (tablet), (uncharged), Barrows degrade '0/25/50/75/100', clue pages
    '1-4', godsword shards 'N' — anything parenthesised or trailing-numbered.
  - BORING categories: seeds, saplings, grimy herbs, sacks, essence, tar,
    compost, cannonballs, boat (hull/keel/frame) parts — tiny/samey/dupes.
  - FLAT sprites: single-colour fills caught by a luminance-contrast check.

Usage:  python prep_items.py [top_n] [--refresh] [--no-filter] [--dry-run]
        --refresh re-pulls the live API snapshots into ./data
        --dry-run prints the resulting pool without downloading icons
"""
import json, pathlib, re, sys, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"                         # self-contained, fetched on demand
DATA.mkdir(exist_ok=True)
ICONS = HERE / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)
UA = "runezoom/1.0 (contact: samuelcjgreenwell@gmail.com)"
API = "https://prices.runescape.wiki/api/v1/osrs"

args = [a for a in sys.argv[1:] if not a.startswith("--")]
TOP_N = int(args[0]) if args else 2500       # dig deep enough to reach iconic gear
REFRESH = "--refresh" in sys.argv            # re-pull API snapshots
DRY_RUN = "--dry-run" in sys.argv            # preview pool, skip downloads

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

# ── variant filter: kill near-duplicate item versions that guess identically ──
def is_variant(name):
    if "(" in name or ")" in name:        # (p),(p+),(4),(e),(unf),(u),(tablet),(uncharged)…
        return True
    if re.search(r"\s\d+$", name):         # Barrows '0/25/..', clue 'page N', 'shard N'
        return True
    if name != name.strip():
        return True
    return False

# ── boring categories: tiny / samey / many-metal-dupes — bad guessing at zoom ──
BORING = ["seed", "sapling", "grimy ", "sack", "bird nest", "compost",
          " tar", "essence", "bagged", "cannonball",
          "hull parts", "keel parts", "frame parts"]
def is_boring(name):
    nl = name.lower()
    return any(k in nl for k in BORING)

from PIL import Image

# Flat-sprite filter: many OSRS icons are a single blocky colour (dragon leather,
# d'hide, bars, gems) that look identical at every zoom -> unfair to guess.
# Luminance contrast was the old metric but it wrongly punished DARK gear (the
# whip, dragon plate) which is recognisable by shape. Instead we use:
#   colours = count of distinct quantised colours over opaque pixels
#   fill    = opaque fraction of the tile (a thin silhouette is still guessable)
# Drop only when an item is BOTH near-monochrome AND fills the tile -> a flat
# block. Detailed gear has many colours; thin items (whip/dagger) have low fill.
FILTER = "--no-filter" not in sys.argv
COLOUR_MIN = 8      # fewer distinct colours than this = suspiciously flat
FILL_FULL = 0.60    # ...and only a problem if it also fills the tile

def flatness(path):
    im = Image.open(path).convert("RGBA")
    px = im.get_flattened_data()
    op = [(r, g, b) for (r, g, b, a) in px if a > 32]
    if not op:
        return 0, 0.0
    fill = len(op) / len(px)
    colours = len({((r >> 4), (g >> 4), (b >> 4)) for (r, g, b) in op})
    return colours, fill

def is_flat(path):
    colours, fill = flatness(path)
    return colours < COLOUR_MIN and fill >= FILL_FULL

mapping = fetch_json("mapping.json", f"{API}/mapping")
vol = fetch_json("vol24h.json", f"{API}/24h")["data"]

pool = []
skip_variant = skip_boring = 0
for it in mapping:
    name = it["name"]
    v = vol.get(str(it["id"]))
    if not v:
        continue
    total = (v.get("highPriceVolume") or 0) + (v.get("lowPriceVolume") or 0)
    if total <= 0:
        continue
    pool.append({"id": it["id"], "name": name, "icon": it["icon"],
                 "vol": total, "tier": tier_of(total)})

pool.sort(key=lambda p: p["vol"], reverse=True)
pool = pool[:TOP_N]                            # rank by volume, then curate

curated = []
for p in pool:
    if is_variant(p["name"]):
        skip_variant += 1
        continue
    if is_boring(p["name"]):
        skip_boring += 1
        continue
    curated.append(p)
pool = curated
print(f"top {TOP_N} -> {len(pool)} after dropping {skip_variant} variants, {skip_boring} boring")

if DRY_RUN:
    for p in pool:
        print(f"  {p['vol']:>9,}  {p['tier']:<9} {p['name']}")
    print(f"\n[dry-run] {len(pool)} items would ship (icons not downloaded, flat-filter not applied)")
    sys.exit(0)

items = []
ok = fail = 0
dropped = []
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
    if FILTER:
        colours, fill = flatness(dest)
        if colours < COLOUR_MIN and fill >= FILL_FULL:
            dropped.append((colours, p["name"]))
            dest.unlink(missing_ok=True)   # don't ship flat sprites
            continue
    # only ship what's needed to the client (NOT a giveaway beyond the icon)
    items.append({"id": p["id"], "name": p["name"], "tier": p["tier"], "vol": p["vol"]})

# server-side only (NOT under public/) so names aren't trivially fetchable
(HERE / "items.json").write_text(json.dumps(items), encoding="utf-8")
if dropped:
    print(f"filtered {len(dropped)} flat sprites (< {COLOUR_MIN} colours & filling tile):")
    for c, n in sorted(dropped):
        print(f"  c={c:<3} {n}")
print(f"pool={len(items)} icons_ok={ok} fail={fail} dropped={len(dropped)}  -> items.json")

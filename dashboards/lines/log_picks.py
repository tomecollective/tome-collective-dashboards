"""Log a whole slate's leans to the worker in one go, with tiers and free/Intel access.

    export TOME_LINES_URL=https://tome-lines.<account>.workers.dev
    export TOME_ADMIN_TOKEN=...            # paste yourself; never commit
    python3 log_picks.py projection.json [--free 3] [--free-games BOS@NYK,LAL@DEN] [--override AWAY@HOME:side=HOME,total=UNDER ...]

Uses the same prominence rule as tome_card.py: the first N games in slate order are free unless --free-games says which.
--override lets you log your lean where it differs from the model (it is stored with override:true and still graded).
"""
import json, os, sys, urllib.request

URL = os.environ.get("TOME_LINES_URL", "").rstrip("/")
TOKEN = os.environ.get("TOME_ADMIN_TOKEN", "")
if not URL or not TOKEN: sys.exit("set TOME_LINES_URL and TOME_ADMIN_TOKEN")

data = json.load(open(sys.argv[1])); args = sys.argv[2:]
league = data["league"]; games = data["games"]
free = int(args[args.index("--free") + 1]) if "--free" in args else 3
free_keys = args[args.index("--free-games") + 1].split(",") if "--free-games" in args else None
overrides = {}
for i, a in enumerate(args):
    if a == "--override":
        k, spec = args[i + 1].split(":", 1)
        overrides[k] = dict(x.split("=") for x in spec.split(","))

key = lambda g: f'{g["away"]}@{g["home"]}'
free_set = {key(g) for g in (games[:free] if not free_keys else [g for g in games if key(g) in free_keys])}

for g in games:
    L = g.get("lean") or {}; m = g.get("market") or {}
    if m.get("spread_home") is None and m.get("total") is None: print("skip (no market)", key(g)); continue
    ov = overrides.get(key(g), {})
    body = {
        "league": league, "game_id": g["game_id"],
        "side": ov.get("side", L.get("side_pick")), "spread_home_at_pick": m.get("spread_home"),
        "total_side": ov.get("total", L.get("total_pick")), "total_at_pick": m.get("total"),
        "projected_spread_home": g.get("projected_spread_home"), "projected_total": g.get("projected_total"),
        "side_tier": L.get("side_tier"), "total_tier": L.get("total_tier"),
        "access": "free" if key(g) in free_set else "intel",
        "override": bool(ov), "note": ov.get("note"),
    }
    req = urllib.request.Request(f"{URL}/api/lines/pick", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Admin-Token": TOKEN})
    with urllib.request.urlopen(req) as r:
        out = json.load(r)
    p = out.get("pick", {})
    print(f'{key(g):10s} {body["access"]:5s} side={p.get("side")} ({p.get("side_tier")}) total={p.get("total_side")} ({p.get("total_tier")}){" OVERRIDE" if ov else ""}')

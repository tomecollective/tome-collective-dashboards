"""Build the day's Historic optimizer dataset from Top Shot's live roster-builder text.

    set TOME_SUB=sub_...                        (your own Beehiiv subscription id; the Worker's read gate)
    python build_historic_day.py roster.txt "Tue, Oct 20 (Run 1, Day 1)"  > historic-optimizer-data.json

roster.txt is the raw text you get by selecting all on Top Shot's Historic roster-builder page and pasting
into a file (the same paste the admin panel's "Historic RP Prices" box takes). The script:

  1. downloads the current optimizer dataset from the Worker (players with their observed-game history),
  2. reads every player block in the paste (name, Roster Points, season AVG, team if shown),
  3. updates each matched player's base RP and AVG to the live price, adds unmatched players as new entries,
  4. writes a new single slate: the players present in the paste are today's eligible pool, and their
     teams are the teams in action,
  5. prints the dataset to stdout, ready for the admin panel's "Upload optimizer data" box.

Observed-game histories (g / s) carry forward untouched. Box scores from the day are added later, after the
simulated games finish, with the same tool once a results paste exists. Nothing here touches Collector
Discounts; those stay in each reader's browser.
"""
import json, os, re, sys, urllib.request

WORKER = os.environ.get("FASTBREAK_WORKER", "https://tome-fastbreak-refresh.tomecollective.workers.dev")
SUB = os.environ.get("TOME_SUB", "")
if not SUB: sys.exit("set TOME_SUB to your subscription id (sub_...)")
if len(sys.argv) < 3: sys.exit(__doc__)
paste = open(sys.argv[1], encoding="utf-8").read()
label = sys.argv[2]

req = urllib.request.Request(f"{WORKER}/api/fastbreak/historic/optimizer", headers={"X-Tome-Sub": SUB, "User-Agent": "Mozilla/5.0 TomeHistoric/1.0"})
D = json.load(urllib.request.urlopen(req, timeout=90))
by = {p["n"].lower(): p for p in D["players"]}

# ---- parse the paste --------------------------------------------------------------------------------
RP = re.compile(r"(\d{2,3})\s*(?:Roster Points|RP)\b", re.I)
STAT = re.compile(r"^\s*\d+(?:\.\d+)?\s*(?:PTS|REB|AST|STL|BLK|3PM|FG%|FT%|TOV|MIN|Avg)\s*$", re.I)
AVG = re.compile(r"(\d+(?:\.\d+)?)\s*Avg", re.I)
TEAM = re.compile(r"^\s*([A-Z]{3})\s*$")
lines = [l.strip() for l in paste.splitlines()]
blocks, cur = [], None
for l in lines:
    if not l: continue
    m = RP.search(l)
    if m:  # a price starts (or belongs to) a block
        if cur and cur.get("name") and cur.get("rp") is not None: blocks.append(cur); cur = None
        cur = cur or {}
        cur["rp"] = int(m.group(1)); continue
    if cur is None: cur = {}
    if AVG.search(l) and "rp" in cur: cur["avg"] = float(AVG.search(l).group(1)); continue
    if STAT.match(l): continue
    if TEAM.match(l): cur["team"] = TEAM.match(l).group(1); continue
    if re.search(r"[A-Za-z]{2,}", l) and not cur.get("name") and len(l) < 40 and "Roster" not in l and "Collector" not in l:
        cur["name"] = l.strip()
if cur and cur.get("name") and cur.get("rp") is not None: blocks.append(cur)
if not blocks: sys.exit("no player blocks found in the paste; check the file")

# ---- apply -------------------------------------------------------------------------------------------
matched, added, pool, teams = 0, 0, [], set()
for b in blocks:
    key = b["name"].lower()
    p = by.get(key)
    if p is None:
        # loose match on last name + first initial
        cands = [q for q in D["players"] if q["n"].split()[-1].lower() == b["name"].split()[-1].lower() and q["n"][0].lower() == b["name"][0].lower()]
        p = cands[0] if len(cands) == 1 else None
    if p is None:
        p = {"n": b["name"], "t": b.get("team", ""), "rp": b["rp"], "avg": b.get("avg", 0.0), "g": [], "s": []}
        D["players"].append(p); by[key] = p; added += 1
    else:
        p["rp"] = b["rp"]
        if b.get("avg") is not None: p["avg"] = b["avg"]
        if b.get("team"): p["t"] = b["team"]
        matched += 1
    pool.append(p["n"]); teams.add(p["t"])
D["slates"] = [{"label": label, "teams": sorted(t for t in teams if t), "players": pool}]
D["updated"] = label
D.pop("_prepared", None); D.pop("shift", None)
for p in D["players"]:
    for k in ("mean", "blend", "n_games"): p.pop(k, None)
sys.stderr.write(f"{len(blocks)} players in paste: {matched} repriced, {added} new; slate has {len(pool)} players on {len(teams)} teams\n")
json.dump(D, sys.stdout, indent=1)

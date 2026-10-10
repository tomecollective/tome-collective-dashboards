"""One-time backfill of The Record from the published previews (Sept 9 - Oct 9, 2026).

    set TOME_LINES_URL=https://tome-lines.tomecollective.workers.dev
    set TOME_ADMIN_TOKEN=...                       (paste yourself; never commit)
    python backfill_picks.py backfill_picks.json   [--dry]

Each entry was parsed from the preview's own PICK / LEAN block, card, or "Rest of the slate" line, carries the slate
identity (date, abbreviations, SBR nicknames) so the worker grades it from the cached market page, and names the
preview post it came from. Pre-graded locally against the same market cache, the file reproduces the records the
recaps published: NFL 32-31-2 side / 35-30 total through Oct 8; WNBA playoffs 11-5 / 8-8 through Oct 9.
Re-running is safe: the worker keys each card by league + game_id, so a second run overwrites rather than duplicates.
"""
import json, os, sys, time, urllib.request
URL = os.environ.get("TOME_LINES_URL", "https://tome-lines.tomecollective.workers.dev").rstrip("/")
TOKEN = os.environ.get("TOME_ADMIN_TOKEN", "")
if not TOKEN: sys.exit("set TOME_ADMIN_TOKEN")
picks = json.load(open(sys.argv[1])); dry = "--dry" in sys.argv
ok = 0
for p in picks:
    body = {k: v for k, v in p.items() if not k.startswith("_") and k not in ("fmt", "lean_text")}
    if dry: print("would post", body["league"], body["date"], body["away"], "@", body["home"], p["lean_text"], body["total_side"], body["total_at_pick"]); continue
    req = urllib.request.Request(f"{URL}/api/lines/pick", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Admin-Token": TOKEN, "User-Agent": "Mozilla/5.0 TomeBackfill/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: json.load(r); ok += 1
        print("logged", body["league"], body["date"], body["away"], "@", body["home"], p["lean_text"], body["total_side"], body["total_at_pick"])
    except Exception as e:
        print("FAILED", body["league"], body["date"], body["away"], "@", body["home"], e)
    time.sleep(0.25)
print(f"{ok}/{len(picks)} logged" if not dry else f"{len(picks)} entries")

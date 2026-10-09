"""Compute the Chase Index tile values for the Saturday Tome Cards issue.

Reads the public teaser at https://tome-tcg.tomecollective.workers.dev/api/chase-index
(no key needed: the teaser carries the index value series) and prints the five
token values the Tome Cards template expects:

    [[INDEX_VALUE]]     $36,598           latest index total, whole dollars
    [[INDEX_WOW]]       +1.2% / -0.8%     vs. the last reading on or before 7 days earlier
    [[INDEX_ASOF]]      Friday, Oct 3     date of the latest reading (it is the previous
                                          day's close; the 10:00 UTC cron publishes it)
    [[INDEX_30D]]       +4.1%             vs. the last reading on or before 30 days earlier
    [[INDEX_30D_NOTE]]  "30-day high $37,912 · low $35,204" (whole dollars)

Usage:
    python3 fill_index_tiles.py            # prints JSON {token: value, ..., "warnings": [...]}

The latest reading is the last entry of indexHistory, NOT last_updated: indexHistory only
includes days where all 50 holdings refreshed, so it can lag last_updated by a day or two
when JustTCG drops a card. A reading older than 2 days gets a warning; still fill the
tiles (with the true date) and mention it in the run summary.
"""
import json, sys, urllib.request, datetime as dt

URL = "https://tome-tcg.tomecollective.workers.dev/api/chase-index"

def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 TomeCards/1.0", "Accept": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    hist = sorted(d.get("indexHistory", []), key=lambda x: x["date"])
    if len(hist) < 8:
        print(json.dumps({"error": "indexHistory too short", "n": len(hist)})); sys.exit(1)
    latest = hist[-1]
    D = dt.date.fromisoformat(latest["date"])
    def on_or_before(days):
        target = D - dt.timedelta(days=days)
        cands = [h for h in hist if dt.date.fromisoformat(h["date"]) <= target]
        return cands[-1] if cands else None
    wk, mo = on_or_before(7), on_or_before(30)
    pct = lambda a, b: f"{(a / b - 1) * 100:+.1f}%" if b else "n/a"
    last30 = [h["total"] for h in hist if dt.date.fromisoformat(h["date"]) > D - dt.timedelta(days=30)]
    money = lambda v: f"${v:,.0f}"
    out = {
        "[[INDEX_VALUE]]": money(latest["total"]),
        "[[INDEX_WOW]]": pct(latest["total"], wk["total"]) if wk else "n/a",
        "[[INDEX_ASOF]]": D.strftime("%A, %b %-d"),
        "[[INDEX_30D]]": pct(latest["total"], mo["total"]) if mo else "n/a",
        "[[INDEX_30D_NOTE]]": f"30-day high {money(max(last30))} · low {money(min(last30))}",
        "warnings": [],
        "_latest_date": latest["date"], "_last_updated": d.get("last_updated"),
        "_wow_base_date": wk and wk["date"], "_30d_base_date": mo and mo["date"],
    }
    age = (dt.date.today() - D).days
    if age > 2:
        out["warnings"].append(f"latest complete index reading is {age} days old ({latest['date']}); last_updated={d.get('last_updated')}")
    print(json.dumps(out, indent=1, ensure_ascii=False))

if __name__ == "__main__":
    main()

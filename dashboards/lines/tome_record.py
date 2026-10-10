"""The Record: one JSON feed, three renderings.

    python3 tome_record.py recap  nfl  2026-10-11            # Beehiiv section HTML for the recap of that slate day
    python3 tome_record.py monday 2026-10-11                 # text rows for the Monday graphic (as of that Sunday)
    python3 tome_record.py page   2026-10-11 > summary.json  # the raw summary the record page reads

Everything comes from GET /api/lines/record/summary on the tome-lines worker; nothing here is typed in.
Vocabulary is fixed: cleared / missed / push / no result. A rate is always printed next to its denominator
("11-9-1 · 55% of 20"; the unit is a lean, one per market, so a game with a side and a total is two) and carries the word "early" below the 20-card gate. No streaks, no combined
side+total record, no money words. Set TOME_LINES_URL to point at a different worker.
"""
import json, os, sys, urllib.request, datetime as dt

URL = os.environ.get("TOME_LINES_URL", "https://tome-lines.tomecollective.workers.dev")
GOLD = "#FFB515"; CREAM = "#FEFFEF"; INK = "#1a1a1a"; MUTED = "#C9C9CC"
TIER = {"strong": "Strong", "lean": "Lean", "tossup": "Toss-up"}
FOOTER = "Cards are leans graded against the closing number, not picks or plays."
RECORD_URL = "https://read.tomecollective.com/p/record"

def fetch(asof, league=None, slate=None):
    q = f"?asof={asof}" + (f"&league={league}" if league else "") + (f"&slate={slate}" if slate else "")
    req = urllib.request.Request(URL + "/api/lines/record/summary" + q, headers={"User-Agent": "Mozilla/5.0 TomeRecord/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=90))

def line(c, with_rate=True):
    """'11-9-1 · 55% of 20' or '4-2 · 67% of 6 · early'. Never a rate without its denominator."""
    s = c["record"]
    if with_rate and c["pct"] is not None: s += f" · {c['pct']:.0f}% of {c['rated']}"
    if c["early"] and c["rated"]: s += " · early"
    return s

def nice_date(d):
    x = dt.date.fromisoformat(d); return x.strftime("%A, %b ") + str(x.day)

def active_segment(summary, league):
    segs = summary["leagues"].get(league, {}).get("segments", [])
    return segs[0] if segs else None

# ---- 1. Recap block -------------------------------------------------------------------------
def recap(league, slate_day):
    s = fetch(slate_day, league=league, slate=slate_day)
    seg = active_segment(s, league)
    if not seg: return ""
    std, sl = seg["season_to_date"], seg["slate"]
    through = f"through {seg['chapter_now']}" if league == "nfl" else f"through {nice_date(slate_day)}"
    def p(t, color=CREAM, bold=False, size=None):
        st = f"color: {color};" + (f" font-size: {size};" if size else "")
        inner = f"<strong>{t}</strong>" if bold else t
        return f'<p><span style="{st}">{inner}</span></p>'
    rows = [p(f"THE RECORD · {seg['label'].upper()}", GOLD, True),
            p(f"Side {line(std['side'])} &nbsp;·&nbsp; Total {line(std['total'])} &nbsp;·&nbsp; {through}", CREAM, True)]
    n = len([c for c in sl["cards"] if c["result"] != "void"])
    if n:
        rows.append(p(f"This slate: side {sl['side']['record']}, total {sl['total']['record']} ({n} lean{'s' if n != 1 else ''}).", MUTED))
    v = sl["void"]
    if v: rows.append(p(f"{v} lean{'s' if v != 1 else ''} had no result (postponed or no closing number) and {'are' if v != 1 else 'is'} listed, not counted.", MUTED))
    rows.append(p(f"Every card is graded against the closing number. The full ledger, by tier and by {'week' if league == 'nfl' else 'month' if league == 'nba' else 'game'}, is on "
                  f'<a href="{RECORD_URL}" target="_blank" rel="noopener noreferrer nofollow" class="link"><span style="color: {GOLD};">The Record</span></a>.', MUTED))
    return (f'<div data-background-color="{INK}" data-border-bottom-left-radius="8" data-border-bottom-right-radius="8" data-border-style="solid" '
            f'data-border-top-left-radius="8" data-border-top-right-radius="8" data-border-width-bottom="0" data-border-width-left="0" data-border-width-right="0" data-border-width-top="0" '
            f'data-margin-bottom="8" data-margin-left="0" data-margin-right="0" data-margin-top="0" data-padding-bottom="14" data-padding-left="16" data-padding-right="16" data-padding-top="14" '
            f'data-show-in-email="true" data-show-on-website="true" data-show-to-free-subscribers="true" data-show-to-non-subscribers="true" data-show-to-paid-subscribers="true" '
            f'data-show-to-tiered-subscribers="[]" data-type="section" class="node-section">{"".join(rows)}</div>')

# ---- 2. Monday graphic rows ----------------------------------------------------------------
def monday(asof):
    """Plain text rows for the banner template. asof is the Sunday; the slate is the 7 days through it."""
    s = fetch(asof)
    out = [f"THE RECORD · through {nice_date(asof)}", ""]
    tier_rows = []
    for league in ("nfl", "nba", "wnba"):
        for seg in s["leagues"].get(league, {}).get("segments", []):
            std, sl = seg["season_to_date"], seg["slate"]
            if seg["status"] == "final":
                # a closed segment stays on the graphic for two weeks after its last graded card
                if seg["through"] and (dt.date.fromisoformat(asof) - dt.date.fromisoformat(seg["through"])).days > 14: continue
                label = f"{seg['label']} (final)"
            else: label = seg["label"]
            if not (std["side"]["rated"] or std["total"]["rated"]): continue
            out.append(f"{label:<28}Side {line(std['side']):<24}Total {line(std['total'])}")
            n = len([c for c in sl["cards"] if c["result"] != "void"])
            if n: out.append(f"{'  This week (' + str(n) + ' leans)':<28}Side {sl['side']['record']:<24}Total {sl['total']['record']}")
            out.append("")
            if std["tiers_shown"]:
                parts = []
                for t in ("strong", "lean", "tossup"):
                    bt = std["by_tier"].get(t)
                    if bt and bt["side"]["shown"]: parts.append(f"{TIER[t]} {bt['side']['record']}")
                if parts: tier_rows.append(f"By tier, {league.upper()} side ({std['side']['rated']} leans): " + " · ".join(parts))
    out += tier_rows + ([""] if tier_rows else []) + [FOOTER, f"Full ledger: {RECORD_URL}"]
    return "\n".join(out)

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "recap": print(recap(sys.argv[2], sys.argv[3]))
    elif cmd == "monday": print(monday(sys.argv[2]))
    elif cmd == "page": print(json.dumps(fetch(sys.argv[2]), indent=1))
    else: print(__doc__)

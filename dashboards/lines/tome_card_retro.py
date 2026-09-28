"""Retro cards for the Sept 27 preview and graded cards for its recap.
Lean shown is Tome's published lean; the tier is the model's edge in the direction of that lean."""
import json, sys
sys.path.insert(0, "/mnt/user-data/outputs/tome-lines")
from tome_card import card, sec, p, row, sp, GOLD, CREAM, INK, GREEN, MUTED, TIER_WORD, preview_wrap

THR = {"wnba": (2.5, 4.0), "nba": (2.5, 4.0), "nfl": (1.5, 3.0)}
SIDE_THR, TOTAL_THR = 2.5, 4.0  # overwritten per league in main
DISPLAY = {"GS": "GSV", "WSH": "WAS"}  # Tome house abbreviations
def disp(a): return DISPLAY.get(a, a)
def tier_for(edge_for_pick, thr):
    if edge_for_pick >= 2 * thr: return "STRONG"
    if edge_for_pick >= thr: return "LEAN"
    return "COIN FLIP"

NOTES = {  # driven_by, why  (edited by hand, in the voice)
    "NY@MIN": ("the number and the news", "Our number has this a 3-point Liberty game, and New York has already beaten the Lynx twice. Both point the same way, which is as far from the book as we get."),
    "IND@LV": ("the news", "Our number leans Vegas by more than the book does. We sided with the season series, 2-1 Indiana, and a Clark-Mitchell offense that has solved this defense before. Call it a Toss-up with a reason."),
    "WSH@ATL": ("the number", "Atlanta is 8-2 against the number in its last ten and our projection sits nine points past the book. The under is our read against the number, which had this one over."),
    "DAL@GS": ("the news", "Our number has this close to a pick'em on the strength of Dallas's finish. We leaned the defense that swept the series anyway, and we're saying so: this one is a Toss-up."),
}

def retro_lean(g):
    t = g["tome"]; L = dict(g["lean"])
    if g.get("card", {}).get("league") == "nfl": g["inputs"] = g.get("inputs", {})
    home, away = disp(g["home"]), disp(g["away"]); m = g["market"]
    e_side = L["side_edge"] if t["side"] == "HOME" else -L["side_edge"]
    e_tot = L["total_edge"] if t["tot"] == "OVER" else -L["total_edge"]
    L["side_pick"] = t["side"]; L["side_tier"] = tier_for(e_side, SIDE_THR)
    L["side"] = f"{home} {sp(m['spread_home'])}" if t["side"] == "HOME" else f"{away} {sp(-m['spread_home'])}"
    L["total_pick"] = t["tot"]; L["total_tier"] = tier_for(e_tot, TOTAL_THR); L["total"] = f"{t['tot']} {m['total']}"
    return L

def graded(g):
    """The Card, graded — for the recap."""
    L = retro_lean(g); t = g["tome"]; f = g["final"]; m = g["market"]; cl = g["close"]
    home, away = disp(g["home"]), disp(g["away"])
    margin = f["home"] - f["away"]; cover = margin + m["spread_home"]
    side_res = "P" if cover == 0 else ("W" if (cover > 0) == (t["side"] == "HOME") else "L")
    pts = f["home"] + f["away"]; tot_res = "P" if pts == m["total"] else ("W" if (pts > m["total"]) == (t["tot"] == "OVER") else "L")
    clv_side = (m["spread_home"] - cl["spread_home"]) if t["side"] == "HOME" else (cl["spread_home"] - m["spread_home"])
    clv_tot = (cl["total"] - m["total"]) if t["tot"] == "OVER" else (m["total"] - cl["total"])
    word = {"W": "Cleared", "L": "Missed", "P": "Push"}
    col = {"W": GREEN, "L": "#E06A50", "P": MUTED}
    rows = [
        f'<p><span style="color: {GOLD};"><strong>THE CARD, GRADED</strong></span><span style="color: {MUTED};"> · {away} @ {home} · final {away} {f["away"]}, {home} {f["home"]}</span></p>',
        row("The line", f"{home} {sp(m['spread_home'])} · total {m['total']} (closed {sp(cl['spread_home'])} · {cl['total']})"),
        row("Our number", f"{home} {sp(g['projected_spread_home'])} · total {g['projected_total']}"),
        f'<p><span style="color: {GOLD};"><strong>Side</strong></span><span style="color: {CREAM};"> {L["side"]} ({TIER_WORD[L["side_tier"]]}) — </span><span style="color: {col[side_res]};"><strong>{word[side_res]}</strong></span><span style="color: {MUTED};"> · {home if margin > 0 else away} by {abs(margin)} · closing-line value {clv_side:+g}</span></p>',
        f'<p><span style="color: {GOLD};"><strong>Total</strong></span><span style="color: {CREAM};"> {L["total"].capitalize()} ({TIER_WORD[L["total_tier"]]}) — </span><span style="color: {col[tot_res]};"><strong>{word[tot_res]}</strong></span><span style="color: {MUTED};"> · {pts} points · closing-line value {clv_tot:+g}</span></p>',
    ]
    return sec("".join(rows)), side_res, tot_res, L, clv_side, clv_tot

def day_record(results):
    """Summary block for the recap: record for the day by market and tier."""
    def rec(rs): return f"{rs.count('W')}-{rs.count('L')}" + (f"-{rs.count('P')}" if rs.count('P') else "")
    sides = [r[1] for r in results]; tots = [r[2] for r in results]
    strong_s = [r[1] for r in results if r[3]["side_tier"] == "STRONG"]; strong_t = [r[2] for r in results if r[3]["total_tier"] == "STRONG"]
    toss = [r[1] for r in results if r[3]["side_tier"] == "COIN FLIP"] + [r[2] for r in results if r[3]["total_tier"] == "COIN FLIP"]
    clv = sum(r[4] for r in results) / len(results)
    rows = [
        f'<p><span style="color: {GOLD};"><strong>THE RECORD · {len(results)} games</strong></span></p>',
        row("Sides", f"{rec(sides)} · Strong leans {rec(strong_s)}"),
        row("Totals", f"{rec(tots)} · Strong leans {rec(strong_t)}"),
        row("Toss-ups", f"{rec(toss)} across both markets"),
        row("Closing-line value", f"{clv:+.1f} points per side lean"),
        p("Every lean above was logged before tip with the line at the time. The season ledger, by tier and with the misses in the same font size, lives on the Dashboards page.", MUTED),
    ]
    return sec("".join(rows))

def auto_note(g):
    """Default 'driven by' when no hand-written note exists: honest about whether the lean agrees with the number."""
    t = g["tome"]; L = g["lean"]
    agree_s = L.get("side_pick") == t["side"]; agree_t = L.get("total_pick") == t["tot"]
    if agree_s and agree_t: return ("the number", "")
    if not agree_s and not agree_t: return ("the news", "Our number leaned the other way on both the side and the total; this is a read on the matchup, not the rating.")
    if not agree_s: return ("the news", "Our number leaned the other side; the lean is a read on the matchup, and the total follows the number.")
    return ("the number", "The side follows our number; the total is a read against it.")

if __name__ == "__main__":
    data = json.load(open(sys.argv[1]))
    SIDE_THR, TOTAL_THR = THR.get(data.get("league", "wnba"), (2.5, 4.0))
    if "--recap" in sys.argv:
        results = [graded(g) for g in data["games"]]
        blocks = [r[0] for r in results] + [day_record(results)]
        out = "".join(blocks)
    else:
        out = ""
        for g in data["games"]:
            key = f'{g["away"]}@{g["home"]}'; drv, why = NOTES.get(key) or auto_note(g)
            g2 = dict(g); g2["lean"] = retro_lean(g)
            out += card(g2, abbr_home=disp(g["home"]), abbr_away=disp(g["away"]), why=why, driven_by=drv)
    print(preview_wrap(out) if "--preview" in sys.argv else out)

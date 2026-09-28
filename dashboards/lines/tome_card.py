"""The Card: the same block under every game preview, built from one /api/lines/projection game row.

Usage:
    python3 tome_card.py projection.json > cards.html        # every game on the slate, Beehiiv editor HTML
    python3 tome_card.py projection.json --preview > p.html  # standalone HTML to eyeball in a browser

Voice rules baked in: "lean" never "bet"; tiers are Strong / Lean / Toss-up and describe how the evidence
stacks, never how hard to lean. The one-line "why" and the "driven by" tag are yours to edit; the numbers
are the worker's. If a field is missing the row is dropped rather than printed blank.
"""
import json, sys, html

GOLD = "#FFB515"; CREAM = "#FEFFEF"; INK = "#1a1a1a"; GREEN = "#0D7959"; MUTED = "#C9C9CC"
# Every paid tier includes Tome Intel content.
PAID_TIERS = ["tier_083c8fcc-1b16-45d8-b43e-5f98cb3f5d1b", "tier_c63b9d3e-154e-433c-8e05-a7e70c07e283",
              "tier_66e3700d-872f-4fab-bdb5-539420e34e12", "tier_df25929b-65f3-46ba-9443-d23ce4f19ae2"]
UPGRADE_URL = "https://read.tomecollective.com/upgrade"
PROMINENCE_LINE = ("Free cards go to the night's three most prominent games, by national window and matchup. "
                   "Confidence never enters into it; some nights the Strong leans are in the open, some nights they are not.")
TIER_WORD = {"STRONG": "Strong", "LEAN": "Lean", "COIN FLIP": "Toss-up"}
NFL_EARLY_NOTE = "Through Week 6 the number is built on a handful of games and is deliberately shrunk toward average; the news and the market carry more weight than usual."
TIER_NOTE = {
    "STRONG": "Our number sits a long way from the book. That is a flag to read the news before following it, not a promise.",
    "LEAN": "A real gap, not a big one.",
    "COIN FLIP": "We are close to the book; the trends above are the tiebreaker, and reasonable people land on either side.",
}

def sec(inner, bg=INK, pad=14, radius=8, access="free"):
    """access: 'free' (everyone), 'intel' (paid tiers only), 'teaser' (non-subscribers and free only)."""
    if access == "intel": vis = ('data-show-to-free-subscribers="false" data-show-to-non-subscribers="false" data-show-to-paid-subscribers="true" '
                                 f'data-show-to-tiered-subscribers="{html.escape(json.dumps(PAID_TIERS), quote=True)}" ')
    elif access == "teaser": vis = 'data-show-to-free-subscribers="true" data-show-to-non-subscribers="true" data-show-to-paid-subscribers="false" data-show-to-tiered-subscribers="[]" '
    else: vis = 'data-show-to-free-subscribers="true" data-show-to-non-subscribers="true" data-show-to-paid-subscribers="true" data-show-to-tiered-subscribers="[]" '
    return (f'<div data-background-color="{bg}" data-border-bottom-left-radius="{radius}" data-border-bottom-right-radius="{radius}" '
            f'data-border-style="solid" data-border-top-left-radius="{radius}" data-border-top-right-radius="{radius}" '
            f'data-border-width-bottom="0" data-border-width-left="0" data-border-width-right="0" data-border-width-top="0" '
            f'data-margin-bottom="8" data-margin-left="0" data-margin-right="0" data-margin-top="0" '
            f'data-padding-bottom="{pad}" data-padding-left="16" data-padding-right="16" data-padding-top="{pad}" '
            f'data-show-in-email="true" data-show-on-website="true" {vis}data-type="section" class="node-section">{inner}</div>')

def p(text, color=CREAM, bold=False):
    s = f"<strong>{text}</strong>" if bold else text
    return f'<p><span style="color: {color};">{s}</span></p>'

def row(label, value):
    return f'<p><span style="color: {GOLD};"><strong>{label}</strong></span><span style="color: {CREAM};"> {value}</span></p>'

def sp(x):
    """quote a spread like a book: -6.5 / +3.5 / PK"""
    if x is None: return None
    if x == 0: return "PK"
    return f"{x:+g}"

def side_str(team, spread_home_for_team):
    return f"{team} {sp(spread_home_for_team)}"

def card(g, abbr_home=None, abbr_away=None, why="", driven_by="the number", poll_id=None, access="free"):
    home = abbr_home or g["home"]; away = abbr_away or g["away"]
    m = g.get("market") or {}; L = g.get("lean") or {}; C = g.get("card") or {}
    line = C.get("line") or {}; pub = C.get("public") or {}; tr = C.get("trends") or {}; rest = C.get("rest") or {}
    rows = []
    # 1. the line
    if m.get("spread_home") is not None:
        s = f"{home} {sp(m['spread_home'])} · total {m.get('total', '—')}"
        moves = []
        if line.get("spread_move"):
            mv = f"spread moved {line['spread_move']:+g} toward {'the home side' if line['spread_move'] < 0 else 'the road side'}"
            if C.get("league") == "nfl" and line.get("spread_home_open") is not None:
                o, n = abs(line["spread_home_open"]), abs(line["spread_home_now"])
                for k in (3, 7): 
                    if (o - k) * (n - k) < 0 or n == k != o or o == k != n: mv += f", through the key number {k}"; break
            moves.append(mv)
        if line.get("total_move"): moves.append(f"total {'up' if line['total_move'] > 0 else 'down'} {abs(line['total_move']):g} since open")
        if moves: s += " (" + ", ".join(moves) + ")"
        rows.append(row("The line", s))
    # 2. our number
    if g.get("projected_spread_home") is not None:
        gap_s = L.get("side_edge"); gap_t = L.get("total_edge")
        s = f"{home} {sp(g['projected_spread_home'])} · total {g['projected_total']}"
        gaps = []
        if gap_s is not None: gaps.append(f"{abs(gap_s):g} pts from the book on the side")
        if gap_t is not None: gaps.append(f"{abs(gap_t):g} on the total")
        if gaps: s += " — " + ", ".join(gaps)
        rows.append(row("Our number", s))
    # 3. trends
    th, ta = tr.get("home"), tr.get("away")
    if th or ta:
        parts = []
        for name, t in ((away, ta), (home, th)):
            if t and t.get("games"): parts.append(f"{name} {t['ats']} ATS, {t['ou']} O/U")
        if parts:
            n = max((t or {}).get("games", 0) for t in (th, ta))
            rows.append(row(("Last five" if n >= 5 else f"Last {n}") if C.get("league") == "nfl" else ("Last ten" if n >= 10 else f"Last {n}"), " · ".join(parts)))
    # 4. rest and availability
    ra = []
    if C.get("league") == "nfl":
        for name, d in ((away, rest.get("away_days")), (home, rest.get("home_days"))):
            if d is None: continue
            ra.append(f"{name} {'short week' if d <= 5 else 'off the bye' if d >= 13 else 'extra rest' if d >= 8 else 'normal week'}")
    else:
        for name, d in ((away, rest.get("away_days_since")), (home, rest.get("home_days_since"))):
            if d is not None: ra.append(f"{name} {'back-to-back' if d == -1.5 else 'one day off' if d == -0.5 else 'rested' if d == 0.5 else 'normal rest'}")
    if g.get("availability"): ra.append(g["availability"])
    if ra: rows.append(row("Rest & availability", " · ".join(ra)))
    # 5. public
    if pub.get("home_spread_pct"):
        hp = pub["home_spread_pct"]; op = pub.get("over_pct")
        s = "tickets split evenly on the side" if hp == 50 else f"{max(hp, 100 - hp)}% of tickets on {home if hp > 50 else away}"
        if op: s += f" · {max(op, 100 - op)}% on the {'over' if op >= 50 else 'under'}"
        rows.append(row("The public", s))
    # 6. the lean
    if L.get("side"):
        st = TIER_WORD.get(L.get("side_tier"), ""); tt = TIER_WORD.get(L.get("total_tier"), "")
        s = f"{L['side']} ({st})"
        if L.get("total"): s += f" · {L['total'].capitalize()} ({tt})"
        rows.append(f'<p><span style="color: {GREEN};"><strong>Lean</strong></span><span style="color: {CREAM};"><strong> {s}</strong></span></p>')
        note = why or TIER_NOTE.get(L.get("side_tier"), "")
        if C.get("league") == "nfl" and g.get("_first_card", True) and (g.get("inputs", {}).get("home_games", 99) < 6 or g.get("inputs", {}).get("away_games", 99) < 6): note += " " + NFL_EARLY_NOTE
        rows.append(p(f"Driven by {driven_by}. " + note, MUTED))
    if poll_id: rows.append(f'<div class="node-poll" data-poll-id="{poll_id}"></div>')
    tag = " · Intel" if access == "intel" else ""
    header = f'<p><span style="color: {GOLD};"><strong>THE CARD</strong></span><span style="color: {MUTED};"> · {away} @ {home}{tag}</span></p>'
    return sec(header + "".join(rows), access=access)

def teaser(intel_games, abbr=lambda g: (g["away"], g["home"])):
    """Shown only to readers without Intel: which cards they are missing tonight, and the rule for who gets what."""
    names = ", ".join(f"{a} @ {h}" for a, h in (abbr(g) for g in intel_games))
    n = len(intel_games)
    inner = (f'<p><span style="color: {GOLD};"><strong>THE REST OF THE SLATE</strong></span><span style="color: {MUTED};"> · {n} more card{"s" if n != 1 else ""} tonight</span></p>'
             + p(f"{names}. Every card, every night, is what Tome Intel is: the same line, number, trends, rest, public split, and lean you just read, for the whole slate.", CREAM)
             + p(PROMINENCE_LINE, MUTED)
             + f'<div><a data-alignment="left" data-custom-background-color="{GOLD}" data-custom-text-color="{INK}" data-full-width="false" href="{UPGRADE_URL}" data-size="normal" data-type="button">See every card with Tome Intel</a></div>')
    return sec(inner, access="teaser")

def render_slate(games, free=3, free_keys=None, notes=None, abbr=None):
    """games in slate order. The free set is the first `free` games unless free_keys (e.g. ["BOS@NYK", ...]) says otherwise.
    notes: {"AWAY@HOME": (driven_by, why)}. Returns editor HTML: free cards, a teaser for non-Intel readers, then the Intel cards."""
    notes = notes or {}; abbr = abbr or (lambda g: (g["away"], g["home"]))
    key = lambda g: "%s@%s" % abbr(g)
    if free_keys: free_set = [g for g in games if key(g) in free_keys]
    else: free_set = games[:free]
    intel_set = [g for g in games if g not in free_set]
    out = ""
    for i, g in enumerate(games): g["_first_card"] = (i == 0)  # the early-season NFL note prints once per slate
    for g in free_set:
        d, w = notes.get(key(g), ("the number", "")); a, h = abbr(g)
        out += card(g, abbr_home=h, abbr_away=a, why=w, driven_by=d, access="free")
    if intel_set:
        out += teaser(intel_set, abbr)
        for g in intel_set:
            d, w = notes.get(key(g), ("the number", "")); a, h = abbr(g)
            out += card(g, abbr_home=h, abbr_away=a, why=w, driven_by=d, access="intel")
    return out

def preview_wrap(inner):
    return f"""<!doctype html><meta charset="utf-8"><title>The Card preview</title>
<style>body{{background:#FEFFEF;font:16px/1.5 Georgia,serif;max-width:640px;margin:32px auto;padding:0 16px}} .node-section{{background:#1a1a1a;border-radius:8px;padding:14px 16px;margin:0 0 16px}} .node-section p{{margin:6px 0}}
.node-section[data-show-to-paid-subscribers="false"]{{outline:2px dashed #FFB515;outline-offset:3px}} .node-section[data-show-to-free-subscribers="false"]{{opacity:.55}}
a[data-type="button"]{{display:inline-block;background:#FFB515;color:#1a1a1a;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:6px}}</style>
<p style="color:#8a8a86;font-size:.9rem">Preview: dashed outline = shown only to readers without Intel; faded = Intel-only cards.</p>{inner}"""

if __name__ == "__main__":
    # python3 tome_card.py projection.json [--free 3] [--free-games BOS@NYK,LAL@DEN,...] [--preview]
    data = json.load(open(sys.argv[1])); args = sys.argv[2:]
    free = int(args[args.index("--free") + 1]) if "--free" in args else 3
    free_keys = args[args.index("--free-games") + 1].split(",") if "--free-games" in args else None
    out = render_slate(data["games"], free=free, free_keys=free_keys)
    print(preview_wrap(out) if "--preview" in args else out)

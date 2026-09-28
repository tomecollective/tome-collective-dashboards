import re, html, glob, json, collections, math, datetime as dt

SP = '/tmp/claude-0/-home-claude/bc78343a-8853-5936-b47a-fc58845bd9b4/scratchpad/'
NAME2ABBR = {'Atlanta Dream':'ATL','Washington Mystics':'WSH','Toronto Tempo':'TOR','Connecticut Sun':'CON',
 'Indiana Fever':'IND','Las Vegas Aces':'LV','New York Liberty':'NY','Los Angeles Sparks':'LA','Dallas Wings':'DAL',
 'Golden State Valkyries':'GS','Portland Fire':'POR','Chicago Sky':'CHI','Minnesota Lynx':'MIN','Phoenix Mercury':'PHX','Seattle Storm':'SEA'}
NICK = {n.split()[-1]: a for n, a in NAME2ABBR.items()}
TOME2ESPN = {'WAS':'WSH','GSV':'GS','NYL':'NY','LVA':'LV','PHO':'PHX'}

def text(f):
    t = open(f).read()
    t = re.sub(r'<script.*?</script>|<style.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '\n', t); t = html.unescape(t)
    return re.sub(r'\n\s*\n+', '\n', t)

# ---------- parse Tome picks ----------
picks = []
for f in sorted(glob.glob(SP + 'previews/*.html')):
    date = f[-15:-5]
    txt = text(f)
    if '\nPICK\n' not in txt: continue
    hdr_re = re.compile(r'(' + '|'.join(map(re.escape, NAME2ABBR)) + r') @ (' + '|'.join(map(re.escape, NAME2ABBR)) + r')|\n(' + '|'.join(NICK) + r') at (' + '|'.join(NICK) + r')\n')
    for m in re.finditer(r'\nPICK\n(\S+) ([+-]?\d+(?:\.5)?|PK|EVEN)\nO/U (\d+(?:\.5)?)\n(Over|Under)', txt):
        hs = [h for h in hdr_re.finditer(txt[:m.start()])]
        if not hs: print('no header', f); continue
        h = hs[-1]
        if h.group(1): away, home = NAME2ABBR[h.group(1)], NAME2ABBR[h.group(2)]
        else: away, home = NICK[h.group(3)], NICK[h.group(4)]
        team = TOME2ESPN.get(m.group(1), m.group(1))
        sp = 0.0 if m.group(2) in ('PK', 'EVEN') else float(m.group(2))
        if team not in (home, away): print('team mismatch', f, team, home, away); continue
        spread_home = sp if team == home else -sp
        picks.append(dict(date=date, home=home, away=away, spread_home=spread_home, total=float(m.group(3)),
                          tome_side='HOME' if team == home else 'AWAY', tome_total=m.group(4).upper()))
print('parsed picks:', len(picks))

# ---------- games ----------
games = [g for g in json.load(open(SP + 'wnba_2026_games.json')) if g['season_type'] in (2, 3) and 'COOP' not in (g['home'], g['away'])]
games.sort(key=lambda g: g['date'])
bykey = {(g['date'], g['home'], g['away']): g for g in games}
matched = 0
for p in picks:
    g = bykey.get((p['date'], p['home'], p['away']))
    if not g:
        # try +/- 1 day
        for d in (1, -1):
            dd = (dt.date.fromisoformat(p['date']) + dt.timedelta(days=d)).isoformat()
            g = bykey.get((dd, p['home'], p['away']))
            if g: break
    p['game'] = g
    matched += bool(g)
print('matched to finals:', matched)
picks = [p for p in picks if p['game']]

# ---------- model (port of worker.js) ----------
AVG = 82.0
def build_ratings(hist, asof, hca, half_life, prior, playoff_w):
    teams = collections.defaultdict(lambda: dict(games=[], w=0.0, pf=0.0, pa=0.0, last=None, n=0))
    a = dt.date.fromisoformat(asof)
    for g in hist:
        days = max(0, (a - dt.date.fromisoformat(g['date'])).days)
        w = 0.5 ** (days / half_life)
        if g['season_type'] == 3: w *= playoff_w
        h, v, hs, vs = g['home'], g['away'], g['hs'], g['vs']
        m = hs - vs - hca
        teams[h]['games'].append((v, m, w)); teams[v]['games'].append((h, -m, w))
        for t_, pf, pa in ((h, hs, vs), (v, vs, hs)):
            T = teams[t_]; T['w'] += w; T['pf'] += pf * w; T['pa'] += pa * w; T['n'] += 1
            if not T['last'] or g['date'] > T['last']: T['last'] = g['date']
    names = list(teams); rating = {n: 0.0 for n in names}
    sw = sum(T['w'] for T in teams.values()); AVG_ = (sum(T['pf'] for T in teams.values()) / sw) if sw else AVG
    for _ in range(25):
        nxt = {}
        for n in names:
            T = teams[n]; sw = sum(w for _, _, w in T['games']); acc = sum(w * (m + rating[o]) for o, m, w in T['games'])
            raw = acc / sw if sw else 0
            nxt[n] = raw * min(1, T['n'] / prior)
        mean = sum(nxt.values()) / len(names)
        rating = {n: nxt[n] - mean for n in names}
    out = {}
    for n in names:
        T = teams[n]; k = min(1, T['n'] / prior)
        out[n] = dict(rating=rating[n], n=T['n'], last=T['last'],
                      pf=(T['pf'] / T['w'] if T['w'] else AVG_) * k + AVG_ * (1 - k),
                      pa=(T['pa'] / T['w'] if T['w'] else AVG_) * k + AVG_ * (1 - k))
    out['__avg__'] = AVG_
    return out

def rest_adj(last, date):
    if not last: return 0
    d = (dt.date.fromisoformat(date) - dt.date.fromisoformat(last)).days
    if d <= 1: return -1.5
    if d == 2: return -0.5
    if d >= 4: return 0.5
    return 0

def project(r, g, hca, playoff_total_adj):
    avg = r.get('__avg__', AVG)
    D = dict(rating=0, pf=avg, pa=avg, n=0, last=None)
    H, V = r.get(g['home'], D), r.get(g['away'], D)
    margin = H['rating'] - V['rating'] + hca + rest_adj(H['last'], g['date']) - rest_adj(V['last'], g['date'])
    total = H['pf'] + V['pa'] - avg + V['pf'] + H['pa'] - avg + (playoff_total_adj if g['season_type'] == 3 else 0)
    return -margin, total

def run(hca=2.5, half_life=10, prior=8, playoff_w=1.5, pta=-3):
    rows = []
    cache = {}
    for p in picks:
        g = p['game']; d = g['date']
        if d not in cache:
            cache[d] = build_ratings([x for x in games if x['date'] < d], d, hca, half_life, prior, playoff_w)
        ps, pt = project(cache[d], g, hca, pta)
        side_edge = p['spread_home'] - ps          # >0 → home is value
        total_edge = pt - p['total']              # >0 → over
        actual_margin = g['hs'] - g['vs']
        cover_home = actual_margin + p['spread_home']   # >0 home covers
        total_res = g['hs'] + g['vs'] - p['total']      # >0 over
        rows.append(dict(p, proj_spread=ps, proj_total=pt, side_edge=side_edge, total_edge=total_edge,
                         cover_home=cover_home, total_res=total_res,
                         model_side='HOME' if side_edge > 0 else 'AWAY', model_total='OVER' if total_edge > 0 else 'UNDER'))
    return rows

def grade(side, cover_home):
    if cover_home == 0: return 'P'
    return 'W' if (cover_home > 0) == (side == 'HOME') else 'L'
def grade_t(tot, res):
    if res == 0: return 'P'
    return 'W' if (res > 0) == (tot == 'OVER') else 'L'

def rec(rs):
    c = collections.Counter(rs); w, l = c['W'], c['L']
    return f"{w}-{l}" + (f"-{c['P']}" if c['P'] else '') + (f" ({w/(w+l):.1%})" if w + l else '')

if __name__ == '__main__':
    rows = run()
    print('\n== Tome actual (PICK era, %d games) ==' % len(rows))
    print('sides :', rec([grade(r['tome_side'], r['cover_home']) for r in rows]))
    print('totals:', rec([grade_t(r['tome_total'], r['total_res']) for r in rows]))
    print('\n== Model, every game (default params) ==')
    print('sides :', rec([grade(r['model_side'], r['cover_home']) for r in rows]))
    print('totals:', rec([grade_t(r['model_total'], r['total_res']) for r in rows]))
    print('agree w/ Tome sides: %d/%d' % (sum(r['model_side'] == r['tome_side'] for r in rows), len(rows)))
    print('agree w/ Tome totals: %d/%d' % (sum(r['model_total'] == r['tome_total'] for r in rows), len(rows)))
    # Tome favorites vs dogs
    fav = [grade(r['tome_side'], r['cover_home']) for r in rows if (r['tome_side']=='HOME') == (r['spread_home']<0)]
    dog = [grade(r['tome_side'], r['cover_home']) for r in rows if (r['tome_side']=='HOME') != (r['spread_home']<0)]
    print('Tome on favorites:', rec(fav), ' on dogs:', rec(dog))
    print('Tome on overs:', rec([grade_t(r['tome_total'], r['total_res']) for r in rows if r['tome_total']=='OVER']),
          ' unders:', rec([grade_t(r['tome_total'], r['total_res']) for r in rows if r['tome_total']=='UNDER']))
    print('\n== Model by confidence tier (side edge) ==')
    for lo, hi, name in [(0, 1.25, 'Coin flip <1.25'), (1.25, 2.5, 'Lean 1.25-2.5'), (2.5, 5, 'Strong 2.5-5'), (5, 99, 'Strong 5+')]:
        rs = [grade(r['model_side'], r['cover_home']) for r in rows if lo <= abs(r['side_edge']) < hi]
        print(f'  {name:18s} n={len(rs):3d} {rec(rs)}')
    print('== Model by confidence tier (total edge) ==')
    for lo, hi, name in [(0, 2, 'Coin flip <2'), (2, 4, 'Lean 2-4'), (4, 7, 'Strong 4-7'), (7, 99, 'Strong 7+')]:
        rs = [grade_t(r['model_total'], r['total_res']) for r in rows if lo <= abs(r['total_edge']) < hi]
        print(f'  {name:18s} n={len(rs):3d} {rec(rs)}')
    print('\n== Threshold sweep (model sides) ==')
    for th in [0, 1, 1.5, 2, 2.5, 3, 4, 5]:
        rs = [grade(r['model_side'], r['cover_home']) for r in rows if abs(r['side_edge']) >= th]
        print(f'  |edge|>={th:<4} n={len(rs):3d} {rec(rs)}')
    print('== Threshold sweep (model totals) ==')
    for th in [0, 2, 3, 4, 5, 6, 8]:
        rs = [grade_t(r['model_total'], r['total_res']) for r in rows if abs(r['total_edge']) >= th]
        print(f'  |edge|>={th:<4} n={len(rs):3d} {rec(rs)}')
    # calibration: how good is the projection vs the market?
    mae_model = sum(abs(-r['proj_spread'] - (r['game']['hs']-r['game']['vs'])) for r in rows)/len(rows)
    mae_mkt = sum(abs(-r['spread_home'] - (r['game']['hs']-r['game']['vs'])) for r in rows)/len(rows)
    mae_tm = sum(abs(r['proj_total'] - (r['game']['hs']+r['game']['vs'])) for r in rows)/len(rows)
    mae_tk = sum(abs(r['total'] - (r['game']['hs']+r['game']['vs'])) for r in rows)/len(rows)
    print(f'\nMAE margin: model {mae_model:.2f} vs market {mae_mkt:.2f} | MAE total: model {mae_tm:.2f} vs market {mae_tk:.2f}')
    bias_t = sum(r['proj_total'] - r['total'] for r in rows)/len(rows)
    print(f'model total bias vs market: {bias_t:+.2f}; actual total minus market avg: {sum(r["total_res"] for r in rows)/len(rows):+.2f}')
    print('\n== Parameter sweep (sides, |edge|>=2.5 / totals |edge|>=4) ==')
    for hl in (6, 10, 15, 25):
        for hca in (2.0, 2.5, 3.0):
            rows2 = run(hca=hca, half_life=hl)
            s = [grade(r['model_side'], r['cover_home']) for r in rows2 if abs(r['side_edge']) >= 2.5]
            sa = [grade(r['model_side'], r['cover_home']) for r in rows2]
            t = [grade_t(r['model_total'], r['total_res']) for r in rows2 if abs(r['total_edge']) >= 4]
            print(f'  hl={hl:2d} hca={hca}: all sides {rec(sa):16s} strong sides {rec(s):16s} strong totals {rec(t)}')
    json.dump([{k: v for k, v in r.items() if k != 'game'} | {'hs': r['game']['hs'], 'vs': r['game']['vs']} for r in rows], open(SP + 'backtest_rows.json', 'w'), indent=1)

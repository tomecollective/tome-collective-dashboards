// tome-lines — projection, lean threshold, pick log, and closing-line grading
// for WNBA, NBA, and NFL. Informational tooling for Tome Collective previews and recaps.
//
// Endpoints
//   GET  /health
//   GET  /api/lines/ratings?league=wnba[&asof=YYYY-MM-DD]
//   GET  /api/lines/projection?league=wnba&date=YYYY-MM-DD
//        optional: &adjust=IND:-3,WAS:+1   (manual points adjustments, e.g. injuries; + helps that team)
//        optional: &lines=<urlencoded JSON> [{"game_id":123,"spread_home":-6.5,"total":177.5}]
//   POST /api/lines/pick        (admin)  body: {league, game_id, side?: "HOME"|"AWAY", spread_home_at_pick, total_at_pick, total_side?: "OVER"|"UNDER", side_tier?, total_tier?, access?: "free"|"intel", note?}
//   POST /api/lines/close       (admin)  body: {league, game_id, spread_home_close, total_close}
//   GET  /api/lines/record?league=wnba[&from=YYYY-MM-DD]   grades logged picks against final scores + CLV
//   GET  /api/lines/market?league=wnba&date=YYYY-MM-DD      open/current lines, public %, finals (sportsbookreview, cached in KV)
//   GET  /api/lines/trends?league=wnba&date=YYYY-MM-DD&n=10 last-N ATS and O/U per team against the closing number
//   POST /api/lines/market/backfill?league=wnba&from=&to=   (admin) cache up to 20 past market days per call
//
// Conventions: spreads are quoted for the HOME team (home -6.5 means home favored by 6.5).
// Every game gets a pick. Confidence comes from |projection - market| against the league's edge threshold:
//   STRONG  |edge| >= 2 x threshold      LEAN  |edge| >= threshold      COIN FLIP  below it
// The 2026 WNBA backtest (122 games, Jul 28 - Sep 27) is in backtest-2026-wnba.md: read it before trusting a tier.

const BDL = "https://api.balldontlie.io";
const LEAGUE = {
  wnba: { base: `${BDL}/wnba/v1`, season: (d) => d.getUTCFullYear(), gamesPerSeason: 44 },
  nba:  { base: `${BDL}/v1`,      season: (d) => (d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1), gamesPerSeason: 82 },
  nfl:  { base: `${BDL}/nfl/v1`,  season: (d) => (d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1), gamesPerSeason: 17 },
};
// Fallback league-average points per team per game. Used only until a season has games; after that the
// recency-weighted league average from the actual results is used (a stale constant here put every WNBA
// total 13 points high in the 2026 backtest).
const LEAGUE_AVG_PTS = { wnba: 87, nba: 114, nfl: 22 };
// Regular-season games needed before the rating is trusted at full weight (shrinkage).
const PRIOR_GAMES = { wnba: 8, nba: 10, nfl: 6 };

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function cfg(env, league) {
  const L = league.toUpperCase();
  return {
    hca: num(env[`${L}_HCA`], 2),
    halfLife: num(env[`${L}_HALF_LIFE`], 10),
    sideEdge: num(env[`${L}_SIDE_EDGE`], 2.5),
    totalEdge: num(env[`${L}_TOTAL_EDGE`], 4),
    playoffWeight: num(env.PLAYOFF_GAME_WEIGHT, 1.5),
    playoffTotalAdj: num(env[`PLAYOFF_TOTAL_ADJ_${L}`], 0),
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token" } });
}
function isAdmin(request, env) {
  const t = request.headers.get("X-Admin-Token") || new URL(request.url).searchParams.get("adminToken");
  return !!env.TOME_ADMIN_TOKEN && t === env.TOME_ADMIN_TOKEN;
}

// ---------- BALLDONTLIE ----------
async function bdl(env, league, path, params = {}) {
  const url = new URL(`${LEAGUE[league].base}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const out = [];
  let cursor;
  for (let page = 0; page < 40; page++) {
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("per_page", "100");
    const res = await fetch(url, { headers: { Authorization: env.BALLDONTLIE_API_KEY } });
    if (!res.ok) throw new Error(`BALLDONTLIE ${res.status} on ${path}`);
    const body = await res.json();
    out.push(...(body.data || []));
    cursor = body.meta?.next_cursor;
    if (!cursor) break;
  }
  return out;
}
function abbr(team) { return team?.abbreviation || team?.abbr || String(team?.id); }
// BALLDONTLIE stamps games in UTC; a night game in the US lands on the next UTC day. Use the Eastern date when a time is present.
function gameDate(g) { const s = String(g.datetime || g.date || ""); return s.includes("T") ? etDate(s) : s.slice(0, 10); }
// Score fields differ by league on BALLDONTLIE: NBA/NFL use home_team_score/visitor_team_score, WNBA uses home_score/away_score.
function hScore(g) { return g.home_team_score ?? g.home_score ?? null; }
function vScore(g) { return g.visitor_team_score ?? g.away_score ?? null; }
function isFinal(g) {
  const s = String(g.status_state || g.status || "").toLowerCase();
  if (s === "post" || s === "final" || s.startsWith("final")) return true;
  return hScore(g) > 0 && vScore(g) > 0 && (g.period ?? 0) >= 4 && !s.includes("q") && !s.includes("half") && !s.includes("in");
}
function isPostseason(g) { return !!(g.postseason || g.playoffs || /post|playoff/i.test(String(g.season_type || ""))); }
function isExhibition(g, league) {
  if (league !== "wnba") return false;
  const n = `${g.home_team?.full_name || ""} ${g.visitor_team?.full_name || ""}`.toLowerCase();
  return /all-star|team usa|team wnba|team collier|team clark|team stewart|team wilson|select/.test(n);
}

// Season start (month) per league; the NBA season is named for the year it starts in.
const SEASON_START = { wnba: "05-01", nba: "10-01", nfl: "08-25" };
// Finals from season start through asofDate. Date-range only (no seasons[] filter: BALLDONTLIE's WNBA
// endpoint returns nothing when both are combined). Cached in KV for 10 minutes so a burst of calls
// doesn't trip the BALLDONTLIE rate limit.
async function fetchSeasonGames(env, league, asofDate) {
  const key = `games:${league}:${asofDate}`;
  const cached = await env.LINES_KV.get(key, "json");
  if (cached) return cached;
  const d = new Date(asofDate + "T00:00:00Z");
  const season = LEAGUE[league].season(d);
  const games = await bdl(env, league, "games", { start_date: `${season}-${SEASON_START[league]}`, end_date: asofDate });
  const finals = games.filter((g) => isFinal(g) && !isExhibition(g, league) && gameDate(g) <= asofDate);
  if (finals.length) await env.LINES_KV.put(key, JSON.stringify(finals), { expirationTtl: 600 });
  return finals;
}

// ---------- MARKET (sportsbookreview public odds pages) ----------
// Opening and current/closing spreads and totals from eight books, public pick percentages, and final scores.
// Cached in KV: finished days forever, live days for 10 minutes. Used for the card's market row and L10 trends.
const SBR = { wnba: "wnba-basketball", nba: "nba-basketball", nfl: "nfl-football" };
const SBR_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const BOOK_ORDER = ["draftkings", "fanduel", "betmgm", "caesars", "bet365", "fanatics", "hardrock", "bet_rivers_co"];
// SBR's NFL page is organised by week (?week=WeekN), not by date. Week 1 starts the Tuesday before kickoff.
const NFL_WEEK1_TUESDAY = "2026-09-08";
function nflWeek(date) { return Math.floor((new Date(date + "T00:00:00Z") - new Date(NFL_WEEK1_TUESDAY + "T00:00:00Z")) / (7 * 864e5)) + 1; }
// Game date in US Eastern terms (kickoffs are never within an hour of midnight ET, so a 5h shift is safe year-round).
function etDate(iso) { return new Date(new Date(iso).getTime() - 5 * 36e5).toISOString().slice(0, 10); }
function nick(name) { return String(name || "").trim().split(/\s+/).pop().toLowerCase(); }
function median(a) { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
async function sbrRows(league, date, market) {
  const q = league === "nfl" ? `week=Week${nflWeek(date)}` : `date=${date}`;
  const url = `https://www.sportsbookreview.com/betting-odds/${SBR[league]}/${market === "totals" ? "totals/full-game/" : ""}?${q}`;
  const res = await fetch(url, { headers: { "User-Agent": SBR_UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`SBR ${res.status} for ${league} ${date} ${market}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  const tables = data?.props?.pageProps?.oddsTables || [];
  const rows = tables.flatMap((t) => t?.oddsTableModel?.gameRows || []);
  // NFL: the week page carries Thursday through Monday; keep only the requested date (ET)
  return league === "nfl" ? rows.filter((r) => r.gameView?.startDate && etDate(r.gameView.startDate) === date) : rows;
}
function pickBook(views, field) {
  const by = Object.fromEntries(views.filter(Boolean).map((v) => [v.sportsbook, v]));
  for (const b of BOOK_ORDER) if (by[b] && by[b].currentLine?.[field] != null) return { book: b, open: by[b].openingLine?.[field] ?? null, close: by[b].currentLine?.[field] ?? null };
  return { book: "consensus", open: median(views.filter(Boolean).map((v) => v.openingLine?.[field])), close: median(views.filter(Boolean).map((v) => v.currentLine?.[field])) };
}
async function fetchMarket(env, league, date) {
  const key = `market:${league}:${date}`;
  const cached = await env.LINES_KV.get(key, "json");
  if (cached && (cached.all_final || Date.now() - new Date(cached.fetched_at).getTime() < 10 * 60e3)) return cached;
  const [spreads, totals] = await Promise.all([sbrRows(league, date, "spreads"), sbrRows(league, date, "totals")]);
  const totalsById = Object.fromEntries(totals.map((r) => [r.gameView?.gameId, r]));
  const games = spreads.map((r) => {
    const gv = r.gameView || {}; const t = totalsById[gv.gameId];
    const sp = pickBook(r.oddsViews || [], "homeSpread"); const tot = pickBook(t?.oddsViews || [], "total");
    const hasScore = gv.homeTeamScore != null && gv.awayTeamScore != null && (gv.homeTeamScore + gv.awayTeamScore) > 0;
    const ageH = gv.startDate ? (Date.now() - new Date(gv.startDate).getTime()) / 36e5 : 0;
    const finished = hasScore && (String(gv.status) === "1" || ageH > 5);
    const settled = finished || ageH > 24; // a day-old game with no score is a postponement or an SBR gap; don't block the cache
    return {
      sbr_id: gv.gameId, start: gv.startDate, home: gv.homeTeam?.fullName, away: gv.awayTeam?.fullName,
      home_nick: nick(gv.homeTeam?.fullName), away_nick: nick(gv.awayTeam?.fullName),
      home_score: gv.homeTeamScore ?? null, away_score: gv.awayTeamScore ?? null, final: finished, settled,
      spread_home: { open: sp.open, close: sp.close, book: sp.book }, total: { open: tot.open, close: tot.close, book: tot.book },
      public: { home_spread_pct: Math.round(gv.consensus?.homeSpreadPickPercent ?? 0) || null, over_pct: Math.round(gv.consensus?.overPickPercent ?? 0) || null },
    };
  });
  const rec = { league, date, fetched_at: new Date().toISOString(), all_final: games.length > 0 && games.every((g) => g.settled), games };
  await env.LINES_KV.put(key, JSON.stringify(rec));
  return rec;
}
function dateRange(from, to) { const out = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + 864e5)) out.push(d.toISOString().slice(0, 10)); return out; }
// Last-N trends against the closing number, per team, from cached market days before `date`.
async function trends(env, league, date, n = 10, lookbackDays = 60) {
  const days = dateRange(new Date(new Date(date + "T00:00:00Z").getTime() - lookbackDays * 864e5).toISOString().slice(0, 10), new Date(new Date(date + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10));
  const recs = (await Promise.all(days.map((d) => env.LINES_KV.get(`market:${league}:${d}`, "json")))).filter(Boolean);
  const byTeam = {};
  for (const r of recs) for (const g of r.games) {
    if (!g.final || g.spread_home.close == null) continue;
    const margin = g.home_score - g.away_score; const cover = margin + g.spread_home.close; // >0 home covers
    const pts = g.home_score + g.away_score; const ou = g.total.close == null ? null : pts - g.total.close;
    for (const [team, isHome] of [[g.home_nick, true], [g.away_nick, false]]) {
      (byTeam[team] ||= []).push({ date: r.date, ats: cover === 0 ? "P" : ((cover > 0) === isHome ? "W" : "L"), ou: ou == null ? null : ou === 0 ? "P" : ou > 0 ? "O" : "U", margin: isHome ? margin : -margin, side_result_pts: isHome ? cover : -cover });
    }
  }
  const out = {};
  for (const [team, list] of Object.entries(byTeam)) {
    const last = list.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
    const c = (k, v) => last.filter((x) => x[k] === v).length;
    out[team] = { games: last.length, ats: `${c("ats", "W")}-${c("ats", "L")}${c("ats", "P") ? `-${c("ats", "P")}` : ""}`, ou: `${c("ou", "O")}-${c("ou", "U")}${c("ou", "P") ? `-${c("ou", "P")}` : ""}`,
      avg_margin: +(last.reduce((s, x) => s + x.margin, 0) / (last.length || 1)).toFixed(1), avg_vs_spread: +(last.reduce((s, x) => s + x.side_result_pts, 0) / (last.length || 1)).toFixed(1) };
  }
  return out;
}

// ---------- RATINGS ----------
// Margin-based rating with recency weights, home-court adjustment, opponent adjustment
// (iterated), and shrinkage toward zero for teams with few games. Also produces
// recency-weighted points for/against for the totals projection.
function buildRatings(games, league, c, asofDate) {
  const asof = new Date(asofDate + "T00:00:00Z").getTime();
  const teams = {};
  const t = (a) => (teams[a] ||= { games: [], w: 0, pf: 0, pa: 0, lastDate: null, n: 0 });
  for (const g of games) {
    const days = Math.max(0, (asof - new Date(gameDate(g) + "T00:00:00Z").getTime()) / 864e5);
    let w = Math.pow(0.5, days / (c.halfLife * (league === "nfl" ? 7 : 1)));
    if (isPostseason(g)) w *= c.playoffWeight;
    const h = abbr(g.home_team), v = abbr(g.visitor_team);
    const hs = hScore(g), vs = vScore(g);
    // home margin with home court removed
    const m = hs - vs - c.hca;
    t(h).games.push({ opp: v, margin: m, w, date: gameDate(g) });
    t(v).games.push({ opp: h, margin: -m, w, date: gameDate(g) });
    for (const [a, pf, pa] of [[h, hs, vs], [v, vs, hs]]) {
      const T = t(a); T.w += w; T.pf += pf * w; T.pa += pa * w; T.n += 1;
      if (!T.lastDate || gameDate(g) > T.lastDate) T.lastDate = gameDate(g);
    }
  }
  const names = Object.keys(teams);
  const totalW = names.reduce((s, n) => s + teams[n].w, 0);
  const avg = totalW ? names.reduce((s, n) => s + teams[n].pf, 0) / totalW : LEAGUE_AVG_PTS[league]; // live league average
  const rating = Object.fromEntries(names.map((n) => [n, 0]));
  for (let iter = 0; iter < 25; iter++) {
    const next = {};
    for (const n of names) {
      const T = teams[n];
      let sw = 0, acc = 0;
      for (const g of T.games) { sw += g.w; acc += g.w * (g.margin + rating[g.opp]); }
      const raw = sw ? acc / sw : 0;
      const k = Math.min(1, T.n / PRIOR_GAMES[league]); // shrink toward 0 early
      next[n] = raw * k;
    }
    const mean = names.reduce((s, n) => s + next[n], 0) / (names.length || 1);
    for (const n of names) rating[n] = next[n] - mean;
  }
  const out = {};
  for (const n of names) {
    const T = teams[n];
    const k = Math.min(1, T.n / PRIOR_GAMES[league]);
    out[n] = {
      rating: +rating[n].toFixed(2),
      games: T.n,
      pf: +((T.w ? T.pf / T.w : avg) * k + avg * (1 - k)).toFixed(2),
      pa: +((T.w ? T.pa / T.w : avg) * k + avg * (1 - k)).toFixed(2),
      lastDate: T.lastDate,
    };
  }
  Object.defineProperty(out, "leagueAvg", { value: +avg.toFixed(2), enumerable: false });
  return out;
}

function restAdj(league, lastDate, gameDate_) {
  if (!lastDate) return 0;
  const days = (new Date(gameDate_ + "T00:00:00Z") - new Date(lastDate + "T00:00:00Z")) / 864e5;
  if (league === "nfl") return 0; // bye-week effects are small and noisy; ignore in v1
  if (days <= 1) return -1.5;     // back-to-back
  if (days === 2) return -0.5;
  if (days >= 4) return +0.5;     // long rest, modest
  return 0;
}

function parseAdjust(s) {
  const out = {};
  for (const part of (s || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z]{2,4}):([+-]?\d+(\.\d+)?)$/);
    if (m) out[m[1].toUpperCase()] = parseFloat(m[2]);
  }
  return out;
}

function project(league, c, ratings, g, adjust, postseason) {
  const h = abbr(g.home_team), v = abbr(g.visitor_team);
  const avg = ratings.leagueAvg ?? LEAGUE_AVG_PTS[league];
  const H = ratings[h] || { rating: 0, pf: avg, pa: avg, games: 0, lastDate: null };
  const V = ratings[v] || { rating: 0, pf: avg, pa: avg, games: 0, lastDate: null };
  const gd = gameDate(g);
  const restH = restAdj(league, H.lastDate, gd), restV = restAdj(league, V.lastDate, gd);
  const daysSince = (last) => (last ? Math.round((new Date(gd + "T00:00:00Z") - new Date(last + "T00:00:00Z")) / 864e5) : null);
  const adjH = adjust[h] || 0, adjV = adjust[v] || 0;
  const margin = (H.rating - V.rating) + c.hca + (restH - restV) + (adjH - adjV); // positive = home favored
  // each team's expected points: its offense vs the other's defense, centered on league average
  const ptsH = H.pf + V.pa - avg + adjH / 2;
  const ptsV = V.pf + H.pa - avg + adjV / 2;
  let total = ptsH + ptsV + (postseason ? c.playoffTotalAdj : 0);
  return {
    game_id: g.id, date: gd, home: h, away: v, postseason,
    projected_spread_home: +(-margin).toFixed(1),   // quoted like a book: home -6.5
    projected_total: +total.toFixed(1),
    inputs: { league_avg_pts: avg, home_rating: H.rating, away_rating: V.rating, hca: c.hca, rest_home: restH, rest_away: restV, days_since_home: daysSince(H.lastDate), days_since_away: daysSince(V.lastDate), adjust_home: adjH, adjust_away: adjV, home_games: H.games, away_games: V.games, home_pf_pa: [H.pf, H.pa], away_pf_pa: [V.pf, V.pa] },
  };
}

// Confidence tier from the size of the disagreement with the market.
function tier(edge, threshold) {
  const a = Math.abs(edge);
  return a >= 2 * threshold ? "STRONG" : a >= threshold ? "LEAN" : "COIN FLIP";
}
// Always returns a pick on both markets; the tier says how much to trust it.
function lean(p, market, c) {
  const out = { side: null, side_pick: null, side_edge: null, side_tier: null, total: null, total_pick: null, total_edge: null, total_tier: null };
  if (market?.spread_home != null) {
    const edge = +(market.spread_home - p.projected_spread_home).toFixed(1); // >0 means home is better value than book says
    const home = edge >= 0;
    out.side_edge = edge;
    out.side_pick = home ? "HOME" : "AWAY";
    out.side_tier = tier(edge, c.sideEdge);
    out.side = home ? `${p.home} ${market.spread_home > 0 ? "+" : ""}${market.spread_home}` : `${p.away} ${-market.spread_home > 0 ? "+" : ""}${-market.spread_home}`;
  }
  if (market?.total != null) {
    const edge = +(p.projected_total - market.total).toFixed(1);
    out.total_edge = edge;
    out.total_pick = edge >= 0 ? "OVER" : "UNDER";
    out.total_tier = tier(edge, c.totalEdge);
    out.total = `${out.total_pick} ${market.total}`;
  }
  return out;
}

// ---------- HANDLERS ----------
async function handleRatings(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!LEAGUE[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const asof = url.searchParams.get("asof") || new Date().toISOString().slice(0, 10);
  const c = cfg(env, league);
  const games = await fetchSeasonGames(env, league, asof);
  const ratings = buildRatings(games, league, c, asof);
  const table = Object.entries(ratings).map(([team, r]) => ({ team, ...r })).sort((a, b) => b.rating - a.rating);
  return json({ league, asof, games_used: games.length, config: c, ratings: table });
}

async function handleProjection(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!LEAGUE[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const c = cfg(env, league);
  const adjust = parseAdjust(url.searchParams.get("adjust"));
  let lines = [];
  try { lines = JSON.parse(url.searchParams.get("lines") || "[]"); } catch { return json({ error: "lines must be JSON" }, 400); }
  const byId = Object.fromEntries(lines.map((l) => [String(l.game_id), l]));
  const yesterday = new Date(new Date(date + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
  const tomorrow = new Date(new Date(date + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  const [hist, slateRaw] = await Promise.all([
    fetchSeasonGames(env, league, yesterday),
    bdl(env, league, "games", { dates: [date, tomorrow] }), // UTC-stamped night games spill into the next day
  ]);
  const slate = slateRaw.filter((g) => gameDate(g) === date);
  const ratings = buildRatings(hist, league, c, date);
  // Market rows from sportsbookreview (best effort; the lines param still wins when given)
  let mkt = null, tr = {};
  if (url.searchParams.get("market") !== "0") {
    try { [mkt, tr] = await Promise.all([fetchMarket(env, league, date), trends(env, league, date, league === "nfl" ? 5 : 10, league === "nfl" ? 120 : 60)]); } catch (e) { mkt = { error: e.message, games: [] }; }
  }
  const mktByNick = Object.fromEntries((mkt?.games || []).map((m) => [`${m.away_nick}@${m.home_nick}`, m]));
  const games = slate.filter((g) => !isExhibition(g, league)).map((g) => {
    const p = project(league, c, ratings, g, adjust, isPostseason(g));
    const hn = nick(g.home_team?.full_name || g.home_team?.name), vn = nick(g.visitor_team?.full_name || g.visitor_team?.name);
    const m = mktByNick[`${vn}@${hn}`] || null;
    const market = byId[String(g.id)] || (m && m.spread_home.close != null ? { spread_home: m.spread_home.close, total: m.total.close, source: `sbr:${m.spread_home.book}` } : null);
    const L = lean(p, market, c);
    const card = m ? {
      line: { spread_home_open: m.spread_home.open, spread_home_now: m.spread_home.close, total_open: m.total.open, total_now: m.total.close, book: m.spread_home.book,
        spread_move: m.spread_home.open != null && m.spread_home.close != null ? +(m.spread_home.close - m.spread_home.open).toFixed(1) : null,
        total_move: m.total.open != null && m.total.close != null ? +(m.total.close - m.total.open).toFixed(1) : null },
      public: m.public,
      trends: { home: tr[hn] || null, away: tr[vn] || null },
      rest: { home_days_since: p.inputs.rest_home, away_days_since: p.inputs.rest_away, home_days: p.inputs.days_since_home, away_days: p.inputs.days_since_away },
      league,
    } : null;
    return { ...p, market, lean: L, card };
  });
  const count = (k) => games.reduce((acc, g) => { const t = g.lean[k]; if (t) acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  return json({ league, date, games_used_for_ratings: hist.length, league_avg_pts: ratings.leagueAvg ?? null, market_source: mkt?.error ? `unavailable: ${mkt.error}` : (mkt ? "sportsbookreview" : "lines param only"),
    thresholds: { side: c.sideEdge, total: c.totalEdge, tiers: "STRONG >= 2x threshold, LEAN >= threshold, COIN FLIP below" },
    tiers: { side: count("side_tier"), total: count("total_tier") }, games });
}

async function handleMarket(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!SBR[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  return json(await fetchMarket(env, league, date));
}
async function handleTrends(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!SBR[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const n = parseInt(url.searchParams.get("n") || "10", 10);
  return json({ league, asof: date, n, teams: await trends(env, league, date, n) });
}
// Admin: cache a range of past market days so trends have history. Max 20 days per call (two fetches per day).
async function handleBackfill(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!SBR[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const from = url.searchParams.get("from"), to = url.searchParams.get("to") || from;
  if (!from) return json({ error: "from required" }, 400);
  const days = dateRange(from, to).slice(0, 20);
  const done = [];
  for (const d of days) { try { const r = await fetchMarket(env, league, d); done.push({ date: d, games: r.games.length, all_final: r.all_final }); } catch (e) { done.push({ date: d, error: e.message }); } }
  return json({ league, days: done, next_from: days.length === 20 ? dateRange(days[19], days[19]).map((d) => new Date(new Date(d + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10))[0] : null });
}

async function handlePick(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !LEAGUE[b.league] || !b.game_id) return json({ error: "league and game_id required" }, 400);
  const key = `pick:${b.league}:${b.game_id}`;
  const existing = JSON.parse((await env.LINES_KV.get(key)) || "{}");
  const rec = { ...existing, league: b.league, game_id: b.game_id, side: b.side ?? existing.side ?? null, total_side: b.total_side ?? existing.total_side ?? null,
    spread_home_at_pick: b.spread_home_at_pick ?? existing.spread_home_at_pick ?? null, total_at_pick: b.total_at_pick ?? existing.total_at_pick ?? null,
    projected_spread_home: b.projected_spread_home ?? existing.projected_spread_home ?? null, projected_total: b.projected_total ?? existing.projected_total ?? null,
    side_tier: b.side_tier ?? existing.side_tier ?? null, total_tier: b.total_tier ?? existing.total_tier ?? null,
    access: (b.access ?? existing.access ?? "free") === "intel" ? "intel" : "free", // free = in the open; intel = behind the gate
    override: b.override ?? existing.override ?? false, note: b.note ?? existing.note ?? null, picked_at: existing.picked_at || new Date().toISOString() };
  await env.LINES_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, pick: rec });
}
async function handleClose(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !LEAGUE[b.league] || !b.game_id) return json({ error: "league and game_id required" }, 400);
  const key = `pick:${b.league}:${b.game_id}`;
  const rec = JSON.parse((await env.LINES_KV.get(key)) || "null");
  if (!rec) return json({ error: "no pick logged for that game" }, 404);
  rec.spread_home_close = b.spread_home_close ?? rec.spread_home_close ?? null;
  rec.total_close = b.total_close ?? rec.total_close ?? null;
  rec.closed_at = new Date().toISOString();
  await env.LINES_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, pick: rec });
}

async function handleRecord(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!LEAGUE[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const from = url.searchParams.get("from") || "2000-01-01";
  const keys = [];
  let cursor;
  do {
    const page = await env.LINES_KV.list({ prefix: `pick:${league}:`, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const picks = (await Promise.all(keys.map((k) => env.LINES_KV.get(k, "json")))).filter(Boolean);
  const ids = picks.map((p) => p.game_id);
  // Finals are cached forever; anything not final is re-fetched (in one call) each time.
  const cachedFinals = (await Promise.all(ids.map((id) => env.LINES_KV.get(`final:${league}:${id}`, "json")))).filter(Boolean);
  const have = new Set(cachedFinals.map((g) => String(g.id)));
  const need = ids.filter((id) => !have.has(String(id)));
  const fresh = need.length ? await bdl(env, league, "games", { ids: need }) : [];
  for (const g of fresh) if (isFinal(g)) await env.LINES_KV.put(`final:${league}:${g.id}`, JSON.stringify(g));
  const byId = Object.fromEntries([...cachedFinals, ...fresh].map((g) => [String(g.id), g]));
  const rows = [], tally = { side: { w: 0, l: 0, p: 0 }, total: { w: 0, l: 0, p: 0 }, clv_side: [], clv_total: [], model: { w: 0, l: 0 }, override: { w: 0, l: 0 }, by_tier: {} };
  const tierTally = (market, t, res) => { if (!t || res === "P") return; const k = `${market}:${t}`; tally.by_tier[k] ||= { w: 0, l: 0 }; tally.by_tier[k][res.toLowerCase()]++; };
  tally.by_access = { free: { w: 0, l: 0 }, intel: { w: 0, l: 0 } };
  const accessTally = (p, res) => { if (res === "P") return; tally.by_access[p.access === "intel" ? "intel" : "free"][res.toLowerCase()]++; };
  for (const p of picks) {
    const g = byId[String(p.game_id)];
    if (!g || gameDate(g) < from) continue;
    if ((p.spread_home_close == null || p.total_close == null)) { // fill the close from the market cache when it wasn't logged by hand
      const mk = await env.LINES_KV.get(`market:${league}:${gameDate(g)}`, "json");
      const m = mk?.games?.find((x) => x.home_nick === nick(g.home_team?.full_name || g.home_team?.name) && x.away_nick === nick(g.visitor_team?.full_name || g.visitor_team?.name));
      if (m) { p.spread_home_close ??= m.spread_home.close; p.total_close ??= m.total.close; }
    }
    const row = { game_id: p.game_id, date: gameDate(g), matchup: `${abbr(g.visitor_team)} @ ${abbr(g.home_team)}`, ...p, final: isFinal(g) ? `${vScore(g)}-${hScore(g)}` : null };
    if (isFinal(g)) {
      const homeMargin = hScore(g) - vScore(g);
      if (p.side && p.spread_home_at_pick != null) {
        const homeCover = homeMargin + p.spread_home_at_pick; // >0 home covers
        const pickedHome = p.side === "HOME";
        const res = homeCover === 0 ? "P" : ((homeCover > 0) === pickedHome ? "W" : "L");
        row.side_result = res; tally.side[res.toLowerCase()]++; tierTally("side", p.side_tier, res); accessTally(p, res);
        if (res !== "P") (p.override ? tally.override : tally.model)[res.toLowerCase()]++;
        if (p.spread_home_close != null) {
          // CLV in points from the picked team's perspective
          const clv = pickedHome ? (p.spread_home_at_pick - p.spread_home_close) : (p.spread_home_close - p.spread_home_at_pick);
          row.side_clv = +clv.toFixed(1); tally.clv_side.push(clv);
        }
      }
      if (p.total_side && p.total_at_pick != null) {
        const pts = hScore(g) + vScore(g);
        const res = pts === p.total_at_pick ? "P" : (((pts > p.total_at_pick) === (p.total_side === "OVER")) ? "W" : "L");
        row.total_result = res; tally.total[res.toLowerCase()]++; tierTally("total", p.total_tier, res); accessTally(p, res);
        if (p.total_close != null) {
          const clv = p.total_side === "OVER" ? (p.total_close - p.total_at_pick) : (p.total_at_pick - p.total_close);
          row.total_clv = +clv.toFixed(1); tally.clv_total.push(clv);
        }
      }
    }
    rows.push(row);
  }
  const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);
  const pct = (t) => (t.w + t.l ? +((100 * t.w) / (t.w + t.l)).toFixed(1) : null);
  return json({
    league, from,
    record: { side: `${tally.side.w}-${tally.side.l}${tally.side.p ? `-${tally.side.p}` : ""}`, side_pct: pct(tally.side), total: `${tally.total.w}-${tally.total.l}${tally.total.p ? `-${tally.total.p}` : ""}`, total_pct: pct(tally.total) },
    closing_line_value: { side_avg_points: mean(tally.clv_side), side_n: tally.clv_side.length, total_avg_points: mean(tally.clv_total), total_n: tally.clv_total.length },
    model_vs_override: { model: `${tally.model.w}-${tally.model.l}`, override: `${tally.override.w}-${tally.override.l}` },
    by_tier: Object.fromEntries(Object.entries(tally.by_tier).map(([k, t]) => [k, { record: `${t.w}-${t.l}`, pct: pct(t) }])),
    by_access: Object.fromEntries(Object.entries(tally.by_access).map(([k, t]) => [k, { record: `${t.w}-${t.l}`, pct: pct(t) }])), // sides and totals combined
    picks: rows.sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
}

export default {
  // Nightly: cache yesterday's and today's market pages for every league so closes and trends fill themselves.
  async scheduled(event, env) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    for (const league of Object.keys(SBR)) for (const d of [yesterday, today]) { try { await fetchMarket(env, league, d); } catch (e) { /* SBR hiccup; the next run catches up */ } }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({});
    try {
      if (url.pathname === "/health") return json({ ok: true, leagues: Object.keys(LEAGUE), configured: !!env.BALLDONTLIE_API_KEY });
      if (url.pathname === "/api/lines/ratings") return await handleRatings(url, env);
      if (url.pathname === "/api/lines/projection") return await handleProjection(url, env);
      if (url.pathname === "/api/lines/record") return await handleRecord(url, env);
      if (url.pathname === "/api/lines/market") return await handleMarket(url, env);
      if (url.pathname === "/api/lines/trends") return await handleTrends(url, env);
      if (url.pathname === "/api/lines/market/backfill" && request.method === "POST") return isAdmin(request, env) ? await handleBackfill(url, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/pick" && request.method === "POST") return isAdmin(request, env) ? await handlePick(request, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/close" && request.method === "POST") return isAdmin(request, env) ? await handleClose(request, env) : json({ error: "unauthorized" }, 401);
      return new Response("tome-lines", { status: 200 });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};

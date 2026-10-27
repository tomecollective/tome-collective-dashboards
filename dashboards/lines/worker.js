// tome-lines — projection, lean threshold, pick log, and closing-line grading
// for WNBA, NBA, and NFL. Informational tooling for Tome Collective previews and recaps.
//
// Endpoints
//   GET  /health
//   GET  /api/lines/ratings?league=wnba[&asof=YYYY-MM-DD]
//   GET  /api/lines/projection?league=wnba&date=YYYY-MM-DD
//        optional: &adjust=IND:-3,WAS:+1   (manual points adjustments, e.g. injuries; + helps that team)
//        optional: &lines=<urlencoded JSON> [{"game_id":123,"spread_home":-6.5,"total":177.5}]
//   POST /api/lines/pick        (admin)  body: {league, game_id, side?: "HOME"|"AWAY", spread_home_at_pick, total_at_pick, total_side?: "OVER"|"UNDER", side_tier?, total_tier?, access?: "free"|"intel", note?, source_post_id?, date?, home?, away?, home_nick?, away_nick?, postseason?}
//   POST /api/lines/close       (admin)  body: {league, game_id, spread_home_close, total_close}
//   GET  /api/lines/record?league=wnba[&from=YYYY-MM-DD][&to=]   graded ledger (one row per market) + cuts over the window
//   GET  /api/lines/record/summary[?asof=YYYY-MM-DD][&league=][&slate=YYYY-MM-DD]   every published cut: segments, season-to-date, slate, chapters, tiers
//   POST /api/lines/pick/delete (admin)  body: {league, game_id}  -- remove a duplicate or test card
//   POST /api/lines/void        (admin)  body: {league, game_id, reason?, undo?}  -- postponed / no closing number / withdrawn
//   GET  /api/lines/market?league=wnba&date=YYYY-MM-DD      open/current lines, public %, finals (sportsbookreview, cached in KV)
//   GET  /api/lines/trends?league=wnba&date=YYYY-MM-DD&n=10 last-N ATS and O/U per team against the closing number
//   POST /api/lines/market/backfill?league=wnba&from=&to=   (admin) cache up to 20 past market days per call
//   POST /api/lines/ingest[?hours=48]   (admin) read published previews from Beehiiv and log any card not yet on the ledger
//   GET  /api/lines/ingest/status       last ingest run: posts read, cards logged, cards that did not parse (metadata only)
//
// Ingest (the automated half of logging): an hourly cron lists posts published in the last 48 hours, keeps the ones whose
// web content carries THE CARD blocks, parses each "Lean TEAM number (Tier) · Over/Under number (Tier)" line, places the game
// on a date from the cached sportsbookreview page, and logs it with access free|intel by whether the card appears in the
// free web content. A card already on the ledger (same date, teams) is never overwritten: the printed lean at publish
// time is the one that gets graded. Needs secrets BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID (same values as tome-proxy).
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
    return { ...p, home_nick: hn, away_nick: vn, market, lean: L, card };
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
    override: b.override ?? existing.override ?? false, note: b.note ?? existing.note ?? null, source_post_id: b.source_post_id ?? existing.source_post_id ?? null,
    // slate identity (ET date, abbreviations, SBR nicknames, postseason) lets the ledger list and grade the card from the
    // cached market page when BALLDONTLIE is rate-limited or down; log_picks.py sends these from the projection row
    date: b.date ?? existing.date ?? null, home: b.home ?? existing.home ?? null, away: b.away ?? existing.away ?? null,
    home_nick: b.home_nick ?? existing.home_nick ?? null, away_nick: b.away_nick ?? existing.away_nick ?? null, postseason: b.postseason ?? existing.postseason ?? false,
    void: existing.void ?? false, void_reason: existing.void_reason ?? null, picked_at: existing.picked_at || new Date().toISOString() };
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


// ---------- INGEST (previews -> ledger) ----------
// Abbreviations as the previews print them -> SBR nickname (last word of the full team name, lowercased).
const NICK = {
  nfl: { ARI:"cardinals",ATL:"falcons",BAL:"ravens",BUF:"bills",CAR:"panthers",CHI:"bears",CIN:"bengals",CLE:"browns",DAL:"cowboys",DEN:"broncos",DET:"lions",GB:"packers",HOU:"texans",IND:"colts",JAX:"jaguars",KC:"chiefs",LV:"raiders",LAC:"chargers",LAR:"rams",MIA:"dolphins",MIN:"vikings",NE:"patriots",NO:"saints",NYG:"giants",NYJ:"jets",PHI:"eagles",PIT:"steelers",SF:"49ers",SEA:"seahawks",TB:"buccaneers",TEN:"titans",WAS:"commanders" },
  nba: { ATL:"hawks",BOS:"celtics",BKN:"nets",CHA:"hornets",CHI:"bulls",CLE:"cavaliers",DAL:"mavericks",DEN:"nuggets",DET:"pistons",GSW:"warriors",HOU:"rockets",IND:"pacers",LAC:"clippers",LAL:"lakers",MEM:"grizzlies",MIA:"heat",MIL:"bucks",MIN:"timberwolves",NOP:"pelicans",NYK:"knicks",OKC:"thunder",ORL:"magic",PHI:"76ers",PHX:"suns",POR:"blazers",SAC:"kings",SAS:"spurs",TOR:"raptors",UTA:"jazz",WAS:"wizards" },
  wnba: { ATL:"dream",CHI:"sky",CON:"sun",DAL:"wings",GS:"valkyries",IND:"fever",LV:"aces",LA:"sparks",MIN:"lynx",NY:"liberty",PHX:"mercury",POR:"fire",SEA:"storm",TOR:"tempo",WAS:"mystics" },
};
const ALIAS = {
  nfl: { WSH:"WAS",JAC:"JAX",GNB:"GB",KAN:"KC",LVR:"LV",NOR:"NO",NWE:"NE",SFO:"SF",TAM:"TB",LA:"LAR" },
  nba: { GS:"GSW",NY:"NYK",NO:"NOP",SA:"SAS",PHO:"PHX",UTAH:"UTA",BRK:"BKN",WSH:"WAS",CHO:"CHA",NOR:"NOP" },
  wnba: { GSV:"GS",LVA:"LV",LAS:"LA",NYL:"NY",PHO:"PHX",CONN:"CON",WSH:"WAS" },
};
const TIER_IN = { "toss-up":"COIN FLIP","toss up":"COIN FLIP",tossup:"COIN FLIP","coin flip":"COIN FLIP",lean:"LEAN",strong:"STRONG" };
function normAbbr(league, a) { a = String(a || "").toUpperCase(); return ALIAS[league]?.[a] || a; }
function htmlToText(h) {
  return String(h || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&middot;|&#183;|&#xB7;/gi, "·").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/−/g, "-").replace(/\s+/g, " ");
}
// Which league a preview belongs to: title and tags first (WNBA before NBA, since one contains the other), then the
// abbreviations on its cards.
function leagueOfPost(post, cardsText) {
  const hay = `${post.title || ""} ${post.subtitle || ""} ${(post.content_tags || []).join(" ")}`;
  if (/\bWNBA\b/i.test(hay)) return "wnba";
  if (/\bNFL\b/i.test(hay)) return "nfl";
  if (/\bNBA\b|THE READ/i.test(hay)) return "nba";
  const ab = [...cardsText.matchAll(/THE CARD\s*·\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})/g)].flatMap((m) => [m[1], m[2]]);
  for (const L of ["nfl", "nba", "wnba"]) if (ab.length && ab.every((a) => NICK[L][normAbbr(L, a)])) return L;
  return null;
}
// Every THE CARD block in a blob of web content -> {away, home, team, spread, side_tier, total_side, total, total_tier}.
function parseCards(league, text) {
  const out = [], bad = [];
  const parts = text.split(/(?=THE CARD\s*·)/).filter((x) => /^THE CARD\s*·/.test(x));
  for (const part of parts) {
    const g = part.match(/^THE CARD\s*·\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})/);
    // Side lean with an optional total: "Lean MIA -1.5 (Toss-up)" or "Lean MIA -1.5 (Toss-up) · Under 242.5 (Lean)".
    // The free-text "Lean Miami -1.5 (Toss-up)." sentence in the write-up never matches because it uses the full name.
    const l = part.match(/Lean\s*:?\s*([A-Z]{2,4})\s*([+-]?\d+(?:\.\d+)?|PK)\s*\(([A-Za-z -]+)\)(?:\s*·\s*(Over|Under)\s*[↑↓]?\s*(\d+(?:\.\d+)?)\s*\(([A-Za-z -]+)\))?/i);
    if (!g || !l) { bad.push(part.slice(0, 90)); continue; }
    const away = normAbbr(league, g[1]), home = normAbbr(league, g[2]), team = normAbbr(league, l[1]);
    const st = TIER_IN[l[3].trim().toLowerCase()], tt = l[4] ? TIER_IN[l[6].trim().toLowerCase()] : null;
    if (!NICK[league][away] || !NICK[league][home] || (team !== home && team !== away) || !st || (l[4] && !tt)) { bad.push(part.slice(0, 90)); continue; }
    const spr = l[2].toUpperCase() === "PK" ? 0 : parseFloat(l[2]);
    out.push({ away, home, side: team === home ? "HOME" : "AWAY", spread_home_at_pick: team === home ? spr : -spr, side_tier: st,
      total_side: l[4] ? l[4].toUpperCase() : null, total_at_pick: l[4] ? parseFloat(l[5]) : null, total_tier: tt, lean_text: `${team} ${spr > 0 ? "+" : ""}${spr}` });
  }
  return { cards: out, bad };
}
async function beehiivPosts(env, hours) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const base = `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/posts`;
  // `expand` must be sent as an array (expand[]=a&expand[]=b): a comma list returns no content, a repeated plain key keeps only the last. status=confirmed means published.
  const q = `status=confirmed&platform=all&order_by=publish_date&direction=desc&limit=12&expand[]=free_web_content&expand[]=premium_web_content`;
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(`${base}?${q}`, { headers: { Authorization: `Bearer ${env.BEEHIIV_API_KEY}`, Accept: "application/json" } });
    if (res.status !== 202) break; // 202 = content still rendering; wait Retry-After (capped) and try again
    await new Promise((r) => setTimeout(r, Math.min(8, parseInt(res.headers.get("Retry-After") || "3", 10)) * 1000));
  }
  // A 202 that never settles must surface as an error, not as "no posts": the next hourly pass retries.
  if (res.status === 202) throw new Error("beehiiv 202: content still rendering after 5 tries");
  if (!res.ok) throw new Error(`beehiiv ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const body = await res.json();
  const data = body.data || [];
  const kept = data.filter((p) => (p.publish_date || 0) >= since && (p.platform === "both" || p.platform === "web" || !p.platform));
  // Diagnostics for the status endpoint: what Beehiiv returned before the window filter.
  kept.diag = { status: res.status, returned: data.length, newest: data[0] ? { title: data[0].title, publish_date: data[0].publish_date, platform: data[0].platform, status: data[0].status, has_premium: !!data[0].content?.premium?.web, has_free: !!data[0].content?.free?.web } : null, since, keys: Object.keys(body).slice(0, 8) };
  return kept;
}
// The list call has returned only the premium render in practice; fetch the free render per post when it is missing.
async function beehiivFreeWeb(env, postId) {
  const res = await fetch(`https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/posts/${postId}?expand[]=free_web_content`, { headers: { Authorization: `Bearer ${env.BEEHIIV_API_KEY}`, Accept: "application/json" } });
  if (!res.ok) return "";
  const d = (await res.json()).data || {};
  return d.content?.free?.web || "";
}
// Place a card on a date: the first day from publish day forward (7 max) whose cached market page has that matchup.
// Cached days are checked first; only then are missing days fetched, in order, until every card is placed.
async function placeCards(env, league, pubDate, cards) {
  const days = []; for (let i = 0; i < 7; i++) days.push(new Date(new Date(pubDate + "T00:00:00Z").getTime() + i * 864e5).toISOString().slice(0, 10));
  const pending = new Set(cards.map((_, i) => i));
  const tryDay = (mk, d) => { for (const i of [...pending]) { const c = cards[i]; if (mk?.games?.some((x) => x.home_nick === NICK[league][c.home] && x.away_nick === NICK[league][c.away])) { c.date = d; pending.delete(i); } } };
  for (const d of days) { if (!pending.size) break; tryDay(await env.LINES_KV.get(`market:${league}:${d}`, "json"), d); }
  for (const d of days) { if (!pending.size) break; try { tryDay(await fetchMarket(env, league, d), d); } catch (e) { /* SBR gap: fall through */ } }
  // Unplaced: a daily league plays the day the preview ran; an NFL preview is a Sunday slate unless it says otherwise.
  for (const i of pending) { const c = cards[i]; c.date = league === "nfl" ? days.find((d) => new Date(d + "T00:00:00Z").getUTCDay() === 0) || pubDate : pubDate; c.date_unplaced = true; }
}
async function runIngest(env, hours = 48) {
  const run = { at: new Date().toISOString(), hours, posts: [], logged: 0, already: 0, unparsed: 0, error: null };
  if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID) { run.error = "BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID not set"; await env.LINES_KV.put("ingest:last", JSON.stringify(run)); return run; }
  let posts = [];
  try { posts = await beehiivPosts(env, hours); run.beehiiv = posts.diag || null; } catch (e) { run.error = e.message; await env.LINES_KV.put("ingest:last", JSON.stringify(run)); return run; }
  const existing = {};
  let entry_free_source = "none";
  for (const post of posts) {
    const premium = htmlToText(post.content?.premium?.web || "");
    let free = htmlToText(post.content?.free?.web || "");
    const all = premium.includes("THE CARD") ? premium : free;
    if (!all.includes("THE CARD")) continue;
    // Only previews are a source of leans. Newsletters and recaps quote the cards and would otherwise count as unparsed.
    if (!/preview/i.test(`${post.title || ""} ${(post.content_tags || []).join(" ")}`)) continue;
    if (!free) { try { free = htmlToText(await beehiivFreeWeb(env, post.id)); } catch (e) { free = ""; } }
    entry_free_source = post.content?.free?.web ? "list" : free ? "post" : "none";
    const league = leagueOfPost(post, all);
    const entry = { id: post.id, title: post.title, league, cards: 0, logged: [], already: [], unparsed: [], free_chars: free.length, premium_chars: premium.length, free_cards: 0, free_source: entry_free_source };
    run.posts.push(entry);
    if (!league) { entry.unparsed.push("league not identified"); run.unparsed++; continue; }
    const { cards, bad } = parseCards(league, all);
    const freeKeys = new Set(parseCards(league, free).cards.map((c) => `${c.away}@${c.home}`));
    entry.free_cards = freeKeys.size;
    entry.cards = cards.length; entry.unparsed = bad; run.unparsed += bad.length;
    if (!cards.length) continue;
    existing[league] ||= await loadPicks(env, league);
    await placeCards(env, league, etDate(new Date(post.publish_date * 1000).toISOString()), cards);
    for (const c of cards) {
      const dup = existing[league].find((p) => (p.date === c.date && p.home === c.home && p.away === c.away) || p.game_id === `${c.date}-${c.away}-${c.home}`);
      if (dup) {
        // Never rewrite a lean, but an ingest-sourced card may have been logged before the free render was readable.
        const acc = freeKeys.has(`${c.away}@${c.home}`) ? "free" : "intel";
        if (dup.source === "ingest" && free && dup.access !== acc) { dup.access = acc; await env.LINES_KV.put(`pick:${league}:${dup.game_id}`, JSON.stringify(dup)); entry.already.push(`${c.away}@${c.home} (access -> ${acc})`); }
        else entry.already.push(`${c.away}@${c.home}`);
        run.already++; continue;
      }
      const rec = { league, game_id: `${c.date}-${c.away}-${c.home}`, date: c.date, home: c.home, away: c.away, home_nick: NICK[league][c.home], away_nick: NICK[league][c.away], postseason: false,
        side: c.side, spread_home_at_pick: c.spread_home_at_pick, total_side: c.total_side, total_at_pick: c.total_at_pick, side_tier: c.side_tier, total_tier: c.total_tier,
        access: freeKeys.has(`${c.away}@${c.home}`) ? "free" : "intel", override: false, source_post_id: post.id, source: "ingest", lean_text: c.lean_text,
        note: c.date_unplaced ? "date assumed: matchup not found on the market page at ingest" : null, void: false, void_reason: null, picked_at: new Date().toISOString() };
      await env.LINES_KV.put(`pick:${league}:${rec.game_id}`, JSON.stringify(rec));
      existing[league].push(rec); entry.logged.push(`${c.away}@${c.home} ${c.date}`); run.logged++;
    }
  }
  await env.LINES_KV.put("ingest:last", JSON.stringify(run));
  return run;
}

// ---------- THE RECORD ----------
// One graded ledger feeds the recap block, the Monday social rows and the record page.
// Storage stays one KV record per game (pick:<league>:<game_id>); the ledger is emitted one row
// per market (side, total) so every cut below is a group-by. Nothing derived is stored.
//
// Vocabulary (fixed): cleared / missed / push / void. A push lands exactly on the number and counts
// in neither the numerator nor the denominator of a rate. A void (postponed, no closing number,
// card withdrawn before kickoff) is listed as "no result" and excluded from every count.
// A segment is the reset boundary: <league>-<season>-regular | -playoffs. A chapter is a grouping
// inside a segment: NFL league week, NBA calendar month, nothing for a WNBA playoff run.
const RATE_GATE = 20;   // cards (cleared+missed) before a rate is printed without the "early" flag
const TIER_GATE = 8;    // cards in a tier before that tier row is shown, and only once the segment clears RATE_GATE
const SEGMENT_IDLE_DAYS = 14; // a segment with no graded card in this many days is reported as final

function seasonOf(league, date) { return LEAGUE[league].season(new Date(date + "T00:00:00Z")); }
function segmentOf(league, g) {
  const date = gameDate(g);
  const phase = isPostseason(g) ? "playoffs" : "regular";
  return { segment: `${league}-${seasonOf(league, date)}-${phase}`, phase, season: seasonOf(league, date),
    segment_label: `${league.toUpperCase()} ${phase === "playoffs" ? "playoffs" : "regular season"}` };
}
function chapterOf(league, date) {
  if (league === "nfl") return `Week ${nflWeek(date)}`;
  if (league === "nba") return new Date(date + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return null;
}
function recordStr(t) { return `${t.w}-${t.l}${t.p ? `-${t.p}` : ""}`; }
function rate(t) { const n = t.w + t.l; return n ? +((100 * t.w) / n).toFixed(1) : null; }
// Every published record carries its denominator and an early flag below the gate.
function cut(t) { const n = t.w + t.l; return { record: recordStr(t), cleared: t.w, missed: t.l, push: t.p, cards: t.w + t.l + t.p, rated: n, pct: rate(t), early: n < RATE_GATE }; }
const tally0 = () => ({ w: 0, l: 0, p: 0 });
const add = (t, res) => { if (res === "cleared") t.w++; else if (res === "missed") t.l++; else if (res === "push") t.p++; };

async function loadPicks(env, league) {
  const keys = []; let cursor;
  do { const page = await env.LINES_KV.list({ prefix: `pick:${league}:`, cursor }); keys.push(...page.keys.map((k) => k.name)); cursor = page.list_complete ? undefined : page.cursor; } while (cursor);
  return (await Promise.all(keys.map((k) => env.LINES_KV.get(k, "json")))).filter(Boolean);
}
async function loadFinals(env, league, ids) {
  const cached = (await Promise.all(ids.map((id) => env.LINES_KV.get(`final:${league}:${id}`, "json")))).filter(Boolean);
  const have = new Set(cached.map((g) => String(g.id)));
  // Only numeric ids are BALLDONTLIE game ids. Identity ids ("2026-10-17-ATL-GS", from log_picks / the backfill) grade from
  // the cached market page; sending them here makes BALLDONTLIE ignore the filter and page through the whole schedule.
  const need = ids.filter((id) => !have.has(String(id)) && /^\d+$/.test(String(id)));
  let fresh = [];
  if (need.length) { try { fresh = await bdl(env, league, "games", { ids: need }); } catch (e) { fresh = []; } } // a 429 degrades to "not yet graded", never to an error page
  for (const g of fresh) if (isFinal(g)) await env.LINES_KV.put(`final:${league}:${g.id}`, JSON.stringify(g));
  return Object.fromEntries([...cached, ...fresh].map((g) => [String(g.id), g]));
}
// Identity-id picks (ingest, backfill): find their BALLDONTLIE game by date and team nicknames. The sportsbookreview page
// often never fills in a score, so this is the primary source of finals for those picks; one fetch per league-day, cached
// 10 minutes while games are pending and a week once the day is all final.
async function loadFinalsByDate(env, league, picks) {
  const out = {};
  const need = picks.filter((p) => !/^\d+$/.test(String(p.game_id)) && p.date && p.home_nick && p.away_nick);
  const dates = [...new Set(need.map((p) => p.date))].filter((d) => d <= new Date().toISOString().slice(0, 10));
  for (const d of dates) {
    const key = `bdlday:${league}:${d}`;
    let games = await env.LINES_KV.get(key, "json");
    if (!games) {
      try { games = await bdl(env, league, "games", { dates: [d] }); } catch (e) { continue; }
      const done = games.length > 0 && games.every((g) => isFinal(g));
      await env.LINES_KV.put(key, JSON.stringify(games), { expirationTtl: done ? 7 * 86400 : 600 });
    }
    for (const p of need) {
      if (p.date !== d) continue;
      const g = games.find((x) => nick(x.home_team?.full_name || x.home_team?.name) === p.home_nick && nick(x.visitor_team?.full_name || x.visitor_team?.name) === p.away_nick);
      if (g) out[String(p.game_id)] = g;
    }
  }
  return out;
}

// Grade every logged card for a league. Returns ledger rows, one per market.
async function gradeLeague(env, league) {
  const picks = await loadPicks(env, league);
  const byId = { ...(await loadFinalsByDate(env, league, picks)), ...(await loadFinals(env, league, picks.map((p) => p.game_id))) };
  const rows = [];
  for (const p of picks) {
    let g = byId[String(p.game_id)];
    // No BALLDONTLIE record (rate-limited, or the game is still pending): fall back to the slate identity stored on the
    // pick and the cached sportsbookreview page, which carries the final score once the game is over. A pick with
    // neither can't be placed on a date and is skipped (log_picks.py always stores the identity).
    let m = null;
    const pdate = g ? gameDate(g) : p.date;
    if (!pdate) continue;
    const hn = g ? nick(g.home_team?.full_name || g.home_team?.name) : p.home_nick, vn = g ? nick(g.visitor_team?.full_name || g.visitor_team?.name) : p.away_nick;
    if (p.spread_home_close == null || p.total_close == null || !g) {
      const mk = await env.LINES_KV.get(`market:${league}:${pdate}`, "json");
      m = mk?.games?.find((x) => x.home_nick === hn && x.away_nick === vn) || null;
      if (m) { p.spread_home_close ??= m.spread_home.close; p.total_close ??= m.total.close; }
    }
    if (!g) {
      const fin = m && m.final && m.home_score != null && m.away_score != null;
      g = { id: p.game_id, date: pdate, status: fin ? "Final" : "Scheduled", postseason: !!p.postseason,
        home_team: { abbreviation: p.home || (hn || "").toUpperCase() }, visitor_team: { abbreviation: p.away || (vn || "").toUpperCase() },
        home_team_score: fin ? m.home_score : null, visitor_team_score: fin ? m.away_score : null };
    }
    const date = gameDate(g);
    const seg = segmentOf(league, g);
    const base = { league, ...seg, chapter: chapterOf(league, date), date, game_id: p.game_id, matchup: `${abbr(g.visitor_team)} @ ${abbr(g.home_team)}`,
      access: p.access === "intel" ? "intel" : "free", override: !!p.override, source_post_id: p.source_post_id || null,
      final: isFinal(g) ? `${vScore(g)}-${hScore(g)}` : null, graded: isFinal(g) && !p.void };
    const voidRow = (extra) => ({ ...base, ...extra, result: "void", void_reason: p.void_reason || "no result", margin_vs_number: null, clv_points: null, graded: false });
    if (p.side && p.spread_home_at_pick != null) {
      const pickedHome = p.side === "HOME";
      const lean = `${abbr(pickedHome ? g.home_team : g.visitor_team)} ${sp(pickedHome ? p.spread_home_at_pick : -p.spread_home_at_pick)}`;
      const r = { market: "side", lean, tier: tierWord(p.side_tier), number_at_pick: p.spread_home_at_pick, number_close: p.spread_home_close ?? null, result: null, margin_vs_number: null, clv_points: null };
      if (p.void) rows.push(voidRow(r));
      else {
        if (isFinal(g)) {
          const homeCover = (hScore(g) - vScore(g)) + p.spread_home_at_pick; // >0 home covers
          r.margin_vs_number = +(pickedHome ? homeCover : -homeCover).toFixed(1);
          r.result = homeCover === 0 ? "push" : ((homeCover > 0) === pickedHome ? "cleared" : "missed");
        }
        if (p.spread_home_close != null) r.clv_points = +(pickedHome ? (p.spread_home_at_pick - p.spread_home_close) : (p.spread_home_close - p.spread_home_at_pick)).toFixed(1);
        rows.push({ ...base, ...r });
      }
    }
    if (p.total_side && p.total_at_pick != null) {
      const r = { market: "total", lean: `${p.total_side === "OVER" ? "Over" : "Under"} ${p.total_at_pick}`, tier: tierWord(p.total_tier), number_at_pick: p.total_at_pick, number_close: p.total_close ?? null, result: null, margin_vs_number: null, clv_points: null };
      if (p.void) rows.push(voidRow(r));
      else {
        if (isFinal(g)) {
          const pts = hScore(g) + vScore(g);
          r.margin_vs_number = +((p.total_side === "OVER" ? 1 : -1) * (pts - p.total_at_pick)).toFixed(1);
          r.result = pts === p.total_at_pick ? "push" : (((pts > p.total_at_pick) === (p.total_side === "OVER")) ? "cleared" : "missed");
        }
        if (p.total_close != null) r.clv_points = +(p.total_side === "OVER" ? (p.total_close - p.total_at_pick) : (p.total_at_pick - p.total_close)).toFixed(1);
        rows.push({ ...base, ...r });
      }
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function tierWord(t) { return ({ STRONG: "strong", LEAN: "lean", "COIN FLIP": "tossup", TOSSUP: "tossup", "TOSS-UP": "tossup" })[String(t || "").toUpperCase()] || null; }
function sp(x) { return x == null ? "" : x === 0 ? "PK" : (x > 0 ? `+${x}` : `${x}`); }

// Aggregate a set of graded rows into the published cuts.
function summarize(rows) {
  const out = { side: tally0(), total: tally0(), void: 0, clv: { side: [], total: [] }, by_tier: {}, by_access: { free: { side: tally0(), total: tally0() }, intel: { side: tally0(), total: tally0() } } };
  for (const r of rows) {
    if (r.result === "void") { out.void++; continue; }
    if (!r.result) continue;
    add(out[r.market], r.result); add(out.by_access[r.access][r.market], r.result);
    if (r.tier) { out.by_tier[r.tier] ||= { side: tally0(), total: tally0() }; add(out.by_tier[r.tier][r.market], r.result); }
    if (r.clv_points != null) out.clv[r.market].push(r.clv_points);
  }
  const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);
  const gateOpen = (out.side.w + out.side.l) >= RATE_GATE || (out.total.w + out.total.l) >= RATE_GATE;
  return {
    side: cut(out.side), total: cut(out.total), void: out.void, cards: out.side.w + out.side.l + out.side.p + out.total.w + out.total.l + out.total.p,
    closing_line_value: { side_avg_points: mean(out.clv.side), side_n: out.clv.side.length, total_avg_points: mean(out.clv.total), total_n: out.clv.total.length },
    // Tier rows are published only once the segment clears the rate gate and the tier itself has TIER_GATE cards in that market.
    by_tier: Object.fromEntries(["strong", "lean", "tossup"].filter((t) => out.by_tier[t]).map((t) => [t, {
      side: { ...cut(out.by_tier[t].side), shown: gateOpen && (out.by_tier[t].side.w + out.by_tier[t].side.l) >= TIER_GATE },
      total: { ...cut(out.by_tier[t].total), shown: gateOpen && (out.by_tier[t].total.w + out.by_tier[t].total.l) >= TIER_GATE } }])),
    tiers_shown: gateOpen,
    by_access: { free: { side: cut(out.by_access.free.side), total: cut(out.by_access.free.total) }, intel: { side: cut(out.by_access.intel.side), total: cut(out.by_access.intel.total) } },
  };
}

// GET /api/lines/record?league=wnba[&from=][&to=]  -- the full graded ledger plus the cuts over that window (back-compatible shape kept under `record`).
async function handleRecord(url, env) {
  const league = (url.searchParams.get("league") || "").toLowerCase();
  if (!LEAGUE[league]) return json({ error: "league must be wnba, nba, or nfl" }, 400);
  const from = url.searchParams.get("from") || "2000-01-01", to = url.searchParams.get("to") || "2999-12-31";
  const rows = (await gradeLeague(env, league)).filter((r) => r.date >= from && r.date <= to);
  const s = summarize(rows);
  return json({ league, from, to, record: { side: s.side.record, side_pct: s.side.pct, total: s.total.record, total_pct: s.total.pct }, ...s, picks: rows });
}

// GET /api/lines/record/summary?asof=YYYY-MM-DD[&league=nfl][&slate=YYYY-MM-DD]
// Every published cut in one call: per league, per segment -> season-to-date, the slate (the 7 days
// through asof, or one day when slate= is given), chapters, tiers, access split, CLV, voids.
// `asof` defaults to today (ET). Rows dated after asof are ignored so a Monday post "through Sunday"
// and a recap for a given day both reproduce exactly later.
async function handleRecordSummary(url, env) {
  const asof = url.searchParams.get("asof") || etDate(new Date().toISOString());
  const slateDay = url.searchParams.get("slate");
  const slateFrom = slateDay || new Date(new Date(asof + "T00:00:00Z").getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const slateTo = slateDay || asof;
  const leagues = url.searchParams.get("league") ? [url.searchParams.get("league").toLowerCase()] : Object.keys(LEAGUE);
  const out = { asof, slate: { from: slateFrom, to: slateTo, label: slateDay ? slateDay : `7 days through ${asof}` }, gates: { rate_cards: RATE_GATE, tier_cards: TIER_GATE }, leagues: {} };
  for (const league of leagues) {
    if (!LEAGUE[league]) continue;
    const all = (await gradeLeague(env, league)).filter((r) => r.date <= asof);
    const segments = {};
    for (const r of all) (segments[r.segment] ||= { segment: r.segment, label: r.segment_label, season: r.season, phase: r.phase, rows: [] }).rows.push(r);
    const segOut = [];
    for (const seg of Object.values(segments).sort((a, b) => (a.rows[0].date < b.rows[0].date ? 1 : -1))) {
      const graded = seg.rows.filter((r) => r.result);
      const lastDate = graded.length ? graded.map((r) => r.date).sort().slice(-1)[0] : null;
      const idleDays = lastDate ? Math.round((new Date(asof + "T00:00:00Z") - new Date(lastDate + "T00:00:00Z")) / 864e5) : null;
      const chapters = {};
      for (const r of seg.rows) if (r.chapter) (chapters[r.chapter] ||= []).push(r);
      segOut.push({
        ...seg, rows: undefined,
        status: idleDays != null && idleDays > SEGMENT_IDLE_DAYS ? "final" : "active",
        through: lastDate, chapter_now: chapterOf(league, asof),
        season_to_date: summarize(seg.rows),
        slate: { ...summarize(seg.rows.filter((r) => r.date >= slateFrom && r.date <= slateTo)), from: slateFrom, to: slateTo,
          cards: seg.rows.filter((r) => r.date >= slateFrom && r.date <= slateTo && r.result) },
        chapters: Object.entries(chapters).map(([name, rs]) => ({ chapter: name, ...summarize(rs) })),
        pending: seg.rows.filter((r) => !r.result).length,
        ledger: seg.rows,
      });
    }
    out.leagues[league] = { segments: segOut };
  }
  return json(out);
}

// POST /api/lines/pick/delete (admin) body: {league, game_id}  -- remove a logged card entirely (duplicates, test entries).
async function handleDeletePick(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !LEAGUE[b.league] || !b.game_id) return json({ error: "league and game_id required" }, 400);
  const key = `pick:${b.league}:${b.game_id}`;
  const existed = !!(await env.LINES_KV.get(key));
  await env.LINES_KV.delete(key);
  return json({ ok: true, deleted: existed, key });
}

// POST /api/lines/void (admin) body: {league, game_id, reason}  -- postponed, no closing number, withdrawn before kickoff.
async function handleVoid(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !LEAGUE[b.league] || !b.game_id) return json({ error: "league and game_id required" }, 400);
  const key = `pick:${b.league}:${b.game_id}`;
  const rec = JSON.parse((await env.LINES_KV.get(key)) || "null");
  if (!rec) return json({ error: "no pick logged for that game" }, 404);
  rec.void = b.undo ? false : true; rec.void_reason = b.undo ? null : (b.reason || "no result"); rec.voided_at = new Date().toISOString();
  await env.LINES_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, pick: rec });
}

export default {
  // Nightly: cache yesterday's and today's market pages for every league so closes and trends fill themselves.
  async scheduled(event, env) {
    if (event.cron === "10 6 * * *") {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      for (const league of Object.keys(SBR)) for (const d of [yesterday, today]) { try { await fetchMarket(env, league, d); } catch (e) { /* SBR hiccup; the next run catches up */ } }
    }
    // Every cron, including the nightly one: pick up previews published since the last pass.
    try { await runIngest(env, 48); } catch (e) { await env.LINES_KV.put("ingest:last", JSON.stringify({ at: new Date().toISOString(), error: e.message })); }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({});
    try {
      if (url.pathname === "/health") {
        const ing = await env.LINES_KV.get("ingest:last", "json");
        const problems = [];
        if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID) problems.push("ingest: Beehiiv secrets not set");
        else if (!ing) problems.push("ingest: never ran");
        else { if (ing.error) problems.push(`ingest: ${ing.error}`); if (ing.unparsed) problems.push(`ingest: ${ing.unparsed} card(s) did not parse`); if (Date.now() - new Date(ing.at).getTime() > 3 * 36e5) problems.push("ingest: last run more than 3h ago"); }
        return json({ ok: !problems.length, leagues: Object.keys(LEAGUE), configured: !!env.BALLDONTLIE_API_KEY, ingest: ing ? { at: ing.at, posts: ing.posts?.length || 0, logged: ing.logged, unparsed: ing.unparsed, error: ing.error } : null, problems });
      }
      if (url.pathname === "/api/lines/ingest/status") return json((await env.LINES_KV.get("ingest:last", "json")) || { never: true });
      if (url.pathname === "/api/lines/ingest" && request.method === "POST") return isAdmin(request, env) ? json(await runIngest(env, parseInt(url.searchParams.get("hours") || "48", 10))) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/ratings") return await handleRatings(url, env);
      if (url.pathname === "/api/lines/projection") return await handleProjection(url, env);
      if (url.pathname === "/api/lines/record") return await handleRecord(url, env);
      if (url.pathname === "/api/lines/record/summary") return await handleRecordSummary(url, env);
      if (url.pathname === "/api/lines/market") return await handleMarket(url, env);
      if (url.pathname === "/api/lines/trends") return await handleTrends(url, env);
      if (url.pathname === "/api/lines/market/backfill" && request.method === "POST") return isAdmin(request, env) ? await handleBackfill(url, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/pick" && request.method === "POST") return isAdmin(request, env) ? await handlePick(request, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/close" && request.method === "POST") return isAdmin(request, env) ? await handleClose(request, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/pick/delete" && request.method === "POST") return isAdmin(request, env) ? await handleDeletePick(request, env) : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/lines/void" && request.method === "POST") return isAdmin(request, env) ? await handleVoid(request, env) : json({ error: "unauthorized" }, 401);
      return new Response("tome-lines", { status: 200 });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};

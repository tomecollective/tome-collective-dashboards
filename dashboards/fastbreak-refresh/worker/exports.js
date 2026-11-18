// Fast Break table exports, built by the Worker from its own data.
//
// These are the same tables the dashboard's "Download CSV" buttons make in the
// browser (dashboards/fastbreak/index.html), so they no longer have to be
// downloaded by hand:
//   - Classic / Pro day table  -> downloadCSV()          (default sort: Ovr Rank)
//   - Historic "Today's slate" -> hxDownloadCSV() slate   (no collector discount)
//   - Historic "Players"       -> hxDownloadCSV() players (no collector discount)
//   - Historic optimal lineup  -> hxOptimize()            (no collector discount)
//
// Everything here is pure (no KV, no fetch) so it can be tested in Node. The
// math mirrors the page line for line; if you change one, change the other
// (_exports_test.mjs checks the shared numbers).

// -- Shared ---------------------------------------------------------------------
export function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

export function toCSV(headers, rows) {
  return [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}

// Markdown table for the article-drafting chat (plain text, easy to read back).
export function toMarkdownTable(headers, rows) {
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

// -- Classic / Pro day table ---------------------------------------------------------
const isOut = (p) => p.availability === "out" || String(p.injuryStatus || "").toLowerCase() === "out";

// Same columns, order and filter as the page's downloadCSV() at its default
// sort (Ovr Rank ascending, OUT players last). On a Pro night with a verified
// set list, players with no Moment in tonight's sets are left out, as on the page.
export function dayTable(dashboard) {
  const objCols = (dashboard.objectives || []).map((o) => ({ stat: o.stat, label: o.label || o.stat }));
  const headers = ["Player", "Team", "Opp", "Ovr Rank"];
  objCols.forEach((oc) => headers.push(`${oc.label} Proj`, `${oc.label} YTD`, `${oc.label} L10`));
  const proVerified = dashboard.mode === "Pro" && dashboard.proEligibility === "verified";
  let players = [...(dashboard.players || [])];
  if (proVerified) players = players.filter((p) => p.proEligible !== false);
  players.sort((a, b) => {
    const ao = isOut(a), bo = isOut(b);
    if (ao !== bo) return ao ? 1 : -1;
    const av = a.ovrRank, bv = b.ovrRank;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv));
  });
  const rows = players.map((p) => {
    const row = [p.name, p.team, p.opp || "", isOut(p) ? "OUT" : (p.ovrRank ?? "")];
    objCols.forEach((oc) => {
      const ov = (p.objectives || {})[oc.stat] || {};
      row.push(ov.proj ?? (ov.projSource === "tbd" ? "TBD" : ""), ov.ytd ?? "", ov.l10 ?? "");
    });
    return row;
  });
  return { headers, rows };
}

// -- Historic (no collector discount) ------------------------------------------------
export const HISTORIC_DEFAULT_BUDGET = 350;
export const HISTORIC_DEFAULT_LINEUP = 5;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function pctile(a, q) {
  const s = [...a].sort((x, y) => x - y), k = (s.length - 1) * q, f = Math.floor(k);
  return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f);
}
const f1 = (x) => (x == null ? "" : x.toFixed(1));

// hxPrepare() from the page, on a copy (never mutates the stored dataset).
export function prepareHistoric(dataset) {
  const D = JSON.parse(JSON.stringify(dataset));
  const k = D.kPrior ?? 4, hl = D.halfLife ?? 5, res = [];
  D.players.forEach((p) => { p.n_games = p.g.length; p.g.forEach((x) => res.push(x - p.avg)); });
  D.shift = res.length ? res.reduce((a, b) => a + b, 0) / res.length : 0;
  D.players.forEach((p) => {
    p.mean = p.n_games ? mean(p.g) : null;
    p.l10 = p.n_games ? mean(p.g.slice(-10)) : null;
    p.floor = p.n_games >= 5 ? pctile(p.g, 0.2) : null;
    p.ceil = p.n_games >= 5 ? pctile(p.g, 0.8) : null;
    p.lo = p.n_games ? Math.min(...p.g) : null;
    p.hi = p.n_games ? Math.max(...p.g) : null;
    const a = p.avg + D.shift;
    let wSum = 0, wg = 0;
    p.g.forEach((x, i) => { const w = hl ? Math.pow(0.5, (p.n_games - 1 - i) / hl) : 1; wSum += w; wg += w * x; });
    p.blend = p.n_games ? (k * a + wg) / (k + wSum) : a;
  });
  D.budget = typeof D.budget === "number" ? D.budget : HISTORIC_DEFAULT_BUDGET;
  D.lineup = typeof D.lineup === "number" ? D.lineup : HISTORIC_DEFAULT_LINEUP;
  return D;
}

// Page's day picker: today's slate (ET) or the next one; last slate once the run is over.
export function defaultSlateIndex(slates, todayET) {
  if (!slates.length) return -1;
  if (!slates.every((s) => s.date)) return slates.length - 1;
  const up = slates.map((s, i) => i).filter((i) => slates[i].date >= todayET);
  return up.length ? up[0] : slates.length - 1;
}

// With no discount, Your RP = base RP (Math.ceil((rp*100 - 50)/100) === rp for whole RP).
const rpOf = (p) => Math.ceil((p.rp * 100 - 50) / 100);
const ppr = (p) => { const rp = rpOf(p); return rp > 0 && p.blend != null ? p.blend / rp : null; };
const rangeCells = (p) => [p.floor, p.ceil, p.lo, p.hi].map(f1);

// hxBest(): exact DP, exactly `lineup` players, total RP <= budget, by blend.
export function bestLineup(pool, budget, size, ban) {
  const it = pool.filter((p) => !ban || !ban.has(p.n)), n = it.length;
  const C = budget, S = size, NEG = -1e9, W = C + 1;
  const dp = new Float64Array((n + 1) * (S + 1) * W).fill(NEG);
  const ix = (i, k, c) => (i * (S + 1) + k) * W + c;
  for (let c = 0; c <= C; c++) dp[ix(0, 0, c)] = 0;
  for (let i = 1; i <= n; i++) {
    const w = rpOf(it[i - 1]), v = it[i - 1].blend;
    for (let k = 0; k <= S; k++) for (let c = 0; c <= C; c++) {
      let b = dp[ix(i - 1, k, c)];
      if (k > 0 && c >= w) { const t = dp[ix(i - 1, k - 1, c - w)]; if (t > NEG / 2 && t + v > b) b = t + v; }
      dp[ix(i, k, c)] = b;
    }
  }
  if (dp[ix(n, S, C)] < NEG / 2) return null;
  let k = S, c = C; const out = [];
  for (let i = n; i >= 1; i--) {
    const w = rpOf(it[i - 1]);
    if (dp[ix(i, k, c)] !== dp[ix(i - 1, k, c)]) { out.push(it[i - 1]); k--; c -= w; }
  }
  return out.reverse();
}

const sum = (l, f) => l.reduce((a, p) => a + f(p), 0);

// hxOptimize() with no discounts and nobody skipped: best lineup + up to 2 alternates.
export function optimizeSlate(D, slatePlayers) {
  const best = bestLineup(slatePlayers, D.budget, D.lineup);
  if (!best) return { best: [], alts: [] };
  const seen = new Set([best.map((p) => p.n).sort().join("|")]), alts = [];
  best.forEach((p) => {
    const l = bestLineup(slatePlayers, D.budget, D.lineup, new Set([p.n]));
    if (l) { const id = l.map((x) => x.n).sort().join("|"); if (!seen.has(id)) { seen.add(id); alts.push(l); } }
  });
  alts.sort((a, b) => sum(b, (p) => p.blend) - sum(a, (p) => p.blend));
  return { best, alts: alts.slice(0, 2) };
}

const lineupOut = (l, budget) => {
  const sorted = [...l].sort((a, b) => b.blend - a.blend);
  return {
    projected: Number(f1(sum(sorted, (p) => p.blend))),
    rpUsed: sum(sorted, rpOf),
    rpLeft: budget - sum(sorted, rpOf),
    players: sorted.map((p) => ({ name: p.n, team: p.t, rp: rpOf(p), blend: Number(f1(p.blend)) })),
  };
};

// Every Historic table for one slate, at no collector discount.
// opts.todayET picks the default slate; opts.slateIndex / opts.date override it.
export function historicExport(dataset, { todayET, slateIndex, date } = {}) {
  const D = prepareHistoric(dataset);
  const byName = Object.fromEntries(D.players.map((p) => [p.n, p]));
  let idx = defaultSlateIndex(D.slates, todayET);
  if (date) {
    const i = D.slates.findIndex((s) => s.date === date);
    if (i < 0) throw new Error(`No Historic slate dated ${date}.`);
    idx = i;
  } else if (slateIndex != null) {
    if (!(slateIndex >= 0 && slateIndex < D.slates.length)) throw new Error(`slate must be 0-${D.slates.length - 1}.`);
    idx = slateIndex;
  }
  const slate = idx >= 0 ? D.slates[idx] : null;
  const slatePlayers = slate ? slate.players.map((n) => byName[n]).filter(Boolean) : [];

  // Today's slate table: page default sort (projection, high to low).
  const slateList = [...slatePlayers].sort((a, b) => (a.blend > b.blend ? -1 : a.blend < b.blend ? 1 : 0));
  const slateTable = {
    headers: ["Player", "Team", "Base RP", "Your RP", "Discount %", "AVG", "Blend", "Pts/RP", "Obs. avg", "Last 10", "Floor", "Ceiling", "Low", "High", "Skipped"],
    rows: slateList.map((p) => [p.n, p.t, p.rp, rpOf(p), 0, p.avg ?? "", f1(p.blend), ppr(p) == null ? "" : ppr(p).toFixed(3), f1(p.mean), f1(p.l10), ...rangeCells(p), ""]),
  };
  // Players table: page default sort (site AVG, high to low).
  const playerList = [...D.players].sort((a, b) => {
    const A = a.avg ?? -1, B = b.avg ?? -1;
    return A > B ? -1 : A < B ? 1 : 0;
  });
  const playersTable = {
    headers: ["Player", "Team", "Base RP", "Your RP", "Discount %", "AVG", "Blend", "Pts/RP", "Last 10", "Floor", "Ceiling", "Low", "High"],
    rows: playerList.map((p) => [p.n, p.t, p.rp, rpOf(p), 0, p.avg ?? "", f1(p.blend), ppr(p) == null ? "" : ppr(p).toFixed(3), f1(p.l10), ...rangeCells(p)]),
  };
  const result = slate ? optimizeSlate(D, slatePlayers) : { best: [], alts: [] };
  return {
    updated: D.updated || null,
    scoring: D.scoring || null,
    budget: D.budget,
    lineupSize: D.lineup,
    slateIndex: idx,
    slate: slate ? { label: slate.label || null, date: slate.date || null, teams: slate.teams } : null,
    slates: D.slates.map((s, i) => ({ index: i, label: s.label || null, date: s.date || null })),
    lineup: result.best.length ? lineupOut(result.best, D.budget) : null,
    alternates: result.alts.map((l) => lineupOut(l, D.budget)),
    slateTable,
    playersTable,
  };
}

// Plain-text summary of every table, for pasting into (or fetching from) the
// article-drafting chat. Informational only: projections and prices, nothing more.
export function exportMarkdown({ generatedAt, league, date, classic, pro, historic }) {
  const out = [`# Fast Break data, ${league} ${date}`, `Generated ${generatedAt}. Projections and prices only.`];
  const day = (title, d) => {
    if (!d) return;
    out.push("", `## ${title}`);
    if (d.status) out.push(d.status);
    if (d.objectives?.length) out.push(`Objectives: ${d.objectives.map((o) => o.label || o.stat).join(", ")}${d.badgeSetName ? ` · Badge/Set: ${d.badgeSetName}` : ""}`);
    if (d.table.rows.length) out.push("", toMarkdownTable(d.table.headers, d.table.rows));
  };
  day("Classic", classic);
  day("Pro", pro);
  if (historic) {
    const h = historic;
    out.push("", `## Historic (no collector discount)`);
    if (h.error) out.push(h.error);
    else {
      out.push(`Slate: ${h.slate ? `${h.slate.label || ""}${h.slate.date ? ` (${h.slate.date})` : ""} · ${h.slate.teams.join(", ")}` : "none"} · Budget ${h.budget} RP · ${h.lineupSize} players · Data updated ${h.updated || "unknown"}`);
      if (h.lineup) {
        out.push("", `### Top projected lineup (${h.lineup.projected} projected, ${h.lineup.rpUsed}/${h.budget} RP)`);
        out.push(toMarkdownTable(["Player", "Team", "RP", "Blend"], h.lineup.players.map((p) => [p.name, p.team, p.rp, p.blend])));
        h.alternates.forEach((a, i) => out.push("", `Alternate ${i + 1} (${a.projected}, ${a.rpUsed} RP): ${a.players.map((p) => `${p.name} (${p.rp})`).join(", ")}`));
      }
      out.push("", "### Today's slate", toMarkdownTable(h.slateTable.headers, h.slateTable.rows));
    }
  }
  return out.join("\n") + "\n";
}

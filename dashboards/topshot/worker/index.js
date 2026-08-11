import topshotData from "../data/topshot-seed.json";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/topshot") {
      // TODAY: serving seed data, filtering happens client-side (small dataset).
      // NEXT SESSION: replace topshotData with live Cadence script results against
      // the TopShot smart contract (population, burned, circulating supply) plus
      // on-chain transaction history (last sale, avg sale, sale count). See the
      // build roadmap's "Top Shot Moment Intelligence" section for the scoped
      // approach — this Worker's response shape stays the same either way, so
      // the frontend doesn't need to change when the real data lands.
      return new Response(JSON.stringify(topshotData), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

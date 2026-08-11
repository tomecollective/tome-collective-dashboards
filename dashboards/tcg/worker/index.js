import chaseIndexData from "../data/chase-50-modern-seed.json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/chase-index") {
      // TONIGHT: serving bundled seed data. Two cards (Gardevoir ex, Magikarp)
      // have mock daily history for testing the timeframe toggle end to end.
      //
      // NEXT STEP — real JustTCG integration:
      // JustTCG retains historical NM price data server-side on paid plans, so
      // there's no need to build a separate long-term store here. Replace the
      // static import above with a live per-card fetch:
      //
      //   const res = await fetch(
      //     `https://api.justtcg.com/v1/cards/${cardId}?include_price_history=true` +
      //     `&priceHistoryDuration=1y&include_statistics=true`,
      //     { headers: { "Authorization": `Bearer ${env.JUSTTCG_API_KEY}` } }
      //   );
      //
      // Fetch the widest range once (1y) rather than re-querying per timeframe
      // button — the frontend already slices the full history client-side, so
      // one fetch per card covers every toggle option (7D/30D/90D/180D/1Y).
      //
      // API key setup: `wrangler secret put JUSTTCG_API_KEY` (never hardcode
      // it in this file). Consider a short KV cache layer (e.g. 1 hour) around
      // the JustTCG calls to avoid re-fetching on every page view, given
      // history doesn't change that fast.
      return new Response(JSON.stringify(chaseIndexData), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

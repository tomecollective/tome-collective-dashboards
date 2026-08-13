const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      const cached = await env.FASTBREAK_KV.get("fastbreak:latest");
      if (!cached) {
        return new Response(
          JSON.stringify({
            error: "No cached data yet. The tome-fastbreak-refresh Worker populates this KV store on a cron schedule -- wait for its first run, or trigger it manually to test.",
          }),
          { status: 503, headers: corsHeaders }
        );
      }
      return new Response(cached, { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

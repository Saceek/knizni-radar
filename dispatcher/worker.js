/**
 * Sáčkův radar – spolehlivý spouštěč denního refreshe dat
 * ---------------------------------------------------------
 * GitHub Actions "schedule" trigger je na veřejných repozitářích jen "best effort" –
 * i po přesunu mimo celou hodinu se běh v praxi opozdil o 4+ hodiny (viz commit historie
 * ".github/workflows/refresh.yml"). Cloudflare Cron Triggery naopak spouští Workery
 * na sekundu přesně, takže místo spoléhání na GitHub interní scheduler ho odsud
 * v daný čas ručně "nakopneme" přes workflow_dispatch REST API.
 *
 * Vyžaduje GitHub Personal Access Token (fine-grained, scope: Actions: read and write
 * na repozitáři Saceek/knizni-radar) uložený jako Cloudflare secret GITHUB_TOKEN:
 *   wrangler secret put GITHUB_TOKEN
 */

const OWNER = "Saceek";
const REPO = "knizni-radar";
const WORKFLOW_FILE = "refresh.yml";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchRefresh(env));
  },
  async fetch(request, env) {
    // Ruční test: GET s ?token=<CRON_SECRET> spustí dispatch mimo plán.
    const url = new URL(request.url);
    if (url.searchParams.get("token") !== env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const res = await dispatchRefresh(env);
    return new Response(res, { status: 200 });
  },
};

async function dispatchRefresh(env) {
  const resp = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "knizni-radar-dispatcher",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  const text = `dispatch → ${resp.status} ${resp.statusText}`;
  console.log(text);
  return text;
}

/**
 * Sáčkův radar – vlastní CORS proxy jako Cloudflare Pages Function
 * -------------------------------------------------------------------
 * Nahrazuje veřejné corsproxy.io (nespolehlivé, občasné rate-limity/403)
 * vlastním serverless endpointem přímo na naší doméně.
 *
 *   GET /api/proxy?url=<encodeURIComponent(cílová URL)>
 *
 * Cílová URL smí mířit jen na povolené domény (Steam, databazeknih.cz),
 * aby tato funkce nešla zneužít jako otevřená proxy pro cokoliv jiného.
 */

const ALLOWED_HOSTS = new Set([
  "store.steampowered.com",
  "www.databazeknih.cz",
]);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Chybí parametr url", { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return new Response("Neplatná url", { status: 400 });
  }

  if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
    return new Response("Doména není povolena", { status: 403 });
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: { "User-Agent": UA, "Accept-Language": "cs" },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response("Proxy fetch selhal: " + e.message, { status: 502 });
  }
}

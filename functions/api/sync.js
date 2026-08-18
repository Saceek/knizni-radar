/**
 * Sáčkův radar – server-side sync (GitHub Contents API zápis)
 * -------------------------------------------------------------------
 * Nahrazuje ruční zadávání GitHub tokenu v appce na každém zařízení -
 * appka teď jen POSTuje data sem, token zůstává jen tady jako
 * Cloudflare Pages environment secret (GITHUB_SYNC_TOKEN), appka ho
 * nikdy nevidí.
 *
 *   POST /api/sync   body: { file: "diary.json" | "backlog.json" | "progress.json", data: <cokoliv serializovatelného> }
 *
 * Jde o osobní jednouživatelskou appku - endpoint proto nemá vlastní
 * autentizaci uživatele (kdokoliv se stránkou může zapisovat), ale
 * cílový soubor je omezen na povolený seznam, aby to nešlo zneužít
 * jako obecný zápis do repozitáře.
 */

const ALLOWED_FILES = new Set(["diary.json", "backlog.json", "progress.json"]);
const REPO_OWNER = "Saceek";
const REPO_NAME = "knizni-radar";

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = env.GITHUB_SYNC_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: "Server není nastaven (chybí GITHUB_SYNC_TOKEN)" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Neplatný JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { file, data } = body || {};
  if (!ALLOWED_FILES.has(file)) {
    return new Response(JSON.stringify({ error: "Soubor není povolen" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  try {
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${file}`;
    const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "knizni-radar-sync" };

    const getR = await fetch(`${apiUrl}?t=${Date.now()}`, { headers: ghHeaders });
    let sha = null;
    if (getR.ok) {
      sha = (await getR.json()).sha;
    } else if (getR.status !== 404) {
      return new Response(JSON.stringify({ error: `Čtení SHA selhalo: ${getR.status}` }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const jsonStr = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(jsonStr);
    let binStr = "";
    for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
    const content = btoa(binStr);

    const putBody = { message: `${file}: sync`, content, branch: "main" };
    if (sha) putBody.sha = sha;

    const putR = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });
    if (!putR.ok) {
      const err = await putR.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: `Zápis selhal: ${putR.status} - ${err.message || "neznámá chyba"}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Chyba: " + e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

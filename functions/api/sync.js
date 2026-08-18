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

  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${file}`;
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "knizni-radar-sync" };

  const jsonStr = JSON.stringify(data, null, 2);
  const bytes = new TextEncoder().encode(jsonStr);
  let binStr = "";
  for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
  const content = btoa(binStr);

  // Optimistic-concurrency race (409 "sha ... but expected ...") je tu čekaná věc - dvě
  // zařízení nebo souběžný GitHub Actions refresh můžou sáhnout na soubor skoro současně.
  // Pár pokusů s čerstvým SHA místo toho, aby to appka hlásila jako chybu uživateli.
  const MAX_ATTEMPTS = 4;
  let lastErr = "neznámá chyba";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const getR = await fetch(`${apiUrl}?t=${Date.now()}`, { headers: ghHeaders });
      let sha = null;
      if (getR.ok) {
        sha = (await getR.json()).sha;
      } else if (getR.status !== 404) {
        lastErr = `Čtení SHA selhalo: ${getR.status}`;
        continue;
      }

      const putBody = { message: `${file}: sync`, content, branch: "main" };
      if (sha) putBody.sha = sha;

      const putR = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      });
      if (putR.ok) {
        return new Response(JSON.stringify({ ok: true, attempts: attempt }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const err = await putR.json().catch(() => ({}));
      lastErr = `${putR.status} - ${err.message || "neznámá chyba"}`;
      if (putR.status !== 409) break; // jiná chyba než konflikt SHA - retry nepomůže
      await new Promise((r) => setTimeout(r, 300 * attempt)); // krátká prodleva před dalším pokusem
    } catch (e) {
      lastErr = e.message;
    }
  }

  return new Response(JSON.stringify({ error: `Zápis selhal: ${lastErr}` }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

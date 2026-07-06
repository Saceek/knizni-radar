# Refresh dispatcher

Spolehlivé spouštění `.github/workflows/refresh.yml`, protože GitHub Actions `schedule`
trigger se u tohoto repa opakovaně opožďoval o 4+ hodiny bez ohledu na nastavený čas.

Cloudflare Worker s Cron Triggerem zavolá GitHub REST API (`workflow_dispatch`) přesně
v daný čas, takže samotný build proběhne hned (žádná fronta na straně GitHubu).

## Nasazení (jednorázově)

1. `npm i -g wrangler` (pokud ještě nemáš)
2. `cd dispatcher`
3. `wrangler login`
4. Vytvoř GitHub token: https://github.com/settings/tokens (fine-grained, repo `Saceek/knizni-radar`,
   permission **Actions: Read and write**)
5. `wrangler secret put GITHUB_TOKEN` → vlož token
6. `wrangler secret put CRON_SECRET` → vlož libovolný náhodný řetězec (pro ruční test přes URL)
7. `wrangler deploy`

Po nasazení Worker běží automaticky podle `[triggers] crons` ve `wrangler.toml`
(denně 3:13 a 9:13 UTC – dvě vlny pro jistotu, kdyby první běh GitHubu z libovolného
důvodu selhal/timeoutnul).

## Ruční test

```
curl "https://knizni-radar-refresh-dispatcher.<tvůj-subdomain>.workers.dev/?token=<CRON_SECRET>"
```

Mělo by vrátit `dispatch → 204 No Content` a založit nový běh na
https://github.com/Saceek/knizni-radar/actions.

## Ponechat GitHub Actions `schedule` trigger?

Ano, klidně zůstává ve `refresh.yml` jako záloha – nevadí, když se spustí i "sám od sebe"
o pár hodin později, workflow jen znovu commitne stejná/aktuálnější data (`skip ci`).

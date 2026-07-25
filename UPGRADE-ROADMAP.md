# Upgrade Roadmap — nookeb

Companion to `SECURITY-UPGRADE-PLAN.md`. That document catalogues the 20 remaining
npm-audit vulnerabilities; this one is the **execution plan** for closing them,
plus the detailed Fastify 4→5 and Next 14→16 migration checklists.

**Audit baseline (unchanged by this pass):** 20 vulnerabilities — 1 moderate, 19 high, 0 critical.
Every remaining item requires a breaking major upgrade (see per-group notes).

**What this security pass changed:** nothing in the dependency tree (all fixes require
majors). The pass added the Phase-B integration test suite
(`apps/api/src/__tests__/security.integration.test.ts`) and this roadmap. See
"exceljs / uuid — attempted and deferred" below for the one non-breaking fix that was
evaluated and rejected.

---

## Priority order (cheapest security gain first)

| # | Package(s) | Current → Target | Risk | Est | Fixes |
|---|---|---|---|---|---|
| 1 | `googleapis` chain (`gaxios`/`rimraf`/`glob`/`minimatch`/`brace-expansion`) | `^173.0.0` → latest (+ maybe `overrides`) | **MED** | 2–4 h | ~6 high (ReDoS/OOM) — gated, dormant feature |
| 2 | `exceljs` chain (`archiver`/`glob`/`uuid`) | overrides or wait for upstream | **LOW** | 1–3 h | 1 moderate + ~5 high — server-side, authenticated only |
| 3 | **Fastify 4 → 5** (`fastify` + 5 `@fastify/*` plugins) | `^4.28` → `^5.10` | **MED** (was rated HIGH; the code touch-points are small — see below) | 4–8 h | ~6 high (`fast-uri` path-traversal/host-confusion, `find-my-way` HTTP/2 DoS) |
| 4 | **Next.js 14 → 16** (`next` + `postcss`, needs React 19) | `^14.2` → `16.x` | **HIGH** | 12–20 h | 21 advisories incl. rewrite-SSRF, request-smuggling, cache-poisoning, `postcss` file-read |

Groups 1 and 2 are isolated dependency bumps and ship independently. Groups 3 and 4 are
framework majors in separate workspaces (`apps/api` vs `apps/web`) and can proceed in
parallel by different owners once 1–2 are out of the way.

---

## Group 1 — `googleapis` transitive chain (MED, isolated)

- **Blast radius:** one worker (`workers/sheetsWorker.ts`) + `routes/integrations.ts`.
  The Google Sheets sync (migration 046) is **dormant** unless `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET` are set, so a regression can't affect any live user today.
- **Steps:**
  1. `npm i googleapis@latest -w @nookeb/api`; re-run `npm audit`.
  2. If `googleapis-common` still pins an old `gaxios` (→ vulnerable `rimraf`/`glob`),
     add `overrides` for the patched `brace-expansion`/`glob` majors (see the
     override caveat in Group 2).
  3. Smoke-test a real Sheets round-trip end-to-end (connect → create task → confirm
     the row mirrors into the sheet), because the audit fix touches the HTTP client
     (`gaxios`) the sync rides on.
- **Rollback:** revert `apps/api/package.json` + `package-lock.json`; the feature is
  gated so nothing user-facing changes on revert.

---

## Group 2 — `exceljs` / `uuid` (LOW) — attempted and deferred

**Empirical result of this pass:** a non-breaking fix was attempted and **rejected**;
no dependency change was committed. Details so the next owner doesn't repeat the work:

- `exceljs@4.4.0` is already the **latest** release — there is no patched `exceljs` to
  upgrade to. `npm audit fix --force`'s only offer is `exceljs@3.4.0`, a **semver-major
  downgrade** that would regress the `.xlsx` task export (`services/export.service.ts`).
  **Do not downgrade.**
- The advisories reduce to two leaves under `exceljs`'s `archiver`:
  - `brace-expansion` (GHSA-mh99-v99m-4gvg, high, DoS): advisory range is **`<=5.0.7`**,
    fixed only in **`5.0.8`**. The tree currently resolves `1.1.16` and `2.1.2` — both
    still flagged. A single top-level `overrides: { "brace-expansion": "5.0.8" }` would
    force a v1/v2→v5 major onto `minimatch@3` (v1 consumer) and `minimatch@5/9`
    (v2 consumers) across the **whole monorepo** — a real regression risk to the
    124-test baseline and the `archiver`/`glob` runtime. Not worth it for a server-side,
    authenticated, self-generated-workbook path.
  - `uuid` (GHSA-w5hq-g745-h8pq, **moderate**): "missing buffer bounds check in
    v3/v5/v6 **when `buf` is provided**". `exceljs` is uuid's **only** consumer
    (`npm why uuid`) and calls `uuid.v4()` **with no buffer arg**, so the app is **not
    actually reachable** by this advisory — it is a false-positive against our usage.
- **Override attempt (documented, reverted):** a top-level `overrides: { "uuid": "^11.1.1" }`
  (v4()'s API is unchanged v8→v11) was added and `npm install` run. Under npm 11 +
  workspaces the override **did not land in `package-lock.json`** without a full
  lockfile regeneration, which would rewrite the entire lock and risk the green
  baseline for a single moderate false-positive. Reverted; `package.json` restored.
- **Recommended path:** wait for an upstream `exceljs` release that bumps
  `archiver`/`uuid`; then a plain `npm i exceljs@latest` closes the chain. If it lingers,
  a **full clean lockfile regeneration** (`rm package-lock.json && npm install`) WITH the
  `uuid`/`brace-expansion` overrides in place, followed by the full test suite (esp.
  `export.service.test.ts`) and an actual `.xlsx` open, is the safe way to force it — do
  that as its own change, not folded into another upgrade.

---

## Group 3 — Fastify 4 → 5 detailed plan (API-only)

**Target versions:** `fastify ^5.10`, `@fastify/cors ^10`, `@fastify/cookie ^11`,
`@fastify/rate-limit ^10`, `@fastify/multipart ^9`, `fastify-plugin ^5`.
**Node ≥20 required** — already satisfied (`@types/node ^20`; CI/Railway on Node 20).

### Every Fastify v5 breaking change vs. THIS codebase

| v5 breaking change | Affects us? | Evidence / action |
|---|---|---|
| `request.routerPath` / `request.routeConfig` / `request.routeSchema` removed | **No** | We use `request.routeOptions.url` (files.ts:115, legacy-box.ts:133, share.ts:71-72) — which is the **v5-recommended** replacement, not a removed API. Zero changes. |
| `reply.getResponseTime()`, `request.connection`, `reply.context` removed | **No** | `grep` finds none in `src/`. |
| `app.use()` (middleware) removed | **No** | Not used; all logic is hooks/plugins. |
| Content-type parser semantics / encapsulation | **Verify** | One custom parser: the raw-body LINE webhook (`webhook/line.ts:1538`, `addContentTypeParser('application/json', {parseAs:'buffer'})`) in its own plugin scope. v5 keeps the API; re-verify the raw bytes still reach `verifyLineSignature` after the bump. |
| `@fastify/multipart` v9 scoping | **Verify** | Three isolated multipart scopes (vault, legacy-box, task-files). v9 keeps per-scope registration; re-verify each scope still parses and that no parser leaks into sibling routes. |
| `setErrorHandler` signature / encapsulated handlers | **Low** | Two handlers: root (`index.ts:193`) + encapsulated team (`team.router.ts:43`). v5 signature is unchanged; confirm the encapsulated team handler still shadows the root for `/api/teams/*`. |
| `@fastify/rate-limit` v10 route-config shape (`config.rateLimit`) | **Verify** | 10 per-route caps (auth ×2, legacy-box ×2, pro-interest, share ×2, task-files, tasks ×2) + the global limiter with `redis: app.redis` + `allowList`. v10 keeps `config.rateLimit`; re-verify the Redis store option and `allowList` signature. |
| `@fastify/cors` v10 options | **Low** | Function `origin(origin, cb)` allowlist + `credentials:true` — API unchanged in v10; smoke-test a preview-origin request. |
| `@fastify/cookie` v11 | **Low** | Only `app.register(cookie)` + `request.cookies[...]` reads (auth.ts). API unchanged. |
| `trustProxy` behaviour | **No** | Config option unchanged; keep `trustProxy: true` (see the CLAUDE.md invariant — never `1`). |
| Default JSON body-limit / logging (`logger` object) | **Low** | `logger: { level }` shape is unchanged in v5. |

### Plugins & v5 compatibility

| Plugin | Current | v5-compatible target | Status |
|---|---|---|---|
| `fastify` | ^4.28 | ^5.10 | umbrella |
| `@fastify/cors` | ^9 | ^10 | ✅ supports Fastify 5 |
| `@fastify/cookie` | ^9 | ^11 | ✅ |
| `@fastify/rate-limit` | ^9 | ^10 | ✅ |
| `@fastify/multipart` | ^8 | ^9 | ✅ |
| `fastify-plugin` | ^4 | ^5 | ✅ (bump so `fp()` metadata matches v5) |

### Effort & risk

- **LOC to change:** small — roughly **0–20 lines**. The `routeOptions.url` reads (the
  plan's headline concern) need **no change**. Most work is the dependency bump +
  re-verification, not code edits. Any edits would be in plugin-registration options if
  v10/v11 renamed a field.
- **Estimate:** 4–8 h (bump, run the 124-test suite, manual smoke of: LINE webhook
  signature 401/200, one multipart upload per scope, a rate-limited route returning 429,
  a CORS preview origin).
- **Biggest risk:** the **raw-body webhook content-type parser** under v5's revised
  content-type-parser/encapsulation internals. If the raw `Buffer` no longer reaches the
  handler intact, every webhook 401s (signature mismatch) and the bot goes silent with no
  error — test this path first and explicitly (a signed request → 200; a tampered one → 401).

---

## Group 4 — Next.js 14 → 16 detailed plan (web-only, largest)

**Target:** `next@16.x`, which **requires React 19** (`react`/`react-dom` `^18.3` → `^19`,
`@types/react`/`@types/react-dom` → `^19`). Also pulls a patched `postcss` (closes the
XSS / path-traversal / arbitrary-file-read advisories). Node ≥20 required (satisfied).

### Breaking changes (Next 15 + 16) vs. THIS codebase

1. **Async `params` / `searchParams` (Next 15) — the main surface, and it is SMALL.**
   Only **7 files** touch route params, split by how they read them:
   - **Server files (must `await params`)** — 3: `app/api/file-pdf/[fileId]/route.ts`
     (`{ params }: { params: { fileId } }`), `app/box/[slug]/page.tsx` (page + its
     `generateMetadata`), `app/api/og/route.tsx` (reads `?theme` off the request URL —
     verify the `nextUrl.searchParams` access).
   - **Client pages receiving `params` as a PROP (must unwrap with React `use()`)** — 4:
     `dashboard/diary/[date]`, `dashboard/tasks/[taskId]`, `liff/tasks/[taskId]`,
     `liff/tasks/create/[type]`.
   - **Client pages using the `useParams()` / `useSearchParams()` HOOKS — no change** (hooks
     stay synchronous): `share/[token]`, `dashboard/teams/[teamId]`, plus every
     `useSearchParams()` caller (`auth/callback`, `join`, the liff create flow).
   - The official `npx @next/codemod@latest next-async-request-api .` handles all 7
     mechanically; review its diff.

2. **`next.config.mjs` — Turbopack becomes the default (Next 16).**
   The config uses a `webpack:` hook for the **pdfjs-dist `canvas: false` alias** (required
   or the build fails "Can't resolve 'canvas'"). Under Turbopack this must be re-expressed
   as `turbopack: { resolveAlias: { canvas: ... } }`, **or** keep the production build on
   webpack. `rewrites()` (the `/api-proxy` passthrough), `redirects()`, `headers()` (the
   full CSP/security-headers block), and `transpilePackages` are all still supported —
   **verify the CSP block still emits** and re-test the `/api-proxy` rewrite end-to-end (a
   login smoke test), since the rewrite-SSRF advisory this upgrade closes lives exactly here.

3. **Caching default changes (Next 15).** `fetch()` is no longer cached by default and
   GET Route Handlers are no longer statically cached. Impact is minimal — the app already
   sets `cache: 'no-store'` on its cross-origin fetches (file-pdf route, box theme lookup)
   and `dynamic = 'force-dynamic'` on the dynamic pages. Re-confirm no page unexpectedly
   goes static.

4. **Server Actions.** **None exist** (`grep 'use server'` → nothing), so the Server-Action
   security/behaviour changes (the GHSA-955p Server-Function disclosure advisory included)
   are **not applicable** to our code — but this is a headline reason to upgrade regardless.

5. **`next/og` (`ImageResponse`).** Still supported in 16; `runtime = 'edge'` on the OG
   route is retained (it is REQUIRED on Windows dev — see CLAUDE.md). Re-verify the Satori
   render after the bump.

6. **ESLint / `eslint-config-next`.** Next 16 aligns with ESLint 9 flat config — update
   `eslint-config-next` and, if present, migrate `.eslintrc` → `eslint.config.mjs`.

7. **React 19 runtime changes.** Ref-as-prop, removed legacy APIs (`ReactDOM.render`,
   string refs, legacy context) — `grep` shows none in use; the app is hooks + function
   components. Low risk, but run the full dashboard/LIFF/reveal flows once under React 19
   (the scroll-reveal failsafe and the mobile pdf.js viewer are the fiddly bits).

### Dependencies that also move

`react ^19`, `react-dom ^19`, `@types/react ^19`, `@types/react-dom ^19`,
`eslint-config-next@16`, patched `postcss` (transitive via `next`). `pdfjs-dist ^4.10`
stays — verify it builds under the new bundler default (see point 2).

### Effort & risk

- **LOC to change:** ~7 files for async params (codemod-assisted) + `next.config.mjs`
  bundler-alias (~5–15 lines) + `.eslintrc` migration. Call it **~30–60 lines**, most
  codemod-generated.
- **Estimate:** 12–20 h including a full manual web regression (login, dashboard file
  ops, share page, diary, vault unlock, legacy-box create+reveal+voice, LIFF task flows,
  mobile PDF preview, the landing page reveal).
- **Biggest risk:** the **`/api-proxy` rewrite + CSP** surviving the config/bundler change.
  If the rewrite target or the security-headers block silently changes shape, either login
  breaks (`API_PROXY_TARGET` not applied → `DNS_HOSTNAME_RESOLVED_PRIVATE`) or the CSP
  stops emitting — both are prod-breaking and both are the exact things this upgrade is
  meant to harden. Gate the upgrade behind an explicit login + CSP-header check on a
  preview deploy before promoting.

---

## Rollback plan (per group)

- **Groups 1–2 (dep bumps / overrides):** `git revert` the manifest+lock commit (or
  `git checkout <prev> -- apps/api/package.json package.json package-lock.json && npm ci`).
  Both features (Sheets sync, xlsx export) are self-contained; reverting restores the exact
  prior tree. Redeploy the API/worker.
- **Group 3 (Fastify):** revert the `apps/api` manifest+lock and redeploy API + worker.
  Keep the pre-upgrade Railway image tagged so a bad deploy can be rolled back to the last
  green SHA immediately (verify via `GET /health` `commit`). No DB/migration coupling, so
  rollback is a pure redeploy.
- **Group 4 (Next):** Vercel keeps immutable deployments — **instant rollback** by
  re-promoting the previous production deployment in the Vercel dashboard while the code
  revert lands. Because the web authenticates only via the cookie + `/api-proxy`, an old
  web bundle works against the current API with no coordination.

## CI/CD changes required

- **Node:** pin CI + Railway + Vercel to **Node 20** explicitly (Fastify 5 and Next 16 both
  require ≥20). Add an `engines: { node: ">=20" }` to `apps/api/package.json` (currently
  none) so a wrong-Node build fails fast.
- **Test command:** the suite needs env loaded — CI must run
  `tsx --env-file=<env> --test …` (the security integration tests self-skip when Supabase
  creds are placeholders / `SECURITY_TEST_API_URL` is unset, so they never break CI; wire
  the real secrets + a disposable API URL into a nightly job to exercise B1/B2/B4/B5 for
  real).
- **Group 3:** add a post-deploy smoke step hitting the LINE webhook with a
  correctly-signed empty-events body (expect 200) and a tampered one (expect 401).
- **Group 4:** add a Vercel preview gate that (a) asserts the CSP header is present on `/`
  and (b) does the `POST /api-proxy/auth/line` dummy-code check (expect 401, proving the
  rewrite reaches the API) before promotion. If the build moves to Turbopack, update the
  build command / config accordingly.
- **Turbopack (Group 4):** if adopting it, ensure the `copy-pdf-worker.mjs`
  `predev`/`prebuild` hook still runs and the `canvas` alias is expressed for the new
  bundler; add a CI check that `public/pdf.worker.min.mjs` exists post-build.

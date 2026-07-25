# Security Upgrade Plan

Tracks the npm-audit vulnerabilities that **cannot** be auto-fixed because the
only available fix is a breaking major-version change. The non-breaking fixes
(`shell-quote` / `concurrently`) were already applied with `npm audit fix` and
are **not** listed here.

- **Baseline before this pass:** 22 vulnerabilities (1 moderate, 21 high)
- **After `npm audit fix` (non-breaking):** 20 vulnerabilities (1 moderate, 19 high)
- **Remaining (this document):** all 20 require a breaking upgrade.

Run `npm audit` to reproduce; `npm audit fix --force` would apply every item
below at once (including downgrades) — do **not** run it blind. Work through the
ordered groups instead.

---

## Remaining vulnerabilities

### 1. Fastify 4.x runtime chain — `fast-uri`, `find-my-way`, `fast-json-stringify` (+ compilers)

| Package | Current | Target | Advisory |
|---|---|---|---|
| `fast-uri` | ≤3.1.1 (transitive) | via `fastify@5` | GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc, GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6 (path traversal / host confusion) |
| `find-my-way` | ≤9.6.0 (transitive) | via `fastify@5` | GHSA-c96f-x56v-gq3h (HTTP/2 DoS) |
| `fast-json-stringify` | 3.1.0–6.0.0 (transitive) | via `fastify@5` | depends on vulnerable `fast-uri` |
| `@fastify/ajv-compiler` | 3.1.0–3.6.0 | via `fastify@5` | depends on vulnerable `fast-uri` |
| `@fastify/fast-json-stringify-compiler` | 3.0.0–5.0.0-pre | via `fastify@5` | depends on vulnerable `fast-json-stringify` |
| **`fastify`** | **`^4.28.0`** | **`^5.10.0`** | umbrella — pulls the patched deps above |

**Direct deps that must move together with `fastify@5`:**
`@fastify/cors ^9 → ^10`, `@fastify/cookie ^9 → ^11`, `@fastify/rate-limit ^9 → ^10`,
`@fastify/multipart ^8 → ^9`, `fastify-plugin ^4 → ^5`.

**Breaking-change impact: HIGH.** Fastify 4 → 5 is a framework major. Known
touch-points in this codebase:
- Route option / error-handler API changes (`setErrorHandler`, `routeOptions`)
  — several routes read `request.routeOptions.url` (files.ts, share.ts).
- Content-type parser scoping (the raw-body LINE webhook parser in
  `routes/webhook/line.ts` and the three isolated `@fastify/multipart` scopes —
  vault, legacy-box, task-files) must be re-verified against v5 encapsulation.
- `@fastify/rate-limit` v10 config shape (`config.rateLimit` on routes) —
  re-verify the per-route caps (share, vault, legacy-box, pro-interest).
- Node ≥20 is required by Fastify 5 (already satisfied — `@types/node ^20`).

### 2. Next.js 14.x — `next`, `postcss`

| Package | Current | Target | Advisory |
|---|---|---|---|
| **`next`** | **`^14.2.4`** (resolves 14.2.35) | **`16.2.11`** | 21 advisories incl. GHSA-p9j2-gv94-2wf4 (SSRF in rewrites), GHSA-955p-x3mx-jcvp (Server Function disclosure), GHSA-ggv3-7p47-pfv8 (request smuggling), cache-poisoning + DoS set |
| `postcss` | ≤8.5.17 (via `next`) | via `next@16` | GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 (XSS / path traversal / arbitrary file read) |

**Breaking-change impact: HIGH.** Already tracked as an accepted risk in
`CLAUDE.md` ("Known accepted risks") and `ROADMAP.md`: the 14 branch has no
non-breaking fix and the only offered path is Next 14 → 16. Compensating control
in place: the `/api-proxy` rewrite is a single fixed-target passthrough with no
user-controlled destination (`apps/web/next.config.mjs`), which blunts the
rewrite-SSRF advisory specifically. A full 14 → 16 App Router migration is its
own scheduled project — do not fold it into this security pass.

### 3. `googleapis` transitive chain — `gaxios` → `rimraf` → `glob` → `minimatch` → `brace-expansion`

| Package | Current | Target | Advisory |
|---|---|---|---|
| `brace-expansion` | ≤5.0.7 (transitive) | patched via `googleapis` bump | GHSA-mh99-v99m-4gvg (ReDoS/OOM) |
| `minimatch` | 2.0.0–10.0.2 | patched via `googleapis` bump | depends on vulnerable `brace-expansion` |
| `glob` | 4.3.0–10.5.0 | patched via `googleapis` bump | depends on vulnerable `minimatch` |
| `rimraf` | 2.3.0–3.0.2 / 4.2.0–5.0.10 | patched via `googleapis` bump | depends on vulnerable `glob` |
| `gaxios` | 7.1.3 | patched via `googleapis` bump | depends on vulnerable `rimraf` |
| `googleapis-common` | ≥8.0.2-rc.0 | via `googleapis` latest | depends on vulnerable `gaxios` |
| **`googleapis`** | **`^173.0.0`** | **latest patched (`>=173.x` with fixed `googleapis-common`)** | umbrella |

**Breaking-change impact: MEDIUM.** `googleapis` is used only by the Google
Sheets sync (migration 046, `workers/sheetsWorker.ts` + `routes/integrations.ts`),
a feature that is dormant unless `GOOGLE_CLIENT_ID`/`SECRET` are set. Bump to the
newest `googleapis` and re-run `npm audit` — if `googleapis-common` still pins an
old `gaxios`, add a `package.json` `overrides` entry for `brace-expansion`/`glob`
to the patched majors and smoke-test a real sync. Low blast radius (one worker,
gated feature) but verify the Sheets round-trip end-to-end after the bump.

### 4. `exceljs` transitive chain — `archiver` → `zip-stream`/`readdir-glob` → `glob`/`minimatch`/`brace-expansion` + `uuid`

| Package | Current | Target | Advisory |
|---|---|---|---|
| `uuid` | <11.1.1 (via `exceljs`) | patched `uuid@11.1.1+` | GHSA-w5hq-g745-h8pq (missing buffer bounds check, **moderate**) |
| `archiver` / `archiver-utils` / `zip-stream` / `readdir-glob` | (via `exceljs`) | patched upstream | depend on vulnerable `glob`/`minimatch`/`brace-expansion` |
| **`exceljs`** | **`^4.4.0`** (latest) | **no clean target yet** | umbrella |

**Breaking-change impact: LOW (but no safe fix today).** `exceljs@4.4.0` is
already the newest release; `npm audit fix --force` "fixes" this only by
**downgrading to `exceljs@3.4.0`** — a regression that would lose functionality
the `.xlsx` task export relies on (`services/export.service.ts`). **Do not
downgrade.** The real fix is upstream (`archiver`/`glob` majors). Options, in
preference order:
1. Wait for an `exceljs` release that bumps `archiver`/`uuid`, then upgrade.
2. If it lingers, add `package.json` `overrides` forcing patched
   `brace-expansion`, `minimatch`, `glob`, and `uuid` and run the
   `export.service.test.ts` suite to confirm the workbook still builds.

These packages run only at export time (server-side, authenticated,
self-generated workbooks), so exposure is minimal — accept and monitor.

---

## Suggested order of upgrades

Cheapest / lowest-risk first, so each step can ship and be verified independently:

1. **`googleapis` (Group 3) — MEDIUM, isolated.** Bump to latest; add
   `overrides` for `brace-expansion`/`glob` if the transitive pins persist.
   Verify a Google Sheets sync round-trip. Ships on its own.
2. **`exceljs` overrides (Group 4) — LOW.** Do **not** downgrade. Add patched
   `overrides` (or wait for upstream) and run `export.service.test.ts`. Ships on
   its own.
3. **Fastify 4 → 5 (Group 1) — HIGH, API-only.** Bump `fastify` + all
   `@fastify/*` plugins + `fastify-plugin` together. Re-verify content-type
   parser scoping (webhook raw body, the three multipart scopes), the root +
   team error handlers, `request.routeOptions.url` reads, and every per-route
   `config.rateLimit`. Full API regression + the test suite before deploy.
4. **Next.js 14 → 16 (Group 2) — HIGH, web-only, largest.** Scheduled as its own
   project (see `ROADMAP.md`). Do last: App Router migration, `/api-proxy`
   rewrite re-validation, and full web smoke test. Keep the compensating control
   (fixed-target proxy) documented until this lands.

> Groups 1 and 2 are independent (separate workspaces) and can proceed in
> parallel by different owners once Groups 3–4 are out of the way.

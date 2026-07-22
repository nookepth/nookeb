# Roadmap

## Planned: Next.js 14 → 16 Migration

- Current: `next@^14.2.4` (Next.js 14.2.x branch, in `apps/web/package.json`)
- Target: `next@16.x` (latest stable)
- Reason: Resolve open request-smuggling / cache-poisoning advisories in the Next 14
  rewrites/middleware layer. `npm audit`'s only offered remediation is a major-version
  jump — there is no patch on the 14 branch.
- Compensating control until migration: the `/api-proxy` rewrite
  (`apps/web/next.config.mjs`) uses a single fixed Railway target
  (`API_PROXY_TARGET`) with no user-controlled destination, so the smuggling surface is
  a fixed passthrough.
- Blocking items to resolve before upgrade:
  - App Router compatibility audit (route boundaries, `generateMetadata`, `next/og`
    edge routes, LIFF pages under `app/liff/tasks`).
  - Turbopack stability check for the production build.
  - Test all `/api-proxy` rewrite rules under Next 16 routing changes.
- Priority: Medium — schedule for the next major sprint.
- Reference: `CLAUDE.md` → **Known accepted risks** (Next.js pin, accepted 2026-07-19).

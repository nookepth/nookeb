# Deploy trigger

This file exists only to force Railway's `apps/api/**` path filter to rebuild the
`@nookeb/api` service. Empty commits do not touch a watched path and are silently
ignored by Railway's monorepo change detection.

Last forced redeploy: 2026-07-31 — Google OAuth callback 401 fix (commit 27fc6fb).

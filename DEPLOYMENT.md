# Deployment

The full deploy topology (Railway API + Worker, Vercel web, LINE console, migration
order) lives in `CLAUDE.md` → **Deployment (Production)**. This file is the quick
reference for the environment variables that MUST be set, and how to generate the
security secrets.

## Required Environment Variables

Set these on **both** Railway services (the API and the separate Worker) — the worker
does not inherit the API's env. See `.env.example` for the complete list; the ones below
are mandatory and the app will not start (or a feature will not work) without them.

### Security secrets

| Variable | Purpose | How to generate | Where to set |
|----------|---------|-----------------|--------------|
| `JWT_SECRET` | Signs the app session JWT (HS256) issued after LINE Login. | `openssl rand -hex 32` | Railway API + Worker |
| `DOWNLOAD_TOKEN_SECRET` | Signs one-time `?dl_token=` file-download tokens. **Must be a distinct value from `JWT_SECRET`** so a download token can never be replayed as a session JWT. Required (min 32 chars) — the API fails fast at startup if it is missing or too short. There is no longer a `JWT_SECRET`-derived fallback (that produced a predictable secret). | `openssl rand -hex 32` | Railway API + Worker (same value on both) |

> **Why the worker needs `DOWNLOAD_TOKEN_SECRET` too:** the API and worker share one
> `config.ts`, which validates the full schema at startup. A missing value would crash
> the worker on boot even though it never signs download tokens. Set the same value on
> both services.

### Other required core vars (see `.env.example` for details)

`NODE_ENV=production`, `APP_URL`, `WEB_URL`, `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`,
`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `REDIS_URL` (must be `rediss://` for a remote Redis).

On Vercel (web): `API_PROXY_TARGET` (Railway API origin, no trailing slash) and
`NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID`.

## Rolling out a new `DOWNLOAD_TOKEN_SECRET`

Because this value is now required, an existing deployment that relied on the old
derived fallback must have `DOWNLOAD_TOKEN_SECRET` set **before** deploying the code that
enforces it:

1. Generate a secret: `openssl rand -hex 32`.
2. Set `DOWNLOAD_TOKEN_SECRET` to that value on the Railway **API** and **Worker**
   services (identical value on both).
3. Deploy. Verify each service restarts cleanly (`GET /health` on the API returns the
   new commit SHA).

Rotating the value only invalidates any download tokens minted in the last 60 seconds
(their TTL), so rotation is safe to do at any time.

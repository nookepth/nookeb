import { STATUS_CODES } from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { TASK_NOTIFICATIONS_ENABLED } from '@nookeb/shared';
import { config } from './config';
import { DIARY_ADDON_ENABLED } from './config/plans';
import supabasePlugin from './plugins/supabase';
import r2Plugin from './plugins/r2';
import redisPlugin from './plugins/redis';
import bullmqPlugin from './plugins/bullmq';
import authPlugin from './middleware/auth';
import lineWebhookRoutes from './routes/webhook/line';
import authRoutes from './routes/auth';
import filesRoutes from './routes/files';
import trashRoutes from './routes/trash';
import shareRoutes from './routes/share';
import foldersRoutes from './routes/folders';
import tagsRoutes from './routes/tags';
import spacesRoutes from './routes/spaces';
import teamRoutes from './routes/team.router';
import analyticsRoutes from './routes/analytics';
import referralRoutes from './routes/referral';
import adminRoutes from './routes/admin';
import adminOpsRoutes from './routes/admin-ops';
import progressRoutes from './routes/progress';
import diaryRoutes from './routes/diary';
import vaultRoutes from './routes/vault';
import legacyBoxRoutes from './routes/legacy-box';
import tasksRoutes from './routes/tasks';
import taskFilesRoutes from './routes/task-files';
import groupsRoutes from './routes/groups';
import proInterestRoutes from './routes/pro-interest';
import eventsRoutes from './routes/events';
import integrationsRoutes from './routes/integrations';
import staticRoutes from './routes/static';
import plansRoutes from './routes/plans';
import boostRoutes from './routes/boosts';
import supportRoutes from './routes/support';
import diaryAddonRoutes from './routes/diaryAddon';
import quotaPlugin from './middleware/quota';
import { flushAll } from './services/upload-queue';

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    // MUST stay `true` (see CLAUDE.md "Deployment"; regression history: 771fd9f
    // fixed a login-wide ban, a39adec re-broke it with `trustProxy: 1`).
    //
    // Dashboard traffic arrives through TWO proxy hops — browser → Vercel
    // (/api-proxy rewrite) → Railway ingress → API — so with `trustProxy: 1`
    // the one trusted hop resolves `request.ip` to the RIGHTMOST X-Forwarded-For
    // entry, which is Vercel's shared egress IP, NOT the client. Every dashboard
    // user then shares one "IP": POST /auth/line's 10/min + ban:5 limiter bans
    // the whole userbase after a login burst (nobody can log in), and the global
    // 100/min limiter 429s all dashboard traffic under modest load.
    //
    // `true` takes the LEFTMOST entry — the real client for proxied traffic.
    // Known tradeoff: a client hitting Railway directly can spoof its
    // X-Forwarded-For and dodge per-IP limits; accepted for now because a
    // static hop count cannot be correct for both the 2-hop dashboard path and
    // 1-hop direct traffic. If limiter-dodging becomes a concern, key the
    // /auth/line limiter on something better than IP instead of lowering this.
    trustProxy: true,
  });

  // CORS for the web dashboard. NOTE: the dashboard now reaches the API
  // same-origin through the Next.js /api-proxy rewrite (so its requests never
  // need CORS at all); this remains for the transition period while older
  // deployed bundles still call the API cross-origin with a Bearer header, and
  // for the Vercel PREVIEW deploys, which are a different origin than
  // config.WEB_URL.
  //
  // Explicit env-var allowlist (never a wildcard/regex with credentials): the
  // production web origin, plus any extra origins in CORS_EXTRA_ORIGINS
  // (comma-separated — e.g. Vercel preview URLs), plus localhost in development.
  // The old `*-nookeb.vercel.app` regex let anyone register an "evil-nookeb"
  // project on Vercel and pass CORS — an explicit list closes that.
  // @fastify/cors reflects only a matched origin back and sets `Vary: Origin`,
  // so caches never cross origins. A request with no Origin header
  // (server-to-server, e.g. the LINE webhook) is allowed through — CORS response
  // headers are irrelevant to it.
  const allowedOrigins = new Set<string>([config.WEB_URL]);
  for (const extra of (config.CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    allowedOrigins.add(extra);
  }
  if (config.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://localhost:3001');
  }
  await app.register(cors, {
    origin(origin, cb) {
      if (!origin || allowedOrigins.has(origin)) {
        return cb(null, true);
      }
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Baseline security response headers on every API response. Hand-rolled as an
  // onSend hook rather than @fastify/helmet: the API serves JSON + binary
  // streams, so helmet's HTML-oriented defaults (CSP, etc.) don't apply, and
  // this avoids adding a dependency. Especially relevant for
  // GET /vault/files/:id/view, which streams user-controlled bytes inline —
  // nosniff blocks content-type confusion. HSTS is set only in production (over
  // TLS): Vercel injects it on *.vercel.app but nothing guarantees it on the
  // Railway origin or a future custom domain. Route-level onSend hooks (e.g. the
  // vault's Cache-Control/X-Robots-Tag) still run and add to these.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    if (config.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // Session cookie support (FIX #7): the app JWT now travels in an HttpOnly
  // cookie set by POST /auth/line, so client-side JS can never read it.
  await app.register(cookie);

  await app.register(supabasePlugin);
  await app.register(r2Plugin);
  await app.register(redisPlugin);
  await app.register(bullmqPlugin);

  // Global rate limit: 100 req/min per IP, state in the shared Redis so all
  // API instances count together. Exempt: /health (must stay instant for the
  // platform probe) and the LINE webhook (guarded by its HMAC signature and
  // required to answer within 1 second — a limiter stall would break it).
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis: app.redis,
    allowList: (request) =>
      request.url === '/health' ||
      request.url.startsWith('/webhook/line') ||
      // The upload-progress page polls this on a timer; it's already bounded by
      // the short-TTL Redis key, so the limiter only adds a command per poll.
      request.url.startsWith('/progress/'),
  });

  await app.register(authPlugin);
  // Quota reservation bookkeeping. Registered on the ROOT instance (via
  // fastify-plugin, so it is not encapsulated) because its onResponse hook must
  // see every route's status code to release reservations held by requests that
  // ended up failing. Order: after authPlugin, before any route.
  await app.register(quotaPlugin);

  // Liveness probe. Railway routes traffic on the strength of this response, so
  // it must actually check the two dependencies without which the API can serve
  // nothing: Redis (rate limiter state, progress store, upload debounce, every
  // queue enqueue) and Postgres. It used to return a hardcoded 200, which meant
  // a wedged instance kept receiving traffic and was never restarted.
  //
  // Mirrors workers/index.ts, which has done the Redis half correctly all along.
  // Response shape is additive — status/service/commit/timestamp are unchanged,
  // `checks` is new — so anything already parsing this keeps working.
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    let healthy = true;

    // ioredis exposes its link state synchronously; no command is issued, so a
    // dead Redis fails the probe instantly instead of hanging it.
    try {
      checks.redis = app.redis?.status === 'ready' ? 'ok' : 'error';
      if (checks.redis === 'error') healthy = false;
    } catch {
      checks.redis = 'error';
      healthy = false;
    }

    // Cheapest possible read: one indexed column, one row, no filter. `users` is
    // never empty in any deployed environment, but an empty result is still
    // treated as healthy — only a transport/permission ERROR means the DB link
    // is down, which is what this probe is asking about.
    try {
      const { error } = await app.supabase.from('users').select('id').limit(1).maybeSingle();
      checks.db = error ? 'error' : 'ok';
      if (checks.db === 'error') healthy = false;
    } catch {
      checks.db = 'error';
      healthy = false;
    }

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'nookeb-api',
      // Railway injects the deployed commit SHA — surfaced here to verify which build is live.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // Webhook is registered in its own scope: it uses a raw-body content parser
  await app.register(lineWebhookRoutes);
  await app.register(authRoutes);
  await app.register(filesRoutes);
  await app.register(trashRoutes);
  await app.register(shareRoutes);
  await app.register(foldersRoutes);
  await app.register(tagsRoutes);
  await app.register(spacesRoutes);
  await app.register(teamRoutes, { prefix: '/api/teams' });
  await app.register(analyticsRoutes);
  await app.register(referralRoutes);
  await app.register(adminRoutes);
  // /admin/system — the ops half (queues, worker liveness, delivery, quota
  // pressure, SLA queue). Own plugin scope; shares adminRoutes' gate via
  // registerAdminGuard, so the two can never drift on who counts as an admin.
  await app.register(adminOpsRoutes);
  await app.register(progressRoutes);
  await app.register(diaryRoutes);
  await app.register(vaultRoutes);
  await app.register(legacyBoxRoutes);
  await app.register(tasksRoutes);
  // Own scope: it registers @fastify/multipart, which would otherwise install a
  // content-type parser across every route sharing tasksRoutes' scope.
  await app.register(taskFilesRoutes);
  await app.register(groupsRoutes);
  await app.register(proInterestRoutes);
  await app.register(eventsRoutes);
  await app.register(integrationsRoutes);
  await app.register(staticRoutes);
  // ระบบสมาชิก (membership) — pricing, quota status, บูธ, support SLA.
  await app.register(plansRoutes);
  await app.register(boostRoutes);
  await app.register(supportRoutes);
  // หนูเก็บความทรงจำ — the diary-reminder add-on (migration 052). Separate from
  // plansRoutes on purpose: it is an add-on any tier may hold, not a plan.
  await app.register(diaryAddonRoutes);

  // Root error handler — sanitizes every error the routes let bubble up
  // (previously Fastify's default handler echoed error.message, which could leak
  // DB column names / constraints / internal detail). Team routes still have
  // their own handler; this covers the rest.
  //  - 5xx: never expose anything but a generic message (no message, no stack).
  //  - 4xx: return the standard HTTP status name; keep the error's own message
  //    ONLY when it came from a deliberate throw (Fastify / @fastify/error and
  //    validation errors carry a `code`) — a plain thrown DB error has no
  //    statusCode and falls into the 5xx branch, so it never leaks here.
  app.setErrorHandler((error, request, reply) => {
    app.log.error({ err: error, reqId: request.id }, 'unhandled route error');
    reply.header('Content-Type', 'application/json');

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      return reply.code(500).send({ statusCode: 500, error: 'Internal Server Error' });
    }

    const body: { statusCode: number; error: string; message?: string } = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
    };
    if (typeof (error as { code?: unknown }).code === 'string' && error.message) {
      body.message = error.message;
    }
    return reply.code(statusCode).send(body);
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`nookeb API listening on :${config.PORT}`);

  // FIX 15 — print the feature flags this SERVICE resolved, so the deployed
  // state is auditable from the boot log (the worker does the same for the scan
  // pipeline). Env is per Railway service: a flag set on the API but not the
  // worker half-enables its feature, and this line is what makes that visible
  // without shelling into the container.
  //
  // DIARY_ADDON_ENABLED is read from config/plans.ts — the constant the routes
  // and the sweep actually branch on — not from `config`, so the log can never
  // disagree with behaviour. See the note on config.ts's schema entry.
  app.log.info({ DIARY_ADDON_ENABLED }, 'feature flag: diary add-on');
  app.log.info({ TASK_NOTIFICATIONS_ENABLED }, 'feature flag: task notifications');

  // Flush any in-memory upload batches still inside the 1.5s debounce window
  // before exiting — otherwise those collected files are lost with no trace.
  // Bounded by a 5s timeout so a hung flush can't block Railway's deploy cycle;
  // we force-exit either way.
  let exiting = false;
  const flushAndExit = (code: number, reason: string): void => {
    // A crash during the flush would re-enter here; only the first wins.
    if (exiting) return;
    exiting = true;
    void (async () => {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      try {
        await Promise.race([flushAll(app), timeout]);
      } catch (err) {
        app.log.error({ err }, `flushAll on ${reason} failed`);
      }
      process.exit(code);
    })();
  };

  // On deploy/restart.
  process.on('SIGTERM', () => flushAndExit(0, 'SIGTERM'));

  // Process-level safety net, mirroring workers/index.ts. Node's DEFAULT on an
  // uncaughtException is to die immediately — which skips the SIGTERM path
  // above, so every batch inside the debounce window is dropped silently. This
  // handler buys back that one flush, logs the cause loudly, then still exits
  // non-zero so Railway restarts a clean process (never keep serving from an
  // undefined state).
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'CRITICAL uncaughtException — flushing batches and exiting for restart');
    flushAndExit(1, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'CRITICAL unhandledRejection — flushing batches and exiting for restart');
    flushAndExit(1, 'unhandledRejection');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import supabasePlugin from './plugins/supabase';
import r2Plugin from './plugins/r2';
import redisPlugin from './plugins/redis';
import bullmqPlugin from './plugins/bullmq';
import authPlugin from './middleware/auth';
import lineWebhookRoutes from './routes/webhook/line';
import authRoutes from './routes/auth';
import filesRoutes from './routes/files';
import foldersRoutes from './routes/folders';
import tagsRoutes from './routes/tags';
import spacesRoutes from './routes/spaces';
import teamRoutes from './routes/team.router';
import analyticsRoutes from './routes/analytics';
import referralRoutes from './routes/referral';
import adminRoutes from './routes/admin';
import progressRoutes from './routes/progress';
import staticRoutes from './routes/static';

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // CORS for the web dashboard. NOTE: the dashboard now reaches the API
  // same-origin through the Next.js /api-proxy rewrite (so its requests never
  // need CORS at all); these headers remain for the transition period while
  // older deployed bundles still call the API cross-origin with a Bearer
  // header. Allow-Credentials is set for completeness — the exact-origin
  // Allow-Origin above it is what makes that legal for browsers.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', config.WEB_URL);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
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
      request.url === '/health' || request.url.startsWith('/webhook/line'),
  });

  await app.register(authPlugin);

  app.get('/health', async () => ({
    status: 'ok',
    service: 'nookeb-api',
    // Railway injects the deployed commit SHA — surfaced here to verify which build is live.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
    timestamp: new Date().toISOString(),
  }));

  // Webhook is registered in its own scope: it uses a raw-body content parser
  await app.register(lineWebhookRoutes);
  await app.register(authRoutes);
  await app.register(filesRoutes);
  await app.register(foldersRoutes);
  await app.register(tagsRoutes);
  await app.register(spacesRoutes);
  await app.register(teamRoutes, { prefix: '/api/teams' });
  await app.register(analyticsRoutes);
  await app.register(referralRoutes);
  await app.register(adminRoutes);
  await app.register(progressRoutes);
  await app.register(staticRoutes);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`nookeb API listening on :${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import Fastify from 'fastify';
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
import adminRoutes from './routes/admin';
import integrationsRoutes from './routes/integrations';
import progressRoutes from './routes/progress';
import staticRoutes from './routes/static';

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // CORS for the web dashboard
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', config.WEB_URL);
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  await app.register(supabasePlugin);
  await app.register(r2Plugin);
  await app.register(redisPlugin);
  await app.register(bullmqPlugin);
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
  await app.register(adminRoutes);
  await app.register(integrationsRoutes);
  await app.register(progressRoutes);
  await app.register(staticRoutes);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`nookeb API listening on :${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

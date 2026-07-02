import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { config } from '../config';

export function createRedis(): Redis {
  // maxRetriesPerRequest: null is required by BullMQ
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export default fp(async (app) => {
  const redis = createRedis();
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit();
  });
});

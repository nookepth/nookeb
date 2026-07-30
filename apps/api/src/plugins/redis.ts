import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { config } from '../config';

export function createRedis(): Redis {
  // maxRetriesPerRequest: null is required by BullMQ
  const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // MANDATORY, not optional logging: an ioredis client is an EventEmitter, and
  // Node THROWS on an 'error' event that has no listener. Every transient Redis
  // blip (an Upstash TLS reset, a failover, a brief network partition) emits one
  // — so without this handler such a blip becomes an uncaughtException that
  // kills the process. In the API that skips the SIGTERM path entirely, so the
  // debounced upload batches still inside their 1.5s window are lost with no
  // trace; in the worker it trips the uncaughtException → exit(1) restart and
  // drops in-flight jobs.
  //
  // Attaching a listener does NOT disable recovery: ioredis keeps its own
  // reconnect/retry strategy, and with maxRetriesPerRequest: null commands queue
  // until the link is back. This only stops a survivable blip from being fatal.
  // Every Redis client in both processes is built here, so this covers them all.
  client.on('error', (err: Error) => {
    console.error('[redis] connection error (ioredis will retry):', err.message);
  });

  return client;
}

export default fp(async (app) => {
  const redis = createRedis();
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit();
  });
});

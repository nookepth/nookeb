import fp from 'fastify-plugin';
import { Queue } from 'bullmq';
import { FILE_QUEUE, type FileJob } from '@nookeb/shared';
import { createRedis } from './redis';

export default fp(async (app) => {
  const queue: Queue<FileJob> = new Queue(FILE_QUEUE, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  app.decorate('fileQueue', queue);
  app.addHook('onClose', async () => {
    await queue.close();
  });
});

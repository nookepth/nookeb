import { createUploadWorker, closeWorkerQueue, scheduleRepeatableJobs } from './upload.worker';

// Worker entry point — run as a separate process (npm run dev:worker / start:worker)
const uploadWorker = createUploadWorker();

// Register recurring maintenance jobs (daily R2 purge of long-deleted files)
scheduleRepeatableJobs().catch((err) => {
  console.error('[worker] failed to schedule repeatable jobs:', err);
});

console.log('[worker] nookeb file worker started');

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down...');
  await uploadWorker.close();
  await closeWorkerQueue();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

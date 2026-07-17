import { createUploadWorker, closeWorkerQueue, scheduleRepeatableJobs } from './upload.worker';
import { createTaskReminderWorker } from './taskReminderWorker';
import { closeTaskQueue } from '../services/taskScheduler';
import { config } from '../config';

// Worker entry point — run as a separate process (npm run dev:worker / start:worker)
const uploadWorker = createUploadWorker();
const taskWorker = createTaskReminderWorker();

// Register recurring maintenance jobs (daily R2 purge of long-deleted files)
scheduleRepeatableJobs().catch((err) => {
  console.error('[worker] failed to schedule repeatable jobs:', err);
});

// Effective scan config, printed once per boot: Railway env is per-service and
// invisible from the repo, and a flipped SCAN_ENHANCE_ENABLED silently ships
// unprocessed scans — this line makes the deployed state auditable in the logs.
console.log(
  `[worker] nookeb file worker started ` +
    `(scanEnhance=${config.SCAN_ENHANCE_ENABLED} scanOcr=${config.SCAN_OCR_ENABLED} ` +
    `scanDefaultMode=${config.SCAN_DEFAULT_MODE} virusScan=${config.ENABLE_VIRUS_SCAN})`,
);

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down...');
  await uploadWorker.close();
  await taskWorker.close();
  await closeTaskQueue();
  await closeWorkerQueue();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

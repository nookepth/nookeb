import http from 'node:http';
import { createUploadWorker, closeWorkerQueue, scheduleRepeatableJobs } from './upload.worker';
import { createTaskReminderWorker } from './taskReminderWorker';
import { createSheetsWorker } from './sheetsWorker';
import { closeTaskQueue, scheduleTaskRepeatableJobs } from '../services/taskScheduler';
import { closeSheetsQueue } from '../services/sheetsQueue';
import { isGoogleSheetsConfigured } from '../services/google-sheets.service';
import { createRedis } from '../plugins/redis';
import { config } from '../config';

// Worker entry point — run as a separate process (npm run dev:worker / start:worker)
const uploadWorker = createUploadWorker();
const taskWorker = createTaskReminderWorker();
// Google Sheets sync — only spun up when the feature is configured, so an
// unconfigured deployment doesn't hold an idle Redis connection open for a
// queue nothing ever writes to.
const sheetsWorker = isGoogleSheetsConfigured() ? createSheetsWorker() : null;

// --- Liveness ------------------------------------------------------------
// The worker has no request surface, so a crash/hang used to silently stop
// uploads/scans/diary/docx/purge/reminders with zero signal. A minimal HTTP
// /health endpoint lets Railway's healthcheck notice and restart it. It reports
// 200 only when the process is up AND its Redis link is connected (ioredis
// `.status === 'ready'`); a dropped Redis link means BullMQ can't pull jobs, so
// the process is effectively dead and should fail the probe.
const healthRedis = createRedis();
const healthServer = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health') {
    res.writeHead(404).end();
    return;
  }
  const redisReady = healthRedis.status === 'ready';
  res.writeHead(redisReady ? 200 : 503, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      status: redisReady ? 'ok' : 'degraded',
      service: 'nookeb-worker',
      redis: healthRedis.status,
      // Mirrors the API's /health: surface the deployed commit for build verification.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
      timestamp: new Date().toISOString(),
    }),
  );
});
healthServer.listen(config.WORKER_HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[worker] health endpoint on :${config.WORKER_HEALTH_PORT}/health`);
});

// Process-level safety net. An uncaught exception or unhandled rejection leaves
// Node in an undefined state — better to log loudly (matching the CRITICAL
// convention in upload.worker.ts's failed-job handler) and exit(1) so Railway's
// restart policy revives a clean process than to hang half-broken. Without this,
// the default is a silent process death (uncaughtException) or, on older Node, a
// mere warning (unhandledRejection) that leaves the worker limping.
process.on('uncaughtException', (err) => {
  console.error('[worker] CRITICAL uncaughtException — exiting for restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] CRITICAL unhandledRejection — exiting for restart:', reason);
  process.exit(1);
});

// Register recurring maintenance jobs (daily R2 purge of long-deleted files)
scheduleRepeatableJobs().catch((err) => {
  console.error('[worker] failed to schedule repeatable jobs:', err);
});
// Recurring-task self-heal sweep (see processRecurSweep in taskReminderWorker)
scheduleTaskRepeatableJobs().catch((err) => {
  console.error('[worker] failed to schedule task repeatable jobs:', err);
});

// Effective scan config, printed once per boot: Railway env is per-service and
// invisible from the repo, and a flipped SCAN_ENHANCE_ENABLED silently ships
// unprocessed scans — this line makes the deployed state auditable in the logs.
console.log(
  `[worker] nookeb file worker started ` +
    `(scanEnhance=${config.SCAN_ENHANCE_ENABLED} scanOcr=${config.SCAN_OCR_ENABLED} ` +
    `scanDefaultMode=${config.SCAN_DEFAULT_MODE} virusScan=${config.ENABLE_VIRUS_SCAN} ` +
    `sheetsSync=${sheetsWorker !== null})`,
);

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down...');
  healthServer.close();
  await uploadWorker.close();
  await taskWorker.close();
  await sheetsWorker?.close();
  await closeTaskQueue();
  await closeSheetsQueue();
  await closeWorkerQueue();
  await healthRedis.quit().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

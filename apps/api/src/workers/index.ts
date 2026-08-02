import http from 'node:http';
import type { Job, Worker } from 'bullmq';
import { createUploadWorker, closeWorkerQueue, scheduleRepeatableJobs } from './upload.worker';
import { createTaskReminderWorker } from './taskReminderWorker';
import { createSheetsWorker } from './sheetsWorker';
import { closeTaskQueue, scheduleTaskRepeatableJobs } from '../services/taskScheduler';
import { closeSheetsQueue } from '../services/sheetsQueue';
import { isGoogleSheetsConfigured } from '../services/google-sheets.service';
import { createMembershipWorker } from '../jobs/membership.worker';
import { closeMembershipQueue, scheduleMembershipJobs } from '../jobs/membership.queue';
import { createRedis } from '../plugins/redis';
import { closePushFlag } from '../services/push-flag.service';
import { closeFeatureFlags, getFlag } from '../services/feature-flags.service';
import { closeLineQuota } from '../services/line-quota.service';
import { writeJobLog } from '../services/job-log.service';
import { config } from '../config';

// Worker entry point — run as a separate process (npm run dev:worker / start:worker)
const uploadWorker = createUploadWorker();
const taskWorker = createTaskReminderWorker();
// Google Sheets sync — only spun up when the feature is configured, so an
// unconfigured deployment doesn't hold an idle Redis connection open for a
// queue nothing ever writes to.
const sheetsWorker = isGoogleSheetsConfigured() ? createSheetsWorker() : null;
// ระบบสมาชิก maintenance: quota-period cleanup, boost/subscription expiry,
// diary reminder sweep. Always constructed — none of it is feature-flagged.
const membershipWorker = createMembershipWorker();

// --- Throughput history (migration 060) ----------------------------------
//
// One job_log row per SETTLED job, on every queue. Attached HERE rather than
// inside each worker factory so the four queues cannot drift on what gets
// recorded, and so the individual workers' own listeners keep doing only what
// they already did (the upload worker's 'failed' handler, for instance, decides
// whether retries are exhausted and pushes an admin alert — an orthogonal job
// this must not entangle itself with). BullMQ allows any number of listeners
// per event, so adding these changes nothing about the existing ones.
//
// WHY THIS IS NEEDED AT ALL: every queue here settles jobs with a removeOn*
// policy, so BullMQ's own `completed` count measures the eviction policy rather
// than the work — see the header of services/job-log.service.ts.
//
// `job.name` is BullMQ's label; the job's own `type` discriminator is what an
// engineer thinks in, so the payload's type is preferred and the label is the
// fallback. Duration is finishedOn - processedOn; a job that never entered
// processing has neither and is logged with no duration (NULL, never 0).
//
// FIRE AND FORGET, and safe: writeJobLog never rejects, so `void` here cannot
// leave an unhandled rejection — which in this process would be fatal, because
// the handler below exits(1) on one.
function jobTypeOf(job: Job | undefined, fallback: string): string {
  const data = job?.data as { type?: unknown } | undefined;
  return typeof data?.type === 'string' ? data.type : (job?.name ?? fallback);
}

function durationOf(job: Job | undefined): number | undefined {
  if (!job?.finishedOn || !job.processedOn) return undefined;
  return job.finishedOn - job.processedOn;
}

function recordThroughput(queue: string, worker: Worker): void {
  worker.on('completed', (job) => {
    void writeJobLog({
      queue,
      jobName: jobTypeOf(job, 'unknown'),
      status: 'completed',
      durationMs: durationOf(job),
    });
  });
  worker.on('failed', (job) => {
    // Logged on EVERY failed attempt, not only the exhausted one. A job that
    // succeeds on its third try is a different health signal from one that
    // succeeds first time, and collapsing them would hide exactly the
    // degradation this table exists to show.
    void writeJobLog({
      queue,
      jobName: jobTypeOf(job, 'unknown'),
      status: 'failed',
      durationMs: durationOf(job),
    });
  });
}

// Keys match QUEUE_KEYS in services/queue-stats.service.ts, so the throughput
// chart and the queue-depth table on /admin/system name the same four things.
recordThroughput('file', uploadWorker);
recordThroughput('task', taskWorker);
if (sheetsWorker) recordThroughput('sheets', sheetsWorker);
recordThroughput('membership', membershipWorker);

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
// Membership maintenance schedule (monthly quota-period cleanup at 00:00 ICT on
// the 1st; daily expiry sweep; daily diary reminder). NOTE: the monthly quota
// RESET is structural — see jobs/quotaReset.job.ts — so a missed run here can
// never lock a user out of their new month's allowance.
scheduleMembershipJobs().catch((err) => {
  console.error('[worker] failed to schedule membership jobs:', err);
});

// Effective scan config, printed once per boot: a flipped scan_enhance_enabled
// silently ships unprocessed scans, and this line is what makes the running
// state auditable in the logs.
//
// The scan flags now come from `system_settings` (059 + 061), not from the
// per-service env vars, so this is a STARTING POSITION and says so: they can be
// flipped at runtime from /admin/system and the worker will pick that up on its
// next read without restarting. config.SCAN_DEFAULT_MODE and ENABLE_VIRUS_SCAN
// are still env — the first is a value, not a switch, and the second is ANDed
// with the presence of VIRUSTOTAL_API_KEY, which no flag can conjure.
void Promise.all([
  getFlag('scan_enhance_enabled', true),
  getFlag('scan_ocr_enabled', true),
  getFlag('diary_reminder_enabled', false),
  getFlag('diary_addon_enabled', true),
])
  .then(([scanEnhance, scanOcr, diaryReminder, diaryAddon]) => {
    console.log(
      `[worker] nookeb file worker started ` +
        `(scanEnhance=${scanEnhance} scanOcr=${scanOcr} diaryReminder=${diaryReminder} ` +
        `diaryAddon=${diaryAddon} scanDefaultMode=${config.SCAN_DEFAULT_MODE} ` +
        `virusScan=${config.ENABLE_VIRUS_SCAN} sheetsSync=${sheetsWorker !== null}) ` +
        `— DB-backed flags shown as resolved at boot; runtime value may differ`,
    );
  })
  .catch((err) => {
    console.warn('[worker] could not read DB-backed feature flags at boot:', err);
  });

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down...');
  healthServer.close();
  await uploadWorker.close();
  await taskWorker.close();
  await sheetsWorker?.close();
  await membershipWorker.close();
  await closeTaskQueue();
  await closeSheetsQueue();
  await closeMembershipQueue();
  await closeWorkerQueue();
  // The push kill switch keeps its own lazy Redis connection (opened on the
  // first pushMessage in this process, never at import). Left open it would
  // hold the event loop past process.exit's intent on a graceful stop.
  await closePushFlag().catch(() => {});
  // Same shape, same reason: the flag cache and the LINE-quota cache each open
  // a lazy Redis connection on first use and would hold the event loop open.
  await closeFeatureFlags().catch(() => {});
  await closeLineQuota().catch(() => {});
  await healthRedis.quit().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

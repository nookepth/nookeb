'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getAdminHealth,
  getAdminMembership,
  getAdminNotifications,
  getAdminQueues,
  getAdminQuotas,
  getAdminStuckFiles,
  getAdminSupportTickets,
  hasSession,
  type AdminAllowanceRow,
  type AdminFailedJob,
  type AdminHealth,
  type AdminMembership,
  type AdminNotifications,
  type AdminQueueKey,
  type AdminQueues,
  type AdminQuotas,
  type AdminStuckFiles,
  type AdminSupportTickets,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { StackedBars } from '../StackedBars';

/**
 * /admin/system — the OPERATIONS dashboard.
 *
 * /admin answers "how is the product doing". This page answers "is the machine
 * running". Two different questions with two different refresh rates, which is
 * why they are two pages: the queue and health blocks are LIVE-POLLED every
 * 10 s and are range-independent (a queue depth has no "last 30 days"), while
 * the notification and diary blocks are historical and follow the 7/30/90
 * selector. Mixing them onto one page would force one cadence onto both.
 *
 * Every endpoint behind this page fails soft server-side, so a panel renders
 * "—" or "ยังไม่มีข้อมูล" rather than taking the page down. The only errors that
 * reach the top-level banner are auth failures and transport failures.
 */

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const POLL_MS = 10_000;

const QUEUE_LABELS: Record<AdminQueueKey, string> = {
  file: 'ไฟล์ / สแกน / ไดอารี่',
  task: 'แจ้งเตือนงาน',
  sheets: 'Google Sheets',
  membership: 'ระบบสมาชิก',
};

const QUOTA_FEATURE_LABELS: Record<string, string> = {
  group_files: 'ไฟล์ในกลุ่ม',
  tasks: 'สร้างงาน',
  task_notifications: 'แจ้งเตือนงาน (push)',
  word_conversion_pages: 'แปลงไฟล์ (หน้า)',
  scans: 'สแกน',
  pdf_merges: 'รวมไฟล์',
  gift_boxes: 'กล่องของขวัญ',
  diary_reminders: 'เตือนไดอารี่',
};

const REMIND_TYPE_LABELS: Record<string, string> = {
  '3_days': 'ก่อน 3 วัน',
  '2_days': 'ก่อน 2 วัน',
  '1_day': 'ก่อน 1 วัน',
  '12_hours': 'ก่อน 12 ชม.',
  '6_hours': 'ก่อน 6 ชม.',
  '3_hours': 'ก่อน 3 ชม.',
  '1_hour': 'ก่อน 1 ชม.',
  '30_min': 'ก่อน 30 นาที',
  '15_min': 'ก่อน 15 นาที',
  '5_min': 'ก่อน 5 นาที',
  at_deadline: 'ถึงกำหนดพอดี',
  overdue: 'เลยกำหนด',
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

export default function AdminSystemPage() {
  const [days, setDays] = useState<Range>(30);
  const [error, setError] = useState<string | null>(null);

  // Live-polled (range-independent)
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [queues, setQueues] = useState<AdminQueues | null>(null);

  // Range-driven
  const [notifications, setNotifications] = useState<AdminNotifications | null>(null);

  // Loaded once
  const [quotas, setQuotas] = useState<AdminQuotas | null>(null);
  const [membership, setMembership] = useState<AdminMembership | null>(null);
  const [stuck, setStuck] = useState<AdminStuckFiles | null>(null);

  // Independently refreshed
  const [ticketStatus, setTicketStatus] = useState<string>('open');
  const [tickets, setTickets] = useState<AdminSupportTickets | null>(null);

  // Expand-on-demand, never auto-refreshed (see FailedJobsTable)
  const [failedJobs, setFailedJobs] = useState<Record<AdminQueueKey, AdminFailedJob[]> | null>(null);
  const [failedOpen, setFailedOpen] = useState(false);
  const [failedLoading, setFailedLoading] = useState(false);

  const report = useCallback((err: unknown): void => {
    if (err instanceof ApiError && err.status === 403) setError('คุณไม่มีสิทธิ์เข้าหน้าผู้ดูแล');
    else if (err instanceof ApiError && err.status === 401) setError('กรุณาเข้าสู่ระบบก่อน');
    else setError('โหลดข้อมูลไม่สำเร็จ');
  }, []);

  // --- Live poll: health + queues, every 10s. -------------------------------
  // The interval id is captured in the effect's own closure and cleared on
  // unmount AND on any re-run, so a fast unmount can never leave a timer firing
  // setState on a dead component. `cancelled` guards the in-flight request that
  // the clearInterval cannot reach.
  useEffect(() => {
    if (!hasSession()) {
      setError('กรุณาเข้าสู่ระบบก่อน');
      return;
    }
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const [h, q] = await Promise.all([getAdminHealth(), getAdminQueues(false)]);
        if (cancelled) return;
        setHealth(h);
        setQueues(q);
        setError(null);
      } catch (err) {
        if (!cancelled) report(err);
      }
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [report]);

  // --- Range-driven: notification + diary delivery. -------------------------
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const n = await getAdminNotifications(days);
        if (!cancelled) setNotifications(n);
      } catch (err) {
        if (!cancelled) report(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, report]);

  // --- Once on mount: quota pressure, membership, storage + stuck files. ----
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const [qt, mb, st] = await Promise.all([
          getAdminQuotas(),
          getAdminMembership(),
          getAdminStuckFiles(),
        ]);
        if (cancelled) return;
        setQuotas(qt);
        setMembership(mb);
        setStuck(st);
      } catch (err) {
        if (!cancelled) report(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [report]);

  // --- Support tickets, refetched when the status filter changes. -----------
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const t = await getAdminSupportTickets(ticketStatus);
        if (!cancelled) setTickets(t);
      } catch (err) {
        if (!cancelled) report(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketStatus, report]);

  async function toggleFailed(): Promise<void> {
    const next = !failedOpen;
    setFailedOpen(next);
    // Fetch only on the first expand. Failed jobs are a triage list, not a
    // live gauge — re-pulling 80 job payloads on a 10s timer would be pure
    // waste, and an admin reading a stack trace does not want the row to move.
    if (next && !failedJobs) {
      setFailedLoading(true);
      try {
        const q = await getAdminQueues(true);
        setFailedJobs(q.failed);
      } catch (err) {
        report(err);
      } finally {
        setFailedLoading(false);
      }
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>หนูเก็บ — ระบบและปฏิบัติการ</h1>
        <div className="topbar-actions">
          <a className="btn secondary" href="/admin">
            แดชบอร์ดผู้ดูแล
          </a>
          <a className="btn secondary" href="/dashboard">
            กลับคลังไฟล์
          </a>
        </div>
      </header>

      <main className="container" style={{ paddingBottom: 64 }}>
        {error && <p className="empty-state">{error}</p>}

        {!error && (
          <>
            <ServiceStatusStrip health={health} />

            <h2 className="admin-h2">คิวงาน (อัปเดตทุก 10 วินาที)</h2>
            <QueueHealthSection queues={queues} />

            <FailedJobsTable
              open={failedOpen}
              loading={failedLoading}
              jobs={failedJobs}
              onToggle={() => void toggleFailed()}
            />

            {/* Range applies to the notification + diary blocks ONLY. The
                queue/health blocks above are live and range-independent. */}
            <div style={S.rangeRow}>
              <span style={S.rangeLabel}>ช่วงเวลา (เฉพาะบล็อกแจ้งเตือน):</span>
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setDays(r)}
                  style={{ ...S.rangeBtn, ...(days === r ? S.rangeBtnActive : {}) }}
                >
                  {r} วัน
                </button>
              ))}
            </div>

            <NotificationDelivery data={notifications} days={days} />
            <FailedPushTable data={notifications} />
            <AllowanceBurndown data={notifications} />

            <QuotaPressureTable data={quotas} />
            <MembershipSection data={membership} />

            <SupportTicketTable
              data={tickets}
              status={ticketStatus}
              onStatusChange={setTicketStatus}
            />

            <StorageLedgerCards data={stuck} />
            <StuckFilesTable data={stuck} />
          </>
        )}
      </main>
    </>
  );
}

/* ========================================================================== */
/* Blocks                                                                      */
/* ========================================================================== */

/** Features 3–4 — API and worker liveness, side by side. */
function ServiceStatusStrip({ health }: { health: AdminHealth | null }) {
  if (!health) {
    return <p style={S.loading}>กำลังตรวจสอบสถานะ…</p>;
  }

  const api = health.api;
  const w = health.worker;
  // "not configured" is a THIRD state, never folded into down: an unset
  // WORKER_HEALTH_URL says nothing about whether the worker is alive.
  const workerTone: Tone = !w.configured ? 'muted' : w.healthy ? 'good' : 'bad';
  const workerText = !w.configured
    ? 'ยังไม่ได้ตั้งค่า'
    : w.reachable
      ? w.healthy
        ? 'ทำงานปกติ'
        : `มีปัญหา (${w.status})`
      : 'ติดต่อไม่ได้';

  return (
    <>
      <h2 className="admin-h2">สถานะบริการ</h2>
      <div style={S.stripGrid}>
        <StatusCard
          title="API"
          tone={api.healthy ? 'good' : 'bad'}
          text={api.healthy ? 'ทำงานปกติ' : 'มีปัญหา'}
          lines={[
            `Redis: ${api.checks.redis === 'ok' ? 'ปกติ' : 'ล้มเหลว'}`,
            `ฐานข้อมูล: ${api.checks.db === 'ok' ? 'ปกติ' : 'ล้มเหลว'}`,
            `commit: ${api.commit.slice(0, 7)}`,
          ]}
        />
        <StatusCard
          title="Worker"
          tone={workerTone}
          text={workerText}
          lines={[
            w.checks
              ? Object.entries(w.checks)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')
              : 'ไม่มีรายละเอียด',
            `commit: ${w.commit ? w.commit.slice(0, 7) : '—'}`,
            !w.configured ? 'ตั้ง WORKER_HEALTH_URL เพื่อเปิดการตรวจสอบ' : '',
          ].filter(Boolean)}
        />
        <StatusCard
          title="ตรวจล่าสุด"
          tone="muted"
          text={fmtDateTime(health.checkedAt)}
          lines={['รีเฟรชอัตโนมัติทุก 10 วินาที']}
        />
      </div>
    </>
  );
}

/** Features 1–2 (depth half) — one row per queue. */
function QueueHealthSection({ queues }: { queues: AdminQueues | null }) {
  if (!queues) return <p style={S.loading}>กำลังโหลดคิว…</p>;

  return (
    <>
      <div style={S.stripGrid}>
        <MiniStat label="งานค้างทั้งหมด" value={queues.backlog} tone={queues.backlog > 100 ? 'warn' : 'muted'} />
        <MiniStat
          label="งานล้มเหลวสะสม"
          value={queues.failedTotal}
          tone={queues.failedTotal > 0 ? 'bad' : 'good'}
        />
        <MiniStat label="คิวที่อ่านได้" value={`${queues.queues.filter((q) => q.ok).length}/${queues.queues.length}`} tone="muted" />
      </div>

      <div className="admin-table-wrap" style={{ marginTop: 12 }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>คิว</th>
              <th>รอ</th>
              <th>กำลังทำ</th>
              <th>ตั้งเวลา</th>
              <th>สำเร็จ</th>
              <th>ล้มเหลว</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {queues.queues.map((q) => (
              <tr key={q.key} style={q.ok ? undefined : S.rowBad}>
                <td>
                  {QUEUE_LABELS[q.key]}
                  <div style={S.subtle}>{q.name}</div>
                </td>
                <td>{q.ok ? q.waiting : '—'}</td>
                <td>{q.ok ? q.active : '—'}</td>
                <td>{q.ok ? q.delayed : '—'}</td>
                <td>{q.ok ? q.completed : '—'}</td>
                <td style={q.ok && q.failed > 0 ? S.badText : undefined}>{q.ok ? q.failed : '—'}</td>
                <td>{q.ok ? (q.paused > 0 ? 'หยุดชั่วคราว' : 'ปกติ') : (q.error ?? 'อ่านไม่ได้')}</td>
              </tr>
            ))}
            {queues.queues.length === 0 && (
              <tr>
                <td colSpan={7} style={S.emptyCell}>
                  อ่านคิวไม่ได้ — ตรวจสอบการเชื่อมต่อ Redis
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Feature 2 (detail half) — collapsed by default, fetched on first expand. */
function FailedJobsTable({
  open,
  loading,
  jobs,
  onToggle,
}: {
  open: boolean;
  loading: boolean;
  jobs: Record<AdminQueueKey, AdminFailedJob[]> | null;
  onToggle: () => void;
}) {
  const flat = jobs
    ? (Object.entries(jobs) as [AdminQueueKey, AdminFailedJob[]][]).flatMap(([key, list]) =>
        list.map((j) => ({ ...j, queue: key })),
      )
    : [];

  return (
    <>
      <div style={S.panelHead}>
        <h2 className="admin-h2" style={{ margin: '24px 0 12px' }}>
          งานที่ล้มเหลวล่าสุด
        </h2>
        <button type="button" className="btn secondary" onClick={onToggle}>
          {open ? 'ซ่อน' : 'ดูรายการ'}
        </button>
      </div>

      {open && (
        <>
          <p style={S.note}>
            20 รายการล่าสุดต่อคิว · ไม่รีเฟรชอัตโนมัติ (กด “ซ่อน” แล้วเปิดใหม่เพื่อโหลดซ้ำไม่ได้ —
            รีโหลดหน้าเพื่อดึงชุดใหม่)
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>คิว</th>
                  <th>งาน</th>
                  <th>ประเภท</th>
                  <th>พยายาม</th>
                  <th>สาเหตุ</th>
                  <th>ล้มเหลวเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={6} style={S.emptyCell}>
                      กำลังโหลด…
                    </td>
                  </tr>
                )}
                {!loading && flat.length === 0 && (
                  <tr>
                    <td colSpan={6} style={S.emptyCell}>
                      ไม่มีงานล้มเหลวค้างอยู่
                    </td>
                  </tr>
                )}
                {!loading &&
                  flat.map((j) => (
                    <tr key={`${j.queue}-${j.id}`}>
                      <td>{QUEUE_LABELS[j.queue]}</td>
                      <td>{j.name}</td>
                      <td>{j.jobType ?? '—'}</td>
                      <td>{j.attemptsMade}</td>
                      <td style={S.reasonCell}>{j.reason ?? '—'}</td>
                      <td>{fmtDateTime(j.failedAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** Features 5 + 8 — reminder outcomes and diary nudges, per day. */
function NotificationDelivery({ data, days }: { data: AdminNotifications | null; days: number }) {
  if (!data) return <p style={S.loading}>กำลังโหลดข้อมูลการแจ้งเตือน…</p>;

  const t = data.totals;
  return (
    <>
      <h2 className="admin-h2">การส่งแจ้งเตือนงาน ({days} วัน)</h2>
      <div style={S.stripGrid}>
        <MiniStat label="ตั้งเวลาไว้" value={t.scheduled} tone="muted" />
        <MiniStat label="ส่งสำเร็จ" value={t.sent} tone="good" />
        <MiniStat label="ล้มเหลว" value={t.failed} tone={t.failed > 0 ? 'bad' : 'muted'} />
        <MiniStat label="ยกเลิก (งานเสร็จก่อน)" value={t.cancelled} tone="muted" />
        <MiniStat
          label="ค้างไม่ได้ส่ง"
          value={t.pending}
          tone={t.pending > 0 ? 'warn' : 'muted'}
        />
        <MiniStat
          label="อัตราส่งสำเร็จ"
          value={data.deliveryRate === null ? '—' : `${data.deliveryRate}%`}
          tone={data.deliveryRate !== null && data.deliveryRate < 95 ? 'warn' : 'good'}
        />
      </div>

      <div style={S.card}>
        <p style={S.chartLabel}>ส่งสำเร็จ (เขียว) · ล้มเหลว (แดง) · ยกเลิก (เทา) · ค้าง (ส้ม)</p>
        <StackedBars
          data={data.daily}
          series={[
            { key: 'sent', color: 'var(--color-success, #16a34a)' },
            { key: 'failed', color: 'var(--color-danger, #dc2626)' },
            { key: 'cancelled', color: 'var(--color-text-muted, #9ca3af)' },
            { key: 'pending', color: '#f59e0b' },
          ]}
        />
      </div>

      <h2 className="admin-h2">หนูเก็บความทรงจำ — เตือนไดอารี่ ({days} วัน)</h2>
      <div style={S.card}>
        <p style={S.chartLabel}>
          ส่งจริง (เขียว) · ข้าม (เทา — เขียนไปแล้ว หรือ add-on หมดอายุ ไม่ใช่ความล้มเหลว)
        </p>
        <StackedBars
          data={data.diaryDaily}
          series={[
            { key: 'sent', color: 'var(--color-success, #16a34a)' },
            { key: 'skipped', color: 'var(--color-text-muted, #9ca3af)' },
          ]}
        />
      </div>
    </>
  );
}

/** Feature 6 — the push-failure triage queue. */
function FailedPushTable({ data }: { data: AdminNotifications | null }) {
  const rows = data?.failures ?? [];
  return (
    <>
      <h2 className="admin-h2">push ที่ล้มเหลว ({rows.length})</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>งาน</th>
              <th>สถานะงาน</th>
              <th>รอบเตือน</th>
              <th>กำหนดเตือน</th>
              <th>ล้มเหลวเมื่อ</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={S.emptyCell}>
                  ไม่มี push ที่ล้มเหลวในช่วงนี้
                </td>
              </tr>
            )}
            {rows.map((f) => (
              <tr key={f.id}>
                <td>{f.taskTitle ?? '—'}</td>
                <td>{f.taskStatus ?? '—'}</td>
                <td>{REMIND_TYPE_LABELS[f.remindType] ?? f.remindType}</td>
                <td>{fmtDateTime(f.remindAt)}</td>
                <td>{fmtDateTime(f.failedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Feature 7 — how much of this month's push allowance each user has burnt. */
function AllowanceBurndown({ data }: { data: AdminNotifications | null }) {
  const rows: AdminAllowanceRow[] = data?.allowance ?? [];
  return (
    <>
      <div style={S.panelHead}>
        <h2 className="admin-h2">โควตา push รายคน (เดือนปัจจุบัน)</h2>
        {data && <span style={S.note}>รีเซ็ต {fmtDateTime(data.resetAt)}</span>}
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ผู้ใช้</th>
              <th>แผน</th>
              <th>ใช้ไป</th>
              <th>เพดาน</th>
              <th style={{ width: '30%' }}>สัดส่วน</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={S.emptyCell}>
                  ยังไม่มีการใช้โควตาแจ้งเตือนในเดือนนี้
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.userId}>
                <td>{r.displayName ?? r.userId.slice(0, 8)}</td>
                <td>{r.plan ?? '—'}</td>
                <td>{r.used}</td>
                <td>{r.unlimited ? 'ไม่จำกัด' : r.limit}</td>
                <td>
                  {r.pctUsed === null ? (
                    <span style={S.subtle}>ไม่จำกัด</span>
                  ) : (
                    <Meter pct={r.pctUsed} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Feature 9 — who is about to hit a wall, and on which counter. */
function QuotaPressureTable({ data }: { data: AdminQuotas | null }) {
  if (!data) return <p style={S.loading}>กำลังโหลดโควตา…</p>;

  return (
    <>
      <div style={S.panelHead}>
        <h2 className="admin-h2">แรงกดดันโควตา (เดือนปัจจุบัน)</h2>
        <span style={S.note}>รีเซ็ต {fmtDateTime(data.resetAt)}</span>
      </div>
      {data.truncated && (
        <p style={S.note}>
          หมายเหตุ: อ่านข้อมูลถึงเพดานหน้าแล้ว ตัวเลขรวมเป็นค่าต่ำสุดที่เป็นไปได้ ไม่ใช่ยอดเต็ม
        </p>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ฟีเจอร์</th>
              <th>จำนวนแถว</th>
              <th>ใช้รวม</th>
              <th>ใกล้เต็ม (≥80%)</th>
              <th>เต็มแล้ว</th>
            </tr>
          </thead>
          <tbody>
            {data.byFeature.length === 0 && (
              <tr>
                <td colSpan={5} style={S.emptyCell}>
                  ยังไม่มีการใช้โควตาในเดือนนี้
                </td>
              </tr>
            )}
            {data.byFeature.map((f) => (
              <tr key={f.feature}>
                <td>{QUOTA_FEATURE_LABELS[f.feature] ?? f.feature}</td>
                <td>{f.rows}</td>
                <td>{f.totalUsed}</td>
                <td style={f.nearLimit > 0 ? S.warnText : undefined}>{f.nearLimit}</td>
                <td style={f.atLimit > 0 ? S.badText : undefined}>{f.atLimit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">รายคนที่ชนเพดาน / ใกล้ชน ({data.pressure.length})</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ผู้ใช้</th>
              <th>แผน</th>
              <th>ฟีเจอร์</th>
              <th>ใช้ / เพดาน</th>
              <th style={{ width: '28%' }}>สัดส่วน</th>
            </tr>
          </thead>
          <tbody>
            {data.pressure.length === 0 && (
              <tr>
                <td colSpan={5} style={S.emptyCell}>
                  ไม่มีใครใกล้ชนเพดานตอนนี้
                </td>
              </tr>
            )}
            {data.pressure.map((p) => (
              <tr key={`${p.userId}-${p.feature}-${p.scopeId}`} style={p.pctUsed >= 100 ? S.rowBad : undefined}>
                <td>
                  {p.displayName ?? p.userId.slice(0, 8)}
                  {p.scopeId && <div style={S.subtle}>กลุ่ม …{p.scopeId.slice(-6)}</div>}
                </td>
                <td>{p.plan ?? '—'}</td>
                <td>{QUOTA_FEATURE_LABELS[p.feature] ?? p.feature}</td>
                <td>
                  {p.used} / {p.limit}
                </td>
                <td>
                  <Meter pct={p.pctUsed} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Features 10–11 — plan mix, renewals, live boosts. */
function MembershipSection({ data }: { data: AdminMembership | null }) {
  if (!data) return <p style={S.loading}>กำลังโหลดข้อมูลสมาชิก…</p>;

  const r = data.renewals;
  return (
    <>
      <h2 className="admin-h2">สมาชิก — สัดส่วนแผน</h2>
      <div style={S.stripGrid}>
        {data.planMix.map((p) => (
          <MiniStat key={p.plan} label={p.plan} value={`${p.count} (${p.pct}%)`} tone="muted" />
        ))}
        <MiniStat label="ผู้ใช้ทั้งหมด" value={data.totalUsers} tone="muted" />
      </div>

      <h2 className="admin-h2">การต่ออายุ</h2>
      <div style={S.stripGrid}>
        <MiniStat label="สมาชิกที่ยัง active" value={r.activeSubscriptions} tone="muted" />
        <MiniStat
          label="ครบกำหนดใน 7 วัน"
          value={r.dueIn7Days}
          tone={r.dueIn7Days > 0 ? 'warn' : 'muted'}
        />
        <MiniStat label="ครบกำหนดใน 30 วัน" value={r.dueIn30Days} tone="muted" />
        <MiniStat
          label={r.mrrIsBounded ? 'MRR (อย่างน้อย)' : 'MRR โดยประมาณ'}
          value={`฿${r.mrrThb.toLocaleString('th-TH')}`}
          tone="muted"
        />
        <MiniStat label="add-on ไดอารี่ (active)" value={data.diaryAddonActive} tone="muted" />
      </div>
      {r.mrrIsBounded && (
        <p style={S.note}>
          MRR คำนวณจากรายการที่ดึงมาได้สูงสุด 50 แถว — เป็นค่าต่ำสุด ไม่ใช่ยอดจริงทั้งหมด
        </p>
      )}

      <h2 className="admin-h2">สมาชิกที่ใกล้ครบกำหนด</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ผู้ใช้</th>
              <th>แผน</th>
              <th>รอบ</th>
              <th>ราคา</th>
              <th>ครบกำหนด</th>
              <th>ยกเลิกเมื่อ</th>
            </tr>
          </thead>
          <tbody>
            {data.subscriptions.length === 0 && (
              <tr>
                <td colSpan={6} style={S.emptyCell}>
                  ยังไม่มีสมาชิกแบบชำระเงิน
                </td>
              </tr>
            )}
            {data.subscriptions.map((s) => (
              <tr key={s.id}>
                <td>{s.displayName ?? s.userId.slice(0, 8)}</td>
                <td>{s.plan}</td>
                <td>{s.billingCycle === 'yearly' ? 'รายปี' : 'รายเดือน'}</td>
                <td>฿{s.priceThb.toLocaleString('th-TH')}</td>
                <td>{fmtDateTime(s.currentPeriodEnd)}</td>
                <td>{s.cancelledAt ? fmtDateTime(s.cancelledAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">บูธกลุ่มที่ยังใช้งานอยู่ ({data.boosts.length})</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ผู้ใช้</th>
              <th>กลุ่ม</th>
              <th>เริ่ม</th>
              <th>หมดอายุ</th>
            </tr>
          </thead>
          <tbody>
            {data.boosts.length === 0 && (
              <tr>
                <td colSpan={4} style={S.emptyCell}>
                  ยังไม่มีบูธที่ใช้งานอยู่
                </td>
              </tr>
            )}
            {data.boosts.map((b) => (
              <tr key={b.id}>
                <td>{b.displayName ?? b.userId.slice(0, 8)}</td>
                {/* Group NAMES do not exist in this schema — the LINE group id
                    is the tenant key, so the last 6 chars are the only handle. */}
                <td>…{b.groupId.slice(-6)}</td>
                <td>{fmtDateTime(b.activatedAt)}</td>
                <td>{fmtDateTime(b.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Feature 12 — the SLA queue. Breached rows are tinted red. */
function SupportTicketTable({
  data,
  status,
  onStatusChange,
}: {
  data: AdminSupportTickets | null;
  status: string;
  onStatusChange: (s: string) => void;
}) {
  const STATUSES: { key: string; label: string }[] = [
    { key: 'open', label: 'เปิดอยู่' },
    { key: 'answered', label: 'ตอบแล้ว' },
    { key: 'closed', label: 'ปิดแล้ว' },
  ];

  return (
    <>
      <div style={S.panelHead}>
        <h2 className="admin-h2">
          ตั๋วซัพพอร์ต{data ? ` (${data.tickets.length})` : ''}
          {data && data.breachedCount > 0 && (
            <span style={{ ...S.badgeBad, marginLeft: 8 }}>เกิน SLA {data.breachedCount}</span>
          )}
        </h2>
        <div style={S.rangeRow}>
          {STATUSES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onStatusChange(s.key)}
              style={{ ...S.rangeBtn, ...(status === s.key ? S.rangeBtnActive : {}) }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <p style={S.note}>
        อ่านอย่างเดียว — การตอบตั๋วยังไม่มีในระบบ (routes /support/* ยังปิดอยู่ที่ 503)
      </p>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>เรื่อง</th>
              <th>ผู้ใช้</th>
              <th>แผนตอนเปิด</th>
              <th>SLA</th>
              <th>ครบกำหนด</th>
              <th>เหลือ (ชม.)</th>
              <th>ตอบแล้ว</th>
            </tr>
          </thead>
          <tbody>
            {(!data || data.tickets.length === 0) && (
              <tr>
                <td colSpan={7} style={S.emptyCell}>
                  ไม่มีตั๋วในสถานะนี้
                </td>
              </tr>
            )}
            {data?.tickets.map((t) => (
              <tr key={t.id} style={t.breached ? S.rowBad : undefined}>
                <td>
                  {t.subject}
                  {t.onboardingCall && <div style={S.subtle}>ขอ onboarding call</div>}
                </td>
                <td>{t.displayName ?? t.userId.slice(0, 8)}</td>
                <td>{t.planAtCreation}</td>
                <td>{t.slaHours} ชม.</td>
                <td>{fmtDateTime(t.dueAt)}</td>
                <td style={t.breached ? S.badText : undefined}>
                  {t.breached ? 'เกินแล้ว' : t.hoursRemaining}
                </td>
                <td>{t.firstResponseAt ? fmtDateTime(t.firstResponseAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Feature 15 — whole-system storage ledger. */
function StorageLedgerCards({ data }: { data: AdminStuckFiles | null }) {
  if (!data) return <p style={S.loading}>กำลังโหลดบัญชีพื้นที่…</p>;
  const l = data.ledger;

  if (!l.available) {
    return (
      <>
        <h2 className="admin-h2">บัญชีพื้นที่จัดเก็บ</h2>
        <p style={S.note}>
          ยังอ่านไม่ได้ — ต้องรัน migration 058 (admin_storage_totals) ใน Supabase ก่อน
        </p>
      </>
    );
  }

  const fillPct =
    l.storageLimitSum > 0 ? Math.round((l.storageUsedSum / l.storageLimitSum) * 100) : 0;

  return (
    <>
      <h2 className="admin-h2">บัญชีพื้นที่จัดเก็บ</h2>
      <div style={S.stripGrid}>
        <MiniStat label="ไฟล์ในคลัง" value={`${l.liveFiles} · ${formatBytes(l.liveBytes)}`} tone="muted" />
        <MiniStat
          label="อยู่ในถังขยะ"
          value={`${l.trashedFiles} · ${formatBytes(l.trashedBytes)}`}
          tone="muted"
        />
        <MiniStat label="ลบถาวรแล้ว" value={l.purgedFiles} tone="muted" />
        <MiniStat
          label="ห้องนิรภัย"
          value={`${l.vaultLiveFiles} · ${formatBytes(l.vaultLiveBytes)}`}
          tone="muted"
        />
        <MiniStat
          label="ค้างประมวลผล"
          value={l.processingFiles}
          tone={l.processingFiles > 0 ? 'warn' : 'good'}
        />
        <MiniStat label="ไฟล์ error" value={l.errorFiles} tone={l.errorFiles > 0 ? 'bad' : 'good'} />
        <MiniStat
          label="ผู้ใช้ใกล้เต็ม (≥80%)"
          value={l.usersOver80}
          tone={l.usersOver80 > 0 ? 'warn' : 'muted'}
        />
        <MiniStat
          label="ผู้ใช้เต็มแล้ว"
          value={l.usersOverLimit}
          tone={l.usersOverLimit > 0 ? 'bad' : 'muted'}
        />
        <MiniStat
          label="ใช้รวม / โควตารวม"
          value={`${formatBytes(l.storageUsedSum)} / ${formatBytes(l.storageLimitSum)} (${fillPct}%)`}
          tone="muted"
        />
      </div>
    </>
  );
}

/** Feature 14 — uploads wedged mid-pipeline, plus the error tail. */
function StuckFilesTable({ data }: { data: AdminStuckFiles | null }) {
  const stuck = data?.stuck ?? [];
  const errored = data?.errored ?? [];

  return (
    <>
      <h2 className="admin-h2">ไฟล์ที่ค้างในไปป์ไลน์ ({stuck.length})</h2>
      <p style={S.note}>
        ค้างเกิน {data?.thresholdMinutes ?? 30} นาทีในสถานะ pending/processing — มักแปลว่า worker
        ตายกลางงาน ซึ่งจะไม่ทิ้ง failed job ไว้ใน Redis ให้เห็น
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ชื่อไฟล์</th>
              <th>สถานะ</th>
              <th>ขนาด</th>
              <th>ที่มา</th>
              <th>ค้างมา (นาที)</th>
              <th>สร้างเมื่อ</th>
            </tr>
          </thead>
          <tbody>
            {stuck.length === 0 && (
              <tr>
                <td colSpan={6} style={S.emptyCell}>
                  ไม่มีไฟล์ค้าง
                </td>
              </tr>
            )}
            {stuck.map((f) => (
              <tr key={f.id} style={f.stuckMinutes > 180 ? S.rowBad : undefined}>
                <td>{f.name}</td>
                <td>{f.status}</td>
                <td>{formatBytes(f.bytes)}</td>
                <td>{f.lineSource ?? '—'}</td>
                <td>{f.stuckMinutes}</td>
                <td>{fmtDateTime(f.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">ไฟล์สถานะ error ({errored.length})</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ชื่อไฟล์</th>
              <th>ขนาด</th>
              <th>สร้างเมื่อ</th>
            </tr>
          </thead>
          <tbody>
            {errored.length === 0 && (
              <tr>
                <td colSpan={3} style={S.emptyCell}>
                  ไม่มีไฟล์ error
                </td>
              </tr>
            )}
            {errored.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{formatBytes(f.bytes)}</td>
                <td>{fmtDateTime(f.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ========================================================================== */
/* Small presentational pieces                                                 */
/* ========================================================================== */

type Tone = 'good' | 'warn' | 'bad' | 'muted';

const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--color-success, #16a34a)',
  warn: '#b45309',
  bad: 'var(--color-danger, #dc2626)',
  muted: 'var(--color-text-primary)',
};

function StatusCard({
  title,
  tone,
  text,
  lines,
}: {
  title: string;
  tone: Tone;
  text: string;
  lines: string[];
}) {
  return (
    <div style={S.card}>
      <div style={S.kpiLabel}>{title}</div>
      <div style={{ ...S.statusText, color: TONE_COLOR[tone] }}>
        <span style={{ ...S.dot, background: TONE_COLOR[tone] }} />
        {text}
      </div>
      {lines.map((l, i) => (
        <div key={i} style={S.kpiHint}>
          {l}
        </div>
      ))}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: number | string;
  tone?: Tone;
}) {
  return (
    <div style={S.card}>
      <div style={S.kpiLabel}>{label}</div>
      <div style={{ ...S.kpiValue, color: TONE_COLOR[tone] }}>{value}</div>
    </div>
  );
}

/** Percentage bar. Colour crosses to warn at 80 and bad at 100. */
function Meter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone: Tone = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good';
  return (
    <div style={S.meterRow}>
      <div style={S.meterTrack}>
        <div style={{ ...S.meterFill, width: `${clamped}%`, background: TONE_COLOR[tone] }} />
      </div>
      <span style={S.meterPct}>{pct}%</span>
    </div>
  );
}

/* ---------- inline style tokens (reuse global CSS variables) ----------
   Only tokens NOT already covered by globals.css live here: tables, table
   wrappers and section headings all use .admin-table / .admin-table-wrap /
   .admin-h2. This mirrors the same-named object in admin/page.tsx. */

const S: Record<string, React.CSSProperties> = {
  rangeRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0', flexWrap: 'wrap' },
  rangeLabel: { color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' },
  rangeBtn: {
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-full)',
    padding: '6px 14px',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
  },
  rangeBtnActive: {
    background: 'var(--color-primary)',
    color: '#fff',
    borderColor: 'var(--color-primary)',
  },
  stripGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: 12,
    marginBottom: 8,
  },
  card: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    padding: 16,
    boxShadow: 'var(--shadow-sm)',
  },
  kpiLabel: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    marginBottom: 6,
  },
  kpiValue: { fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.15 },
  kpiHint: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 },
  statusText: {
    fontSize: 'var(--font-size-base)',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  panelHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  note: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 8px' },
  subtle: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' },
  loading: { color: 'var(--color-text-muted)', padding: '16px 0' },
  emptyCell: { textAlign: 'center', color: 'var(--color-text-muted)' },
  chartLabel: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    marginBottom: 8,
  },
  reasonCell: { maxWidth: 380, fontSize: 'var(--font-size-xs)', wordBreak: 'break-word' },
  // Row tints. Kept as a translucent overlay so the .admin-table border and
  // hover styling from globals.css still read through.
  rowBad: { background: 'rgba(220, 38, 38, 0.08)' },
  badText: { color: 'var(--color-danger, #dc2626)', fontWeight: 600 },
  warnText: { color: '#b45309', fontWeight: 600 },
  badgeBad: {
    background: 'rgba(220, 38, 38, 0.12)',
    color: 'var(--color-danger, #dc2626)',
    borderRadius: 'var(--radius-full)',
    padding: '2px 10px',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
  },
  meterRow: { display: 'flex', alignItems: 'center', gap: 8 },
  meterTrack: {
    flex: 1,
    height: 8,
    background: 'var(--color-surface-3)',
    borderRadius: 'var(--radius-full)',
    overflow: 'hidden',
    minWidth: 60,
  },
  meterFill: { height: '100%', borderRadius: 'var(--radius-full)', transition: 'width 300ms ease' },
  meterPct: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', minWidth: 34 },
};

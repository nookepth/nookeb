'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  adminGetSettings,
  adminRemoveJob,
  adminRetryJob,
  adminSetFlag,
  adminSetPushEnabled,
  adminStartR2Reconcile,
  adminUpdateTicket,
  ApiError,
  getAdminFlags,
  getAdminHealth,
  getAdminJobThroughput,
  getAdminLineQuota,
  getAdminMembership,
  getAdminNotifications,
  getAdminPushLog,
  getAdminQueues,
  getAdminQuotas,
  getAdminR2ReconcileStatus,
  getAdminStuckFiles,
  getAdminSupportTickets,
  hasSession,
  type AdminAllowanceRow,
  type AdminFailedJob,
  type AdminFlagKey,
  type AdminHealth,
  type AdminJobThroughput,
  type AdminLineQuota,
  type AdminMembership,
  type AdminNotifications,
  type AdminPushLog,
  type AdminQueueKey,
  type AdminQueues,
  type AdminQuotas,
  type AdminR2ReconcileStatus,
  type AdminStuckFiles,
  type AdminSupportTicket,
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
  const [pushLog, setPushLog] = useState<AdminPushLog | null>(null);
  const [throughput, setThroughput] = useState<AdminJobThroughput | null>(null);

  // Loaded once
  const [quotas, setQuotas] = useState<AdminQuotas | null>(null);
  const [membership, setMembership] = useState<AdminMembership | null>(null);
  const [stuck, setStuck] = useState<AdminStuckFiles | null>(null);
  const [lineQuota, setLineQuota] = useState<AdminLineQuota | null>(null);

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

  // --- Range-driven: notification + diary delivery, push log, throughput. ---
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        // Independently settled: the three TIER 3 panels below are newer than
        // the notification block and their tables may not exist yet on an
        // environment where migration 060 has not been applied. One unapplied
        // migration must not blank a panel that predates it.
        const [n, p, t] = await Promise.allSettled([
          getAdminNotifications(days),
          getAdminPushLog(days),
          getAdminJobThroughput(Math.min(days, 90)),
        ]);
        if (cancelled) return;
        if (n.status === 'fulfilled') setNotifications(n.value);
        else report(n.reason);
        if (p.status === 'fulfilled') setPushLog(p.value);
        if (t.status === 'fulfilled') setThroughput(t.value);
      } catch (err) {
        if (!cancelled) report(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, report]);

  // --- Once on mount: quota pressure, membership, storage, LINE allowance. --
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const [qt, mb, st, lq] = await Promise.all([
          getAdminQuotas(),
          getAdminMembership(),
          getAdminStuckFiles(),
          getAdminLineQuota(),
        ]);
        if (cancelled) return;
        setQuotas(qt);
        setMembership(mb);
        setStuck(st);
        setLineQuota(lq);
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

  /**
   * Drop one job from the local failed list after a successful retry or remove.
   *
   * Removing the row rather than re-fetching is deliberate: a re-fetch would
   * re-order every other row under the admin's cursor mid-triage, and both
   * outcomes genuinely mean "this job is no longer in the failed set".
   */
  function dropFailedJob(queue: AdminQueueKey, jobId: string): void {
    setFailedJobs((prev) => {
      if (!prev) return prev;
      return { ...prev, [queue]: prev[queue].filter((j) => j.id !== jobId) };
    });
  }

  /** Replace one ticket in place after a PATCH — the filter and order stay put. */
  function patchTicket(updated: AdminSupportTicket): void {
    setTickets((prev) =>
      prev ? { ...prev, tickets: prev.tickets.map((t) => (t.id === updated.id ? updated : t)) } : prev,
    );
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
            {/* Top of the page and always visible: during an incident this is
                the control an admin came here to reach, and it must never be
                below a fold or behind an expander. */}
            <PushToggle onError={report} />

            {/* Directly under the kill switch, because they answer the same
                question from the other side: the switch is why WE stopped
                sending, this card is why LINE would. */}
            <LineQuotaCard data={lineQuota} />

            <FeatureFlagsPanel onError={report} />

            <ServiceStatusStrip health={health} />

            <h2 className="admin-h2">คิวงาน (อัปเดตทุก 10 วินาที)</h2>
            <QueueHealthSection queues={queues} />

            <FailedJobsTable
              open={failedOpen}
              loading={failedLoading}
              jobs={failedJobs}
              onToggle={() => void toggleFailed()}
              onResolved={dropFailedJob}
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

            <PushLogSection data={pushLog} days={days} />
            <JobThroughputSection data={throughput} days={days} />

            <QuotaPressureTable data={quotas} />
            <MembershipSection data={membership} />

            <SupportTicketTable
              data={tickets}
              status={ticketStatus}
              onStatusChange={setTicketStatus}
              onTicketUpdated={patchTicket}
            />

            <StorageLedgerCards data={stuck} />
            <StuckFilesTable data={stuck} />

            <R2ReconcilePanel onError={report} />
          </>
        )}
      </main>
    </>
  );
}

/* ========================================================================== */
/* Blocks                                                                      */
/* ========================================================================== */

/**
 * The global LINE push kill switch (migration 059).
 *
 * Reads its own state rather than taking it from the page's poll: this is the
 * one control whose displayed position must be the SERVER's, and folding it
 * into the 10 s tick would repaint the switch under an admin's finger.
 *
 * OPTIMISTIC WITH ROLLBACK. The button flips immediately and reverts if the PUT
 * fails — a toggle that sits inert for a round trip during an incident invites
 * a second click, and a second click on a kill switch is the last thing anyone
 * wants. `pending` blocks that second click regardless.
 *
 * Only turning push OFF is confirmed. Turning it back ON restores the product's
 * normal behaviour and needs no ceremony; asking "are you sure you want things
 * to work?" trains people to click through the dialog that matters.
 */
function PushToggle({ onError }: { onError: (err: unknown) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await adminGetSettings();
        if (!cancelled) {
          setEnabled(s.push_enabled);
          setFailed(false);
        }
      } catch (err) {
        // Local, not the page banner: an unreadable switch must not blank every
        // other panel on an ops page.
        if (!cancelled) setFailed(true);
        if (!cancelled && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          onError(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function toggle(): Promise<void> {
    if (enabled === null || pending) return;
    const next = !enabled;
    if (!next && !window.confirm('ยืนยันปิด push ทั้งระบบ?')) return;

    const previous = enabled;
    setEnabled(next);
    setPending(true);
    try {
      const res = await adminSetPushEnabled(next);
      // Trust the server's answer over the optimistic guess.
      setEnabled(res.push_enabled);
      setFailed(false);
    } catch (err) {
      setEnabled(previous);
      setFailed(true);
      onError(err);
    } finally {
      setPending(false);
    }
  }

  const on = enabled === true;
  const label =
    enabled === null
      ? failed
        ? 'อ่านสถานะ push ไม่สำเร็จ'
        : 'กำลังอ่านสถานะ push…'
      : on
        ? 'Push เปิดอยู่ — กดเพื่อปิด'
        : 'Push ปิดอยู่ — กดเพื่อเปิด';

  return (
    <div style={{ ...S.card, ...P.wrap, ...(enabled === false ? P.wrapOff : {}) }}>
      <div>
        <div style={S.kpiLabel}>สวิตช์ push ทั้งระบบ</div>
        <div style={{ ...S.statusText, color: enabled === null ? 'var(--color-text-muted)' : undefined }}>
          <span
            style={{
              ...S.dot,
              background: enabled === null ? 'var(--color-text-muted)' : on ? '#16a34a' : '#dc2626',
            }}
          />
          {label}
        </div>
        <p style={S.kpiHint}>
          ปิดแล้วจะไม่มี push ออกจากระบบเลย (แจ้งเตือนงาน / ประกาศงานใหม่ / ตีกลับ-รับงาน) —
          มีผลทั้ง API และ worker ภายใน 60 วินาที · งานที่ตั้งเวลาไว้ยังอยู่ครบ ไม่ถูกลบ
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={enabled === null || pending}
        onClick={() => void toggle()}
        style={{
          ...P.track,
          background: enabled === null ? 'var(--color-surface-3)' : on ? '#16a34a' : '#dc2626',
          opacity: enabled === null || pending ? 0.6 : 1,
          cursor: enabled === null || pending ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{ ...P.knob, transform: on ? 'translateX(24px)' : 'translateX(0)' }} />
      </button>
    </div>
  );
}

/**
 * Feature 28 — LINE's OWN monthly push allowance.
 *
 * Every other quota surface on this page is the product's own accounting. This
 * is the one number that belongs to LINE, and it is the one that decides
 * whether messaging silently stops mid-month: the allowance fails SILENTLY when
 * spent, so nothing in the product notices until users report missing reminders.
 *
 * THREE STATES, and the third is not an error to hide. 'none' means we could
 * not find out, and it renders as "—" with a plain explanation rather than as a
 * zero. A card that says "0 remaining" because the token was rejected is the
 * most alarming thing this panel could display, from the one condition where it
 * knows nothing at all.
 */
function LineQuotaCard({ data }: { data: AdminLineQuota | null }) {
  if (!data) return <p style={S.loading}>กำลังอ่านโควตา push ของ LINE…</p>;

  const known = data.type === 'limited';
  const pct = known && data.limit && data.limit > 0
    ? Math.min(100, Math.round((data.consumed / data.limit) * 100))
    : null;

  return (
    <div style={{ ...S.card, marginBottom: 16 }}>
      <div style={S.panelHead}>
        <div style={S.kpiLabel}>โควตา push ของ LINE (เดือนนี้)</div>
        <span style={S.subtle}>อ่านเมื่อ {fmtDateTime(data.fetchedAt)} · แคช 5 นาที</span>
      </div>

      {data.type === 'none' && (
        <>
          <div style={{ ...S.kpiValue, color: 'var(--color-text-muted)' }}>—</div>
          <p style={S.kpiHint}>
            อ่านค่าจาก LINE ไม่สำเร็จ (เครือข่าย หรือ token ไม่ผ่าน) — ไม่ได้แปลว่าโควตาหมด
          </p>
        </>
      )}

      {data.type === 'unlimited' && (
        <>
          <div style={{ ...S.kpiValue, color: TONE_COLOR.good }}>ไม่จำกัด</div>
          <p style={S.kpiHint}>ส่งไปแล้ว {data.consumed.toLocaleString('th-TH')} ข้อความเดือนนี้</p>
        </>
      )}

      {known && (
        <>
          <div style={S.kpiValue}>
            {data.consumed.toLocaleString('th-TH')} / {(data.limit ?? 0).toLocaleString('th-TH')}
          </div>
          {pct !== null && <Meter pct={pct} />}
          <p style={S.kpiHint}>
            เหลือ {(data.remaining ?? 0).toLocaleString('th-TH')} ข้อความ ·
            โควตาหมดแล้ว push จะล้มเหลวเงียบ ๆ (LINE ตอบ 429) — ระบบจะบันทึกเป็น
            blocked_quota ในบันทึก push ด้านล่าง
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Feature 29 — the runtime switches (migrations 059 + 061).
 *
 * DELIBERATELY EXCLUDES push_enabled, which has its own control at the top of
 * the page. The endpoint returns it and this panel could render it, but the
 * kill switch earns a full-width card with a confirm dialog and a red wash —
 * demoting it into a row of six identical toggles would make the product's most
 * consequential control look like a preference.
 *
 * OPTIMISTIC WITH ROLLBACK, per row, same as the push toggle: an inert switch
 * during an incident invites a second click. `pending` blocks that click
 * regardless, per key, so one slow request does not freeze the others.
 *
 * `stale` keys are marked: a switch showing its fallback because the row could
 * not be read must not silently claim to be the server's position.
 */
const FLAG_LABELS: Record<string, { title: string; hint: string }> = {
  diary_reminder_enabled: {
    title: 'เตือนไดอารี่ (§17)',
    hint: 'push เตือนเขียนไดอารี่ตามแผน · เปิด/ปิดจะลงทะเบียนตารางงานรายชั่วโมงใหม่ทันที',
  },
  diary_addon_enabled: {
    title: 'หนูเก็บความทรงจำ (แอดออน)',
    hint: 'sweep รายชั่วโมงของแอดออนแบบเสียเงิน · ปิดแล้วตารางงานจะถูกถอดออก',
  },
  scan_enhance_enabled: {
    title: 'ปรับภาพสแกน',
    hint: 'ตัดขอบ + แก้เพอร์สเปกทีฟ + ปรับแสง · ปิดแล้วหน้าสแกนจะถูกเก็บเป็นรูปดิบ',
  },
  scan_ocr_enabled: {
    title: 'ชั้นข้อความ OCR ใน PDF',
    hint: 'ทำให้ PDF ที่สแกนค้นหาข้อความได้ · กิน CPU ของ worker ทุกหน้า',
  },
  virus_scan_enabled: {
    title: 'สแกนไวรัสไฟล์อัปโหลด',
    hint: 'ต้องมี VIRUSTOTAL_API_KEY ด้วย — เปิดสวิตช์อย่างเดียวไม่พอ',
  },
};

const PANEL_FLAG_KEYS: AdminFlagKey[] = [
  'diary_reminder_enabled',
  'diary_addon_enabled',
  'scan_enhance_enabled',
  'scan_ocr_enabled',
  'virus_scan_enabled',
];

function FeatureFlagsPanel({ onError }: { onError: (err: unknown) => void }) {
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getAdminFlags();
        if (cancelled) return;
        setFlags(res.flags);
        setStale(res.stale);
        setFailed(false);
      } catch (err) {
        if (cancelled) return;
        setFailed(true);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) onError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function toggle(key: AdminFlagKey): Promise<void> {
    if (!flags || pending) return;
    const previous = flags[key] ?? false;
    const next = !previous;

    setFlags({ ...flags, [key]: next });
    setPending(key);
    setNote(null);
    try {
      const res = await adminSetFlag(key, next);
      setFlags((prev) => (prev ? { ...prev, [key]: res.enabled } : prev));
      // A key that has just been written is no longer showing a fallback.
      setStale((prev) => prev.filter((k) => k !== key));
      // The one half-applied outcome the API can report. Surfaced rather than
      // swallowed: the flag is saved, the schedule is not, and only a worker
      // restart closes the gap.
      if (res.scheduleUpdated === false) {
        setNote(
          'บันทึกสวิตช์แล้ว แต่ยังอัปเดตตารางงานใน Redis ไม่สำเร็จ — จะตรงกันอีกครั้งเมื่อ worker รีสตาร์ต',
        );
      }
      setFailed(false);
    } catch (err) {
      setFlags((prev) => (prev ? { ...prev, [key]: previous } : prev));
      setFailed(true);
      onError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <h2 className="admin-h2">สวิตช์ระบบ (มีผลทั้ง API และ worker ภายใน 60 วินาที)</h2>
      <p style={S.note}>
        เก็บใน <code>system_settings</code> ไม่ใช่ env — เปลี่ยนแล้วมีผลทันทีโดยไม่ต้อง deploy ใหม่ ·
        ทุกครั้งที่กดจะถูกบันทึกใน <code>admin_audit_log</code>
      </p>

      {failed && flags === null && <p style={S.loading}>อ่านสถานะสวิตช์ไม่สำเร็จ</p>}
      {!failed && flags === null && <p style={S.loading}>กำลังอ่านสถานะสวิตช์…</p>}
      {note && <p style={{ ...S.note, ...S.warnText }}>{note}</p>}

      {flags && (
        <div style={S.stripGrid}>
          {PANEL_FLAG_KEYS.map((key) => {
            const on = flags[key] === true;
            const busy = pending === key;
            const isStale = stale.includes(key);
            const meta = FLAG_LABELS[key];
            return (
              <div key={key} style={{ ...S.card, ...F.flagCard }}>
                <div style={F.flagHead}>
                  <div>
                    <div style={S.kpiLabel}>{meta?.title ?? key}</div>
                    <div style={{ ...S.statusText, color: on ? TONE_COLOR.good : TONE_COLOR.bad }}>
                      <span
                        style={{ ...S.dot, background: on ? TONE_COLOR.good : TONE_COLOR.bad }}
                      />
                      {on ? 'เปิด' : 'ปิด'}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${meta?.title ?? key}: ${on ? 'เปิด' : 'ปิด'}`}
                    disabled={busy}
                    onClick={() => void toggle(key)}
                    style={{
                      ...P.track,
                      background: on ? '#16a34a' : '#dc2626',
                      opacity: busy ? 0.6 : 1,
                      cursor: busy ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <span
                      style={{ ...P.knob, transform: on ? 'translateX(24px)' : 'translateX(0)' }}
                    />
                  </button>
                </div>
                <p style={S.kpiHint}>{meta?.hint ?? ''}</p>
                {isStale && (
                  <p style={{ ...S.kpiHint, ...S.warnText }}>
                    อ่านค่าจริงไม่ได้ — กำลังแสดงค่าเริ่มต้น
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Feature 27 — the push log (migration 060).
 *
 * The three columns that matter are the STATUSES, and the two "blocked" ones
 * are the reason the table exists: a push suppressed by the kill switch returns
 * normally by design, and a push refused because LINE's allowance is spent
 * looks like an ordinary 429. Neither left any trace before this.
 *
 * They are shown as separate figures from `failed`, never folded in — a
 * deliberate silence is not an outage, and the delivery rate would collapse and
 * read as one.
 */
const PUSH_CONTEXT_LABELS: Record<string, string> = {
  task_reminder: 'เตือนงาน (ตั้งเวลา)',
  task_notify: 'แจ้งเตือนงาน (ประกาศ/ตีกลับ/รับงาน)',
  diary_sweep: 'เตือนไดอารี่ (§17)',
  diary_addon: 'หนูเก็บความทรงจำ',
  admin_alert: 'แจ้งเตือนผู้ดูแล',
};

const PUSH_STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: 'ส่งแล้ว', tone: 'good' },
  failed: { label: 'ล้มเหลว', tone: 'bad' },
  blocked_quota: { label: 'โควตาหมด', tone: 'bad' },
  blocked_flag: { label: 'ถูกปิดสวิตช์', tone: 'warn' },
};

function PushLogSection({ data, days }: { data: AdminPushLog | null; days: number }) {
  if (!data) {
    return (
      <>
        <h2 className="admin-h2">บันทึกการส่ง push</h2>
        <p style={S.loading}>ยังไม่มีข้อมูล (ต้อง apply migration 060 ก่อน)</p>
      </>
    );
  }

  const t = data.totals;
  return (
    <>
      <h2 className="admin-h2">บันทึกการส่ง push ({days} วัน)</h2>
      <p style={S.note}>
        ทุก push ที่ระบบพยายามส่ง รวมถึงที่ถูกปิดสวิตช์และที่โควตา LINE หมด —
        สองอย่างหลังไม่นับเป็น &quot;ล้มเหลว&quot; เพราะไม่ได้พัง
        {data.truncated && ' · แสดงเฉพาะ 200 รายการล่าสุด'}
      </p>

      <div style={S.stripGrid}>
        <MiniStat label="ส่งสำเร็จ" value={t.sent} tone="good" />
        <MiniStat label="ล้มเหลว" value={t.failed} tone={t.failed > 0 ? 'bad' : 'muted'} />
        <MiniStat
          label="โควตา LINE หมด"
          value={t.blocked_quota}
          tone={t.blocked_quota > 0 ? 'bad' : 'muted'}
        />
        <MiniStat
          label="ถูกปิดสวิตช์"
          value={t.blocked_flag}
          tone={t.blocked_flag > 0 ? 'warn' : 'muted'}
        />
        <MiniStat
          label="อัตราส่งถึง"
          value={data.deliveryRate === null ? '—' : `${data.deliveryRate}%`}
          tone={data.deliveryRate !== null && data.deliveryRate < 90 ? 'warn' : 'muted'}
        />
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>เวลา</th>
              <th>ปลายทาง</th>
              <th>ที่มา</th>
              <th>สถานะ</th>
              <th style={{ textAlign: 'right' }}>ข้อความ</th>
              <th>รายละเอียด</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.length === 0 && (
              <tr>
                <td colSpan={6} style={S.emptyCell}>
                  ยังไม่มี push ในช่วงนี้
                </td>
              </tr>
            )}
            {data.entries.map((e) => {
              const meta = PUSH_STATUS_LABELS[e.status] ?? { label: e.status, tone: 'muted' as Tone };
              return (
                <tr key={e.id} style={meta.tone === 'bad' ? S.rowBad : undefined}>
                  <td>{fmtDateTime(e.createdAt)}</td>
                  <td>
                    {/* Kind, then a short id. The full LINE id is not shown:
                        it identifies a person or a group and the last few
                        characters are enough to correlate with a report. */}
                    {e.toKind} · …{e.toId.slice(-6)}
                  </td>
                  <td>{PUSH_CONTEXT_LABELS[e.context] ?? e.context}</td>
                  <td style={{ color: TONE_COLOR[meta.tone], fontWeight: 600 }}>{meta.label}</td>
                  <td style={{ textAlign: 'right' }}>{e.messageCount}</td>
                  <td style={S.reasonCell}>
                    {e.httpStatus !== null && `HTTP ${e.httpStatus}`}
                    {e.error && ` — ${e.error.slice(0, 160)}`}
                    {e.httpStatus === null && !e.error && '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Feature 31 — queue throughput (migration 060).
 *
 * Reads job_log, which exists because BullMQ's own `completed` counter measures
 * the eviction policy rather than the work: every queue here removes settled
 * jobs, and sheets_sync MUST (a lingering settled job with a stable id swallows
 * the next sync for that task).
 *
 * The bar is a hand-rolled CSS split — no chart library in this app (CLAUDE.md
 * §2), and this shape is a two-segment ratio, which does not need one.
 */
function JobThroughputSection({ data, days }: { data: AdminJobThroughput | null; days: number }) {
  if (!data) {
    return (
      <>
        <h2 className="admin-h2">ปริมาณงานในคิว</h2>
        <p style={S.loading}>ยังไม่มีข้อมูล (ต้อง apply migration 060 ก่อน)</p>
      </>
    );
  }

  // Fold the completed/failed pairs into one row per (queue, job) so a job's
  // success rate is readable on one line instead of two rows apart.
  const byJob = new Map<
    string,
    { queue: string; jobName: string; completed: number; failed: number; avgMs: number | null }
  >();
  for (const g of data.groups) {
    const id = `${g.queue}/${g.jobName}`;
    const row = byJob.get(id) ?? {
      queue: g.queue,
      jobName: g.jobName,
      completed: 0,
      failed: 0,
      avgMs: null,
    };
    if (g.status === 'completed') row.completed += g.count;
    else row.failed += g.count;
    // The completed bucket's average is the meaningful one — a failed job's
    // duration is how long it took to break, which is a different measurement.
    if (g.status === 'completed' && g.avgDurationMs !== null) row.avgMs = g.avgDurationMs;
    byJob.set(id, row);
  }
  const rows = [...byJob.values()].sort(
    (a, b) => b.completed + b.failed - (a.completed + a.failed),
  );
  const maxTotal = Math.max(1, ...rows.map((r) => r.completed + r.failed));

  return (
    <>
      <h2 className="admin-h2">ปริมาณงานในคิว ({days} วัน)</h2>
      <p style={S.note}>
        นับจาก <code>job_log</code> ไม่ใช่ตัวนับของ BullMQ — ตัวนับนั้นวัดนโยบายลบงานที่เสร็จแล้ว
        ไม่ใช่ปริมาณงานจริง
        {data.truncated && ' · เกินขีดจำกัดการอ่าน ตัวเลขเป็นค่าต่ำสุด'}
      </p>

      <div style={S.stripGrid}>
        <MiniStat label="สำเร็จ" value={data.totals.completed} tone="good" />
        <MiniStat
          label="ล้มเหลว (นับทุกครั้งที่ retry)"
          value={data.totals.failed}
          tone={data.totals.failed > 0 ? 'warn' : 'muted'}
        />
        <MiniStat
          label="อัตราสำเร็จ"
          value={data.totals.successRate === null ? '—' : `${data.totals.successRate}%`}
          tone={
            data.totals.successRate !== null && data.totals.successRate < 95 ? 'warn' : 'muted'
          }
        />
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>คิว</th>
              <th>ชนิดงาน</th>
              <th style={{ width: '30%' }}>สัดส่วน</th>
              <th style={{ textAlign: 'right' }}>สำเร็จ</th>
              <th style={{ textAlign: 'right' }}>ล้มเหลว</th>
              <th style={{ textAlign: 'right' }}>เวลาเฉลี่ย</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={S.emptyCell}>
                  ยังไม่มีงานที่จบในช่วงนี้
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const total = r.completed + r.failed;
              return (
                <tr key={`${r.queue}/${r.jobName}`}>
                  <td>{QUEUE_LABELS[r.queue as AdminQueueKey] ?? r.queue}</td>
                  <td>
                    <code>{r.jobName}</code>
                  </td>
                  <td>
                    <div style={{ ...S.meterTrack, width: `${(total / maxTotal) * 100}%` }}>
                      <div style={F.barSplit}>
                        <span
                          style={{
                            ...F.barSeg,
                            width: `${(r.completed / total) * 100}%`,
                            background: TONE_COLOR.good,
                          }}
                        />
                        <span
                          style={{
                            ...F.barSeg,
                            width: `${(r.failed / total) * 100}%`,
                            background: TONE_COLOR.bad,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.completed.toLocaleString('th-TH')}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      ...(r.failed > 0 ? S.badText : {}),
                    }}
                  >
                    {r.failed.toLocaleString('th-TH')}
                  </td>
                  {/* "—", never 0: a blank means "not measured", and a
                      fabricated zero would claim an instantaneous job. */}
                  <td style={{ textAlign: 'right' }}>
                    {r.avgMs === null ? '—' : `${(r.avgMs / 1000).toFixed(1)} วิ`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Feature 30 — R2 ↔ Postgres drift audit.
 *
 * Two independent stores hold every file and nothing keeps them in step
 * transactionally, so drift accumulates in both directions: objects nobody
 * claims (paid-for storage) and rows whose object is gone (a download button
 * that 404s).
 *
 * NOTHING IS EVER DELETED FROM R2 by this. The copy says so plainly, because an
 * admin who believes this button frees space will press it expecting that, and
 * the orphan list is a report they must act on themselves. The reasoning — an
 * orphan set is computed by SUBTRACTION, so a query returning too few rows
 * produces a confident list of live user files — is in the job's own header.
 *
 * The status is polled while a run is live and then left alone. A full-bucket
 * walk takes as long as it takes; a fixed poll after it settles is pure waste.
 */
function R2ReconcilePanel({ onError }: { onError: (err: unknown) => void }) {
  const [status, setStatus] = useState<AdminR2ReconcileStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const running = status?.status === 'active' || status?.status === 'waiting' || status?.status === 'delayed';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await getAdminR2ReconcileStatus());
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) onError(err);
    }
  }, [onError]);

  useEffect(() => {
    if (!hasSession()) return;
    void refresh();
  }, [refresh]);

  // Poll ONLY while a run is live. The dependency on `running` means the
  // interval is torn down the moment the job settles, rather than polling a
  // finished result forever.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [running, refresh]);

  async function start(): Promise<void> {
    if (starting || running) return;
    if (
      !window.confirm(
        'เริ่มตรวจสอบความตรงกันของ R2 กับฐานข้อมูล?\n\n' +
          'จะไล่อ่านทุกไฟล์ในบักเก็ต (ใช้เวลานาน) และจะไม่ลบไฟล์ใน R2 เลย — ' +
          'ไฟล์กำพร้าจะถูก "รายงาน" เท่านั้น ส่วนแถวที่ไม่มีไฟล์จริงจะถูกตั้งสถานะเป็น error',
      )
    ) {
      return;
    }
    setStarting(true);
    setRowError(null);
    try {
      await adminStartR2Reconcile();
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRowError('มีการตรวจสอบกำลังทำงานอยู่แล้ว');
        await refresh();
      } else {
        setRowError('เริ่มการตรวจสอบไม่สำเร็จ');
        onError(err);
      }
    } finally {
      setStarting(false);
    }
  }

  const result = status?.result ?? null;

  return (
    <>
      <h2 className="admin-h2">ตรวจสอบความตรงกัน R2 ↔ ฐานข้อมูล</h2>
      <div style={S.card}>
        <div style={S.panelHead}>
          <div>
            <div style={{ ...S.statusText }}>
              <span
                style={{
                  ...S.dot,
                  background: running
                    ? '#b45309'
                    : status?.status === 'failed'
                      ? TONE_COLOR.bad
                      : status?.status === 'completed'
                        ? TONE_COLOR.good
                        : 'var(--color-text-muted)',
                }}
              />
              {running
                ? 'กำลังตรวจสอบ…'
                : status?.status === 'completed'
                  ? 'ตรวจสอบเสร็จแล้ว'
                  : status?.status === 'failed'
                    ? 'ตรวจสอบล้มเหลว'
                    : 'ยังไม่เคยตรวจสอบในรอบนี้'}
            </div>
            <p style={S.kpiHint}>
              ไม่ลบไฟล์ใน R2 เด็ดขาด — ไฟล์กำพร้าจะรายงานเฉย ๆ ส่วนแถวที่ไฟล์หายจะถูกตั้ง
              status=error เพื่อไม่ให้หน้าเว็บเสนอปุ่มดาวน์โหลดที่กดแล้วพัง
            </p>
          </div>
          <button
            type="button"
            className="btn secondary"
            style={P.smallBtn}
            disabled={starting || running}
            onClick={() => void start()}
          >
            {running ? 'กำลังทำงาน…' : 'เริ่มตรวจสอบ'}
          </button>
        </div>

        {rowError && <p style={{ ...S.note, ...S.badText }}>{rowError}</p>}
        {status?.failedReason && <p style={{ ...S.note, ...S.badText }}>{status.failedReason}</p>}

        {status?.finishedAt && (
          <p style={S.subtle}>เสร็จเมื่อ {fmtDateTime(status.finishedAt)}</p>
        )}

        {result && (
          <>
            <p style={{ ...S.note, marginTop: 12 }}>{result.summary}</p>
            <div style={S.stripGrid}>
              <MiniStat
                label="ไฟล์กำพร้าใน R2 (รายงานเท่านั้น)"
                value={result.orphans.length}
                tone={result.orphans.length > 0 ? 'warn' : 'good'}
              />
              <MiniStat
                label="แถวที่ไฟล์หาย (ตั้ง error แล้ว)"
                value={result.missing.length}
                tone={result.missing.length > 0 ? 'bad' : 'good'}
              />
            </div>
            {result.orphans.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={S.subtle}>ดูรายการไฟล์กำพร้า (สูงสุด 500)</summary>
                <pre style={F.keyList}>{result.orphans.join('\n')}</pre>
              </details>
            )}
            {result.missing.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={S.subtle}>ดูรายการไฟล์ที่หาย (สูงสุด 500)</summary>
                <pre style={F.keyList}>{result.missing.join('\n')}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}

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
  onResolved,
}: {
  open: boolean;
  loading: boolean;
  jobs: Record<AdminQueueKey, AdminFailedJob[]> | null;
  onToggle: () => void;
  /** Called after a successful retry or remove so the row can leave the list. */
  onResolved: (queue: AdminQueueKey, jobId: string) => void;
}) {
  // Which row has a request in flight, and per-row failure text. Keyed by
  // `${queue}-${id}` so two rows can never share a spinner.
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const flat = jobs
    ? (Object.entries(jobs) as [AdminQueueKey, AdminFailedJob[]][]).flatMap(([key, list]) =>
        list.map((j) => ({ ...j, queue: key })),
      )
    : [];

  /**
   * Both actions share this: they are server-authoritative and NOT optimistic.
   * The API refuses anything that is not in the failed set (409), and a job the
   * retention window already evicted is a 404 — pulling the row before the
   * server agreed would hide exactly those answers.
   */
  async function act(queue: AdminQueueKey, jobId: string, action: 'retry' | 'remove'): Promise<void> {
    const rowKey = `${queue}-${jobId}`;
    if (busy) return;
    if (action === 'remove' && !window.confirm('ลบงานนี้ออกจากคิวถาวร? กู้คืนไม่ได้')) return;

    setBusy(rowKey);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
    try {
      if (action === 'retry') await adminRetryJob(queue, jobId);
      else await adminRemoveJob(queue, jobId);
      onResolved(queue, jobId);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? 'งานนี้ไม่ได้อยู่ในสถานะล้มเหลวแล้ว'
          : err instanceof ApiError && err.status === 404
            ? 'ไม่พบงานนี้ในคิวแล้ว'
            : err instanceof ApiError && err.status === 503
              ? 'คิวนี้ติดต่อไม่ได้ตอนนี้'
              : 'ทำรายการไม่สำเร็จ';
      setRowError((prev) => ({ ...prev, [rowKey]: message }));
    } finally {
      setBusy(null);
    }
  }

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
            รีโหลดหน้าเพื่อดึงชุดใหม่) · ลองใหม่/ลบ ได้เฉพาะงานที่อยู่ในสถานะล้มเหลว และทุกครั้งถูกบันทึกไว้ในบันทึกผู้ดูแล
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
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} style={S.emptyCell}>
                      กำลังโหลด…
                    </td>
                  </tr>
                )}
                {!loading && flat.length === 0 && (
                  <tr>
                    <td colSpan={7} style={S.emptyCell}>
                      ไม่มีงานล้มเหลวค้างอยู่
                    </td>
                  </tr>
                )}
                {!loading &&
                  flat.map((j) => {
                    const rowKey = `${j.queue}-${j.id}`;
                    const inFlight = busy === rowKey;
                    return (
                      <tr key={rowKey}>
                        <td>{QUEUE_LABELS[j.queue]}</td>
                        <td>{j.name}</td>
                        <td>{j.jobType ?? '—'}</td>
                        <td>{j.attemptsMade}</td>
                        <td style={S.reasonCell}>
                          {j.reason ?? '—'}
                          {rowError[rowKey] && <div style={S.badText}>{rowError[rowKey]}</div>}
                        </td>
                        <td>{fmtDateTime(j.failedAt)}</td>
                        <td>
                          <div style={P.rowActions}>
                            {/* Both disabled while EITHER is running — a retry
                                and a remove racing on one job id is a state
                                nobody should be able to create with two clicks. */}
                            <button
                              type="button"
                              className="btn secondary"
                              style={P.smallBtn}
                              disabled={inFlight || busy !== null}
                              onClick={() => void act(j.queue, j.id, 'retry')}
                            >
                              {inFlight ? '…' : 'ลองใหม่'}
                            </button>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ ...P.smallBtn, ...P.dangerBtn }}
                              disabled={inFlight || busy !== null}
                              onClick={() => void act(j.queue, j.id, 'remove')}
                            >
                              {inFlight ? '…' : 'ลบ'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
  onTicketUpdated,
}: {
  data: AdminSupportTickets | null;
  status: string;
  onStatusChange: (s: string) => void;
  onTicketUpdated: (t: AdminSupportTicket) => void;
}) {
  const STATUSES: { key: string; label: string }[] = [
    { key: 'open', label: 'เปิดอยู่' },
    { key: 'answered', label: 'ตอบแล้ว' },
    { key: 'closed', label: 'ปิดแล้ว' },
  ];

  // At most one inline form open at a time: two half-written replies on screen
  // is a way to submit the wrong one.
  const [editing, setEditing] = useState<string | null>(null);

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
        การรับตั๋วจากผู้ใช้ยังปิดอยู่ (routes /support/* ตอบ 503) — ตารางนี้จัดการตั๋วที่มีอยู่แล้วได้
        · ข้อความตอบถูกเก็บไว้ในบันทึกผู้ดูแล ไม่ได้ส่งถึงผู้ใช้ (ตาราง support_tickets ไม่มีคอลัมน์เธรด)
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
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {(!data || data.tickets.length === 0) && (
              <tr>
                <td colSpan={8} style={S.emptyCell}>
                  ไม่มีตั๋วในสถานะนี้
                </td>
              </tr>
            )}
            {data?.tickets.map((t) => (
              <Fragment key={t.id}>
                <tr style={t.breached ? S.rowBad : undefined}>
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
                  <td>
                    {/* A closed ticket is terminal — the API 409s any further
                        edit so it must not offer a button that cannot work. */}
                    {t.status === 'closed' ? (
                      <span style={S.subtle}>ปิดแล้ว</span>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary"
                        style={P.smallBtn}
                        onClick={() => setEditing(editing === t.id ? null : t.id)}
                      >
                        {editing === t.id ? 'ยกเลิก' : 'ปิด ticket'}
                      </button>
                    )}
                  </td>
                </tr>
                {editing === t.id && (
                  <tr>
                    <td colSpan={8} style={P.formCell}>
                      <TicketForm
                        ticket={t}
                        onDone={(updated) => {
                          onTicketUpdated(updated);
                          setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The inline reply/close form for one ticket.
 *
 * `reply` is optional and `status` defaults to 'closed' — the button that opens
 * this form is labelled "ปิด ticket", so closing is the action the admin already
 * chose and the form only asks what else to record.
 *
 * The row is updated from the SERVER's response, not from the form's own
 * values: first_response_at is stamped server-side and only on the first
 * response, so an optimistic row would show the wrong timestamp for the second
 * edit of a ticket that was already answered.
 */
function TicketForm({
  ticket,
  onDone,
}: {
  ticket: AdminSupportTicket;
  onDone: (updated: AdminSupportTicket) => void;
}) {
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<'answered' | 'closed'>('closed');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await adminUpdateTicket(ticket.id, {
        status,
        ...(reply.trim() ? { reply: reply.trim() } : {}),
      });
      const now = Date.now();
      const dueMs = new Date(res.ticket.dueAt).getTime();
      const settledMs = res.ticket.firstResponseAt ? new Date(res.ticket.firstResponseAt).getTime() : now;
      onDone({
        ...ticket,
        status: res.ticket.status,
        firstResponseAt: res.ticket.firstResponseAt,
        // Recomputed with the SAME rule the API's read endpoint uses: an
        // answered ticket is judged on when it was answered, not on now.
        breached: settledMs > dueMs,
      });
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 409
          ? 'ตั๋วนี้ถูกปิดไปแล้ว'
          : e instanceof ApiError && e.status === 404
            ? 'ไม่พบตั๋วนี้แล้ว'
            : 'บันทึกไม่สำเร็จ',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={P.form}>
      <label style={P.formLabel} htmlFor={`ticket-reply-${ticket.id}`}>
        ข้อความตอบ (ไม่บังคับ · สูงสุด 2000 ตัวอักษร)
      </label>
      <textarea
        id={`ticket-reply-${ticket.id}`}
        value={reply}
        maxLength={2000}
        rows={3}
        onChange={(e) => setReply(e.target.value)}
        style={P.textarea}
        placeholder="บันทึกไว้ในบันทึกผู้ดูแล — ผู้ใช้ไม่เห็นข้อความนี้"
      />
      <div style={P.formRow}>
        <label style={P.formLabel} htmlFor={`ticket-status-${ticket.id}`}>
          สถานะใหม่
        </label>
        <select
          id={`ticket-status-${ticket.id}`}
          value={status}
          onChange={(e) => setStatus(e.target.value as 'answered' | 'closed')}
          style={P.select}
        >
          <option value="closed">ปิดแล้ว</option>
          <option value="answered">ตอบแล้ว (ยังไม่ปิด)</option>
        </select>
        <button
          type="button"
          className="btn"
          style={P.smallBtn}
          disabled={saving}
          onClick={() => void submit()}
        >
          {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
      {err && <div style={S.badText}>{err}</div>}
    </div>
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

/* ---------- TIER 2 write-control tokens ----------
   Kept separate from S so the read-only page's styling and the controls that
   MUTATE things stay visually and textually distinguishable in the source. */

const P: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  // A muted red wash while push is OFF: the page must not look normal in the
  // state where the product is deliberately silent.
  wrapOff: { borderColor: '#dc2626', background: 'rgba(220, 38, 38, 0.06)' },
  track: {
    width: 52,
    height: 28,
    borderRadius: 'var(--radius-full)',
    border: 'none',
    padding: 2,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    transition: 'background 200ms ease',
  },
  knob: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    transition: 'transform 200ms ease',
  },
  rowActions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  smallBtn: { padding: '4px 12px', fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap' },
  dangerBtn: { color: 'var(--color-danger, #dc2626)', borderColor: 'rgba(220, 38, 38, 0.4)' },
  formCell: { background: 'var(--color-surface-2, var(--color-surface))', padding: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  formRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  formLabel: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' },
  textarea: {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 'var(--font-size-sm)',
    padding: 8,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    resize: 'vertical',
  },
  select: {
    fontFamily: 'inherit',
    fontSize: 'var(--font-size-sm)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
  },
  numberInput: {
    fontFamily: 'inherit',
    fontSize: 'var(--font-size-sm)',
    padding: '6px 10px',
    width: 120,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
  },
};

/* ---------- TIER 3 tokens ----------
   Flag cards, the two-segment throughput bar and the R2 key dumps. Kept apart
   from S and P for the same reason those two are apart from each other: the
   source should say which tier a control belongs to without cross-referencing. */

const F: Record<string, React.CSSProperties> = {
  flagCard: { display: 'flex', flexDirection: 'column', gap: 4 },
  flagHead: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  barSplit: { display: 'flex', height: '100%', width: '100%' },
  barSeg: { display: 'block', height: '100%' },
  // R2 keys are long and must not force the page body to scroll sideways —
  // the block gets its own overflow, per the app's wide-content rule.
  keyList: {
    maxHeight: 240,
    overflow: 'auto',
    fontSize: 'var(--font-size-xs)',
    background: 'var(--color-surface-3)',
    borderRadius: 'var(--radius-sm)',
    padding: 8,
    margin: '8px 0 0',
    whiteSpace: 'pre',
  },
};

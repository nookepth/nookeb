'use client';

import { useEffect, useState } from 'react';
import {
  adminResetQuota,
  adminRevokeSession,
  adminSetStorageOverride,
  adminSetUserPlan,
  ApiError,
  getAdminFeatures,
  getAdminOverview,
  getAdminPowerUsers,
  getAdminAdoption,
  getAdminFunnel,
  getAdminProInterest,
  getAdminReferral,
  getAdminStorage,
  getAdminTasks,
  getAdminTimeseries,
  getAdminUserDetail,
  hasSession,
  listAdminSpaces,
  listAdminUsers,
  setUserQuota,
  type AdminAdoption,
  type AdminReferral,
  type AdminStorage,
  type AdminFeatureRow,
  type AdminFunnel,
  type AdminFunnelOverview,
  type AdminOverview,
  type AdminPowerUser,
  type AdminProInterest,
  type AdminRetentionCohort,
  type AdminTasks,
  type AdminSpace,
  type AdminTimeseriesPoint,
  type AdminPlanValue,
  type AdminUser,
  type AdminUserDetail,
  type FeatureModule,
  type FunnelStage,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
// Dependency-free stacked bar chart over a daily series. Shared with
// /admin/system so the two pages cannot drift.
import { StackedBars } from './StackedBars';

// Friendly Thai labels for the fixed event vocabulary (events.service.ts).
const EVENT_LABELS: Record<string, string> = {
  cmd_scan: 'เริ่มสแกน',
  cmd_merge: 'เริ่มรวมรูป',
  cmd_done: 'กดเสร็จ',
  cmd_cancel: 'ยกเลิก',
  cmd_convert_arm: 'เริ่มแปลงไฟล์',
  cmd_diary_arm: 'เปิดไดอารี่',
  cmd_help: 'ดูวิธีใช้',
  cmd_support: 'ติดต่อซัพพอร์ต',
  cmd_referral: 'เช็คโค้ดชวนเพื่อน',
  upload_done: 'อัปโหลดสำเร็จ',
  scan_done: 'ได้ไฟล์ PDF',
  docx_done: 'แปลงเป็น Word สำเร็จ',
  docx_failed: 'แปลง Word ไม่สำเร็จ',
  diary_done: 'บันทึกไดอารี่',
  feature_blocked_quota: 'ชนเพดานพื้นที่',
  web_login: 'เข้าเว็บ',
  web_search: 'ค้นหาในเว็บ',
  file_download: 'ดาวน์โหลดไฟล์',
};

// Gift-box fake-door demand-test labels (migration 034 / anonymous).
const PRO_FEATURE_LABELS: Record<string, string> = {
  audio: 'เพิ่มเสียง/เพลง',
  video: 'แนบวิดีโอสั้น',
};

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

export default function AdminPage() {
  const [days, setDays] = useState<Range>(30);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [series, setSeries] = useState<AdminTimeseriesPoint[]>([]);
  const [features, setFeatures] = useState<AdminFeatureRow[]>([]);
  const [funnels, setFunnels] = useState<AdminFunnel[]>([]);
  const [powerUsers, setPowerUsers] = useState<AdminPowerUser[]>([]);
  const [proInterest, setProInterest] = useState<AdminProInterest | null>(null);
  const [tasks, setTasks] = useState<AdminTasks | null>(null);
  const [funnel, setFunnel] = useState<AdminFunnelOverview | null>(null);
  const [adoption, setAdoption] = useState<AdminAdoption | null>(null);
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [referral, setReferral] = useState<AdminReferral | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [spaces, setSpaces] = useState<AdminSpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which user's detail drawer is open. The drawer fetches on OPEN, never on
  // mount — /admin/users/:id is 6 queries per user and nobody needs them for
  // every row in the table.
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);

  async function loadAnalytics(range: Range): Promise<void> {
    const [ov, ts, ft, pu, pi, tk, fn, ad, sg, rf] = await Promise.all([
      getAdminOverview(),
      getAdminTimeseries(range),
      getAdminFeatures(range),
      getAdminPowerUsers(range),
      getAdminProInterest(range),
      getAdminTasks(range),
      getAdminFunnel(range),
      getAdminAdoption(range),
      getAdminStorage(range),
      getAdminReferral(range),
    ]);
    setOverview(ov);
    setSeries(ts.series);
    setFeatures(ft.features);
    setFunnels(ft.funnels);
    setPowerUsers(pu.users);
    setProInterest(pi);
    setTasks(tk);
    setFunnel(fn);
    setAdoption(ad);
    setStorage(sg);
    setReferral(rf);
  }

  async function loadTables(): Promise<void> {
    const [u, s] = await Promise.all([listAdminUsers(), listAdminSpaces()]);
    setUsers(u.users);
    setSpaces(s.spaces);
  }

  async function loadAll(range: Range): Promise<void> {
    try {
      await Promise.all([loadAnalytics(range), loadTables()]);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError('คุณไม่มีสิทธิ์เข้าหน้าผู้ดูแล');
      else if (err instanceof ApiError && err.status === 401) setError('กรุณาเข้าสู่ระบบก่อน');
      else setError('โหลดข้อมูลไม่สำเร็จ');
    }
  }

  useEffect(() => {
    if (!hasSession()) {
      setError('กรุณาเข้าสู่ระบบก่อน');
      return;
    }
    void loadAll(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  async function editQuota(u: AdminUser): Promise<void> {
    const gb = window.prompt(
      `ตั้งโควตา (GB) สำหรับ ${u.displayName ?? u.id}`,
      String(u.storageLimit / 1024 ** 3),
    );
    if (!gb) return;
    const bytes = Math.round(parseFloat(gb) * 1024 ** 3);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      alert('กรุณาใส่ตัวเลขที่ถูกต้อง');
      return;
    }
    try {
      await setUserQuota(u.id, bytes);
      await loadTables();
    } catch {
      alert('อัปเดตโควตาไม่สำเร็จ');
    }
  }

  const retD7 =
    overview && overview.retention.cohort_size > 0
      ? Math.round((overview.retention.d7_returned / overview.retention.cohort_size) * 100)
      : null;

  return (
    <>
      <header className="topbar">
        <h1>หนูเก็บ — ผู้ดูแล</h1>
        <div className="topbar-actions">
          <a className="btn secondary" href="/admin/system">
            ระบบและปฏิบัติการ
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
            {/* Range selector */}
            <div style={S.rangeRow}>
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                ช่วงเวลา:
              </span>
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setDays(r)}
                  style={{ ...S.rangeBtn, ...(days === r ? S.rangeBtnActive : {}) }}
                >
                  {r} วัน
                </button>
              ))}
            </div>

            {/* KPI cards */}
            <div style={S.kpiGrid}>
              <Kpi label="ผู้ใช้ทั้งหมด" value={overview?.totalUsers} hint={`+${overview?.newUsers7 ?? 0} ใน 7 วัน`} />
              <Kpi label="Active วันนี้ (DAU)" value={overview?.dau} />
              <Kpi label="Active 7 วัน (WAU)" value={overview?.wau} />
              <Kpi label="Active 30 วัน (MAU)" value={overview?.mau} />
              <Kpi
                label="ความเหนียว (DAU/MAU)"
                value={overview ? `${overview.stickiness}%` : undefined}
                hint="เกิน 20% = ติดเป็นนิสัย"
                tone={overview && overview.stickiness >= 20 ? 'good' : 'muted'}
              />
              <Kpi
                label="คงอยู่ D7"
                value={retD7 === null ? '—' : `${retD7}%`}
                hint={overview ? `จากรุ่น ${overview.retention.cohort_size} คน` : undefined}
              />
              <Kpi
                label="ชนเพดานพื้นที่ (7 วัน)"
                value={overview?.quotaBlocks7}
                hint="สัญญาณพร้อมจ่าย"
                tone={overview && overview.quotaBlocks7 > 0 ? 'warn' : 'muted'}
              />
              <Kpi label="สมัครใหม่ 30 วัน" value={overview?.newUsers30} />
            </div>

            {/* Growth chart */}
            <SectionTitle>การเติบโต — ผู้ใช้ที่ active และสมัครใหม่รายวัน</SectionTitle>
            <div style={S.card}>
              <GrowthChart series={series} />
            </div>

            {/* Funnel overview + retention cohorts (section 1) */}
            <SectionTitle>ภาพรวม Funnel ({days} วัน)</SectionTitle>
            <FunnelSection data={funnel} />

            {/* Feature adoption — module level (section 3) */}
            <SectionTitle>การเข้าถึงแต่ละโมดูล ({days} วัน)</SectionTitle>
            <AdoptionSection data={adoption} />

            {/* Feature adoption — per-event detail */}
            <SectionTitle>ฟีเจอร์ไหนถูกใช้จริง — รายกิจกรรม ({days} วัน)</SectionTitle>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>กิจกรรม</th>
                    <th>ผู้ใช้ (คน)</th>
                    <th>จำนวนครั้ง</th>
                  </tr>
                </thead>
                <tbody>
                  {features.length === 0 && (
                    <tr>
                      <td colSpan={3} style={S.emptyCell}>
                        ยังไม่มีข้อมูล — เริ่มเก็บหลังใช้งานสักพัก
                      </td>
                    </tr>
                  )}
                  {features.map((f) => (
                    <tr key={f.eventType}>
                      <td>{EVENT_LABELS[f.eventType] ?? f.eventType}</td>
                      <td>{f.uniqueUsers.toLocaleString()}</td>
                      <td>{f.eventCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Funnels */}
            <SectionTitle>อัตราทำสำเร็จของแต่ละฟีเจอร์ (funnel)</SectionTitle>
            <div style={S.funnelGrid}>
              {funnels.map((f) => (
                <FunnelCard key={f.name} funnel={f} />
              ))}
            </div>

            {/* Pro-interest demand test (priority — drives feature build order) */}
            <SectionTitle>ความสนใจฟีเจอร์ Pro (fake-door) — {days} วัน</SectionTitle>
            <ProInterestSection data={proInterest} />

            {/* Tasks dashboard (priority) */}
            <SectionTitle>ระบบตามงาน (Tasks) — {days} วัน</SectionTitle>
            <TasksSection data={tasks} />

            {/* Power users — revenue signal */}
            <SectionTitle>ผู้ใช้ตัวจริง — คนที่ควรชวนอัปเกรด</SectionTitle>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>กิจกรรมรวม</th>
                    <th>ชนเพดาน</th>
                    <th>แปลง Word</th>
                    <th>ใช้ไป / โควตา</th>
                  </tr>
                </thead>
                <tbody>
                  {powerUsers.length === 0 && (
                    <tr>
                      <td colSpan={5} style={S.emptyCell}>
                        ยังไม่มีข้อมูล
                      </td>
                    </tr>
                  )}
                  {powerUsers.map((u) => (
                    <tr key={u.userId}>
                      <td>{u.displayName ?? '—'}</td>
                      <td>{u.totalEvents.toLocaleString()}</td>
                      <td>
                        {u.quotaBlocks > 0 ? (
                          <span style={S.badgeWarn}>{u.quotaBlocks}</span>
                        ) : (
                          u.quotaBlocks
                        )}
                      </td>
                      <td>{u.docxConverts}</td>
                      <td>
                        {formatBytes(u.storageUsed)} / {formatBytes(u.storageLimit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Storage / quota dashboard (section 6) */}
            <SectionTitle>พื้นที่จัดเก็บ / โควตา ({days} วัน)</SectionTitle>
            <StorageSection data={storage} />

            {/* Referral / marketing dashboard (section 5) */}
            <SectionTitle>ชวนเพื่อน / การตลาด ({days} วัน)</SectionTitle>
            <ReferralSection data={referral} />

            {/* All users */}
            <SectionTitle>ผู้ใช้ทั้งหมด ({users?.length ?? 0})</SectionTitle>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>แผน</th>
                    <th>ไฟล์</th>
                    <th>ใช้ไป</th>
                    <th>โควตา</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(users ?? []).map((u) => (
                    <tr
                      key={u.id}
                      onClick={() => setDrawerUserId(u.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        {u.displayName ?? '—'} {u.isAdmin && <span className="tag-chip">admin</span>}
                      </td>
                      <td>{u.plan}</td>
                      <td>{u.fileCount}</td>
                      <td>{formatBytes(u.storageUsed)}</td>
                      <td>{formatBytes(u.storageLimit)}</td>
                      <td>
                        <button
                          className="btn secondary"
                          onClick={(e) => {
                            // The row opens the drawer; this button must not.
                            e.stopPropagation();
                            void editQuota(u);
                          }}
                        >
                          แก้โควตา
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Spaces */}
            <SectionTitle>พื้นที่ ({spaces?.length ?? 0})</SectionTitle>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>ประเภท</th>
                    <th>สมาชิก</th>
                    <th>ไฟล์</th>
                    <th>ขนาด</th>
                  </tr>
                </thead>
                <tbody>
                  {(spaces ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.type === 'personal' ? 'ส่วนตัว' : 'ทีม'}</td>
                      <td>{s.memberCount}</td>
                      <td>{s.fileCount}</td>
                      <td>{formatBytes(s.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      <UserDetailDrawer userId={drawerUserId} onClose={() => setDrawerUserId(null)} />
    </>
  );
}

/**
 * Per-user detail drawer, opened by a row click in the users table.
 *
 * Fetches on OPEN (userId transitions to non-null), never on mount — the
 * endpoint runs six queries per user and the table can hold hundreds of rows.
 *
 * NEVER renders a token. The API does not select google_integrations
 * .encrypted_token and AdminUserGoogle has no field for it, so there is nothing
 * here to leak even by accident; the Google card shows the linked account, the
 * sheet, and the last sync error, which is everything an admin needs to
 * diagnose "why did their mirror stop".
 */
function UserDetailDrawer({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const d = await getAdminUserDetail(userId);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return null;

  const u = detail?.user;
  const storagePct =
    u && u.storageLimit > 0 ? Math.min(100, Math.round((u.storageUsed / u.storageLimit) * 100)) : 0;

  return (
    <div style={D.overlay} onClick={onClose} role="presentation">
      {/* Stop the click from reaching the overlay's close handler. */}
      <aside style={D.panel} onClick={(e) => e.stopPropagation()}>
        <div style={D.head}>
          <div>
            <div style={D.title}>{u?.displayName ?? 'ผู้ใช้'}</div>
            {u && <div style={D.subtle}>สมัครเมื่อ {new Date(u.createdAt).toLocaleDateString('th-TH')}</div>}
          </div>
          <button className="btn secondary" type="button" onClick={onClose}>
            ปิด
          </button>
        </div>

        {loading && <p style={D.subtle}>กำลังโหลด…</p>}
        {failed && <p style={D.subtle}>โหลดข้อมูลผู้ใช้ไม่สำเร็จ</p>}

        {detail && u && (
          <>
            <div style={D.badgeRow}>
              <span style={D.planBadge}>{u.normalizedPlan}</span>
              {u.plan !== u.normalizedPlan && <span style={D.rawBadge}>ค่าดิบ: {u.plan}</span>}
              {u.isAdmin && <span className="tag-chip">admin</span>}
            </div>

            <PlanControl
              userId={u.id}
              current={u.plan}
              onChanged={(plan, normalizedPlan, storageLimit) =>
                setDetail((prev) =>
                  prev ? { ...prev, user: { ...prev.user, plan, normalizedPlan, storageLimit } } : prev,
                )
              }
            />

            <h3 style={D.h3}>พื้นที่จัดเก็บ</h3>
            <DrawerBar pct={storagePct} />
            <p style={D.subtle}>
              {formatBytes(u.storageUsed)} / {formatBytes(u.storageLimit)} ({storagePct}%)
            </p>
            <p style={D.subtle}>
              ไฟล์ {detail.content.fileCount} · {formatBytes(detail.content.fileBytes)} · ห้องนิรภัย{' '}
              {detail.content.vaultFileCount}
            </p>

            <StorageOverrideControl
              userId={u.id}
              current={u.storageLimitOverride ?? null}
              onSaved={(override, limit) =>
                setDetail((prev) =>
                  prev
                    ? { ...prev, user: { ...prev.user, storageLimitOverride: override, storageLimit: limit } }
                    : prev,
                )
              }
            />

            <h3 style={D.h3}>โควตาเดือนนี้</h3>
            {detail.quotas.length === 0 && <p style={D.subtle}>ยังไม่มีข้อมูลโควตา</p>}
            {detail.quotas.map((q) => {
              const pct = q.unlimited || q.limit <= 0 ? 0 : Math.min(100, Math.round((q.used / q.limit) * 100));
              return (
                <div key={q.feature} style={{ marginBottom: 10 }}>
                  <div style={D.quotaRow}>
                    <span>{q.feature}</span>
                    <span style={D.subtle}>
                      {q.used} / {q.unlimited ? 'ไม่จำกัด' : q.limit}
                      <QuotaResetButton
                        userId={u.id}
                        feature={q.feature}
                        disabled={q.used === 0}
                        onReset={() =>
                          // Optimistic: the endpoint's only success shape is
                          // "this counter is now 0", so there is nothing else it
                          // could have become. A failure restores nothing because
                          // the server reverts its own write.
                          setDetail((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  quotas: prev.quotas.map((x) =>
                                    x.feature === q.feature ? { ...x, used: 0 } : x,
                                  ),
                                }
                              : prev,
                          )
                        }
                      />
                    </span>
                  </div>
                  {!q.unlimited && q.limit > 0 && <DrawerBar pct={pct} />}
                </div>
              );
            })}

            <h3 style={D.h3}>สมาชิก</h3>
            {detail.subscriptions.length === 0 && <p style={D.subtle}>ไม่มีสมาชิกแบบชำระเงิน</p>}
            {detail.subscriptions.map((s) => (
              <p key={s.id} style={D.subtle}>
                {s.plan} · {s.billingCycle === 'yearly' ? 'รายปี' : 'รายเดือน'} · ฿{s.priceThb} ·{' '}
                {s.status} · หมด {new Date(s.currentPeriodEnd).toLocaleDateString('th-TH')}
                {s.cancelledAt ? ' · ยกเลิกแล้ว' : ''}
              </p>
            ))}

            <h3 style={D.h3}>บูธที่ใช้งานอยู่ ({detail.boosts.length})</h3>
            {detail.boosts.length === 0 && <p style={D.subtle}>ไม่มี</p>}
            {detail.boosts.map((b) => (
              <p key={b.id} style={D.subtle}>
                กลุ่ม …{b.groupId.slice(-6)} · หมดอายุ{' '}
                {new Date(b.expiresAt).toLocaleDateString('th-TH')}
              </p>
            ))}

            <h3 style={D.h3}>Google Sheets</h3>
            {!detail.google.connected && <p style={D.subtle}>ยังไม่ได้เชื่อมต่อ</p>}
            {detail.google.connected && (
              <>
                <p style={D.subtle}>เชื่อมกับ {detail.google.googleEmail ?? '—'}</p>
                {detail.google.lastSyncedAt && (
                  <p style={D.subtle}>
                    sync ล่าสุด {new Date(detail.google.lastSyncedAt).toLocaleString('th-TH')}
                  </p>
                )}
                {detail.google.lastError ? (
                  <p style={D.errorText}>ผิดพลาด: {detail.google.lastError}</p>
                ) : (
                  <p style={D.subtle}>ไม่มีข้อผิดพลาดค้างอยู่</p>
                )}
              </>
            )}

            <h3 style={D.h3}>เซสชัน</h3>
            <RevokeSessionsControl userId={u.id} />
          </>
        )}
      </aside>
    </div>
  );
}

/* ==========================================================================
   TIER 2 write controls (routes/admin.ts, migration 059).

   Every one of these changes SOMEONE ELSE'S account and is recorded in
   admin_audit_log server-side. Three rules they all follow:

     * confirm before the request — none of them is undoable from this UI;
     * `saving` disables the control, so a double click cannot fire twice;
     * a failure is shown INLINE and the local value is left alone. A 500 from
       these endpoints specifically means "the write was reverted because it
       could not be audited", so silently keeping an optimistic value would show
       an admin a state the server does not have.
   ========================================================================== */

const PLAN_OPTIONS: { value: AdminPlanValue; label: string }[] = [
  { value: 'free', label: 'free — หนูเก็บวัยเด็ก' },
  { value: 'pro', label: 'pro — หนูเก็บโตแย้ว' },
  { value: 'premium', label: 'premium — หนูเก็บแปลงร่าง' },
  // Legacy raw value; migration 051's CHECK still accepts it and it folds onto
  // premium. Offered so an existing 'team' row can be seen and edited as itself.
  { value: 'team', label: 'team (ค่าเดิม — นับเป็น premium)' },
];

/**
 * Direct plan override.
 *
 * Deliberately NOT a purchase: the endpoint writes users.plan and re-derives
 * the locker limit, and creates no `subscriptions` row. The copy says so,
 * because the consequence is real — an admin-granted paid plan has no billing
 * period and the nightly expiry sweep will never take it away again.
 */
function PlanControl({
  userId,
  current,
  onChanged,
}: {
  userId: string;
  current: string;
  onChanged: (plan: string, normalizedPlan: string, storageLimit: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function change(next: AdminPlanValue): Promise<void> {
    if (saving || next === current) return;
    if (!window.confirm(`เปลี่ยนแผนของผู้ใช้นี้จาก "${current}" เป็น "${next}"?`)) return;

    setSaving(true);
    setErr(null);
    try {
      const res = await adminSetUserPlan(userId, next);
      onChanged(res.plan, res.normalizedPlan, res.storageLimit);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? 'ไม่พบผู้ใช้นี้' : 'เปลี่ยนแผนไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={D.control}>
      <label style={D.controlLabel} htmlFor={`plan-${userId}`}>
        เปลี่ยนแผน (override โดยผู้ดูแล — ไม่สร้างรายการชำระเงิน)
      </label>
      <select
        id={`plan-${userId}`}
        value={current}
        disabled={saving}
        onChange={(e) => void change(e.target.value as AdminPlanValue)}
        style={D.select}
      >
        {PLAN_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {saving && <span style={D.subtle}>กำลังบันทึก…</span>}
      {err && <div style={D.errorText}>{err}</div>}
    </div>
  );
}

const GB = 1024 * 1024 * 1024;

/**
 * Manual locker ceiling.
 *
 * Entered in GB because that is the unit the whole product talks in, and
 * converted to bytes here — the API's column is bytes, and a UI that asked for
 * bytes would be a UI that invites a typo three orders of magnitude wide.
 *
 * "ล้างค่า" sends null, which removes the override and hands the user back to
 * their plan's computed allowance. That is a different thing from entering 0,
 * which pins them to a zero-byte locker; the copy distinguishes the two because
 * the field cannot.
 */
function StorageOverrideControl({
  userId,
  current,
  onSaved,
}: {
  userId: string;
  current: number | null;
  onSaved: (override: number | null, storageLimit: number) => void;
}) {
  const [gb, setGb] = useState<string>(current === null ? '' : String(current / GB));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the drawer switches to another user, or after a save changes
  // the server's value — without this the field would keep the previous user's.
  useEffect(() => {
    setGb(current === null ? '' : String(current / GB));
    setErr(null);
  }, [current, userId]);

  async function save(bytes: number | null): Promise<void> {
    if (saving) return;
    const what = bytes === null ? 'ล้างค่า override และกลับไปใช้โควตาตามแผน' : `ตั้งเพดานเป็น ${bytes / GB} GB`;
    if (!window.confirm(`${what} สำหรับผู้ใช้นี้?`)) return;

    setSaving(true);
    setErr(null);
    try {
      const res = await adminSetStorageOverride(userId, bytes);
      onSaved(res.storageLimitOverride, res.storageLimit);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 400 ? 'ค่าที่ใส่ไม่ถูกต้อง (0 – 1024 GB)' : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  function submit(): void {
    const parsed = Number(gb);
    if (gb.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
      setErr('ใส่จำนวน GB เป็นตัวเลขไม่ติดลบ (หรือกด “ล้างค่า”)');
      return;
    }
    // Rounded to whole bytes: the API takes an integer, and a fractional GB
    // entry would otherwise 400 with a message about integers that means
    // nothing to whoever typed "2.5".
    void save(Math.round(parsed * GB));
  }

  return (
    <div style={D.control}>
      <label style={D.controlLabel} htmlFor={`override-${userId}`}>
        เพดานพื้นที่แบบกำหนดเอง (GB)
      </label>
      <div style={D.controlRow}>
        <input
          id={`override-${userId}`}
          type="number"
          min={0}
          step="0.5"
          value={gb}
          disabled={saving}
          onChange={(e) => setGb(e.target.value)}
          placeholder="ใช้ค่าจากแผน"
          style={D.numberInput}
        />
        <button type="button" className="btn" style={D.smallBtn} disabled={saving} onClick={submit}>
          บันทึก
        </button>
        <button
          type="button"
          className="btn secondary"
          style={D.smallBtn}
          disabled={saving || current === null}
          onClick={() => void save(null)}
        >
          ล้างค่า
        </button>
      </div>
      <p style={D.subtle}>
        {current === null
          ? 'ตอนนี้ใช้โควตาตามแผน — ค่าที่ตั้งที่นี่จะไม่ถูกเขียนทับเมื่อเปลี่ยนแผนหรือมีคนกรอกโค้ดแนะนำ'
          : `override อยู่ที่ ${(current / GB).toFixed(2)} GB · “ล้างค่า” เพื่อกลับไปใช้โควตาตามแผน`}
      </p>
      {err && <div style={D.errorText}>{err}</div>}
    </div>
  );
}

/** Zero one monthly counter. Disabled at 0 — there is nothing to reset. */
function QuotaResetButton({
  userId,
  feature,
  disabled,
  onReset,
}: {
  userId: string;
  feature: string;
  disabled: boolean;
  onReset: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reset(): Promise<void> {
    if (saving) return;
    if (!window.confirm(`รีเซ็ตโควตา "${feature}" ของเดือนนี้เป็น 0?`)) return;

    setSaving(true);
    setErr(null);
    try {
      await adminResetQuota(userId, feature);
      onReset();
    } catch (e) {
      setErr(
        // 404 = no row for this period, which already MEANS zero used. Saying
        // "ยังไม่มีการใช้งาน" is the honest translation of that, not an error.
        e instanceof ApiError && e.status === 404 ? 'ยังไม่มีการใช้งานเดือนนี้' : 'รีเซ็ตไม่สำเร็จ',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn secondary"
        style={{ ...D.smallBtn, marginLeft: 8 }}
        disabled={saving || disabled}
        onClick={() => void reset()}
      >
        {saving ? '…' : 'Reset'}
      </button>
      {err && <div style={D.errorText}>{err}</div>}
    </>
  );
}

/**
 * Bump users.session_version, invalidating every JWT the user holds.
 *
 * The button stays disabled for 5 s after success. Not a rate limit — the
 * server has none for this — but a pause long enough for the confirmation to be
 * read, on a control whose only visible effect happens somewhere else entirely.
 */
function RevokeSessionsControl({ userId }: { userId: string }) {
  const [saving, setSaving] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset when the drawer switches user, and clear any pending cooldown timer.
  useEffect(() => {
    setDone(false);
    setErr(null);
    setCooling(false);
  }, [userId]);

  useEffect(() => {
    if (!cooling) return;
    const id = setTimeout(() => setCooling(false), 5000);
    return () => clearTimeout(id);
  }, [cooling]);

  async function revoke(): Promise<void> {
    if (saving || cooling) return;
    if (!window.confirm('ยกเลิกทุกเซสชันของผู้ใช้นี้? ผู้ใช้จะต้องเข้าสู่ระบบใหม่')) return;

    setSaving(true);
    setErr(null);
    try {
      await adminRevokeSession(userId);
      setDone(true);
      setCooling(true);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 409
          ? 'มีผู้ดูแลคนอื่นทำรายการพร้อมกัน — ลองใหม่อีกครั้ง'
          : e instanceof ApiError && e.status === 404
            ? 'ไม่พบผู้ใช้นี้'
            : 'ยกเลิกเซสชันไม่สำเร็จ',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={D.control}>
      <button
        type="button"
        className="btn secondary"
        style={{ ...D.smallBtn, ...D.dangerBtn }}
        disabled={saving || cooling}
        onClick={() => void revoke()}
      >
        {saving ? 'กำลังยกเลิก…' : 'ยกเลิกทุกเซสชัน'}
      </button>
      {done && <span style={D.okText}>เซสชันถูกยกเลิกแล้ว</span>}
      {err && <div style={D.errorText}>{err}</div>}
      <p style={D.subtle}>โทเคนที่ออกไปแล้วทั้งหมดจะใช้ไม่ได้ทันที (แคช 60 วินาทีถูกล้างให้ด้วย)</p>
    </div>
  );
}

function DrawerBar({ pct }: { pct: number }) {
  const color = pct >= 100 ? '#dc2626' : pct >= 80 ? '#b45309' : 'var(--color-primary)';
  return (
    <div style={S.funnelBarTrack}>
      <div style={{ ...S.funnelBarFill, width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/* ---------- small presentational components ---------- */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="admin-h2">{children}</h2>;
}

function Kpi({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: number | string | undefined;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'muted';
}) {
  const color =
    tone === 'good'
      ? 'var(--color-success)'
      : tone === 'warn'
        ? 'var(--color-warning-text)'
        : 'var(--color-text-primary)';
  return (
    <div style={S.card}>
      <div style={S.kpiLabel}>{label}</div>
      <div style={{ ...S.kpiValue, color }}>{value === undefined ? '—' : value}</div>
      {hint && <div style={S.kpiHint}>{hint}</div>}
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: AdminFunnel }) {
  const pct = funnel.completionRate ?? 0;
  return (
    <div style={S.card}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{funnel.name}</div>
      <div style={S.funnelBarTrack}>
        <div style={{ ...S.funnelBarFill, width: `${pct}%` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          เริ่ม {funnel.started.toLocaleString()} → สำเร็จ {funnel.completed.toLocaleString()}
        </span>
        <strong style={{ color: 'var(--color-primary)' }}>
          {funnel.completionRate === null ? '—' : `${funnel.completionRate}%`}
        </strong>
      </div>
    </div>
  );
}

/**
 * Section 5: referral funnel (issued → entered → activated) + creator
 * leaderboard. There is NO campaign/content tagging in the codebase, so campaign
 * attribution is an explicit "Coming soon" placeholder — not a fabricated scheme.
 */
function ReferralSection({ data }: { data: AdminReferral | null }) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  const f = data.funnel;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* funnel KPIs */}
      <div style={S.kpiGrid}>
        <Kpi label="โค้ดที่ออกแล้ว (สะสม)" value={f.issuedCodes} />
        <Kpi label="กรอกโค้ด (ครั้ง)" value={f.entered} hint={`${data.days} วัน`} />
        <Kpi label="กรอกสำเร็จ" value={f.activated} hint={`${data.days} วัน`} />
        <Kpi
          label="อัตราสำเร็จ"
          value={f.activationRate === null ? '—' : `${f.activationRate}%`}
          hint="สำเร็จ / กรอก"
          tone={f.activationRate !== null && f.activationRate >= 50 ? 'good' : 'muted'}
        />
      </div>

      {/* creator leaderboard */}
      <div style={S.card}>
        <div style={S.miniChartLabel}>ผู้ชวนเพื่อนสูงสุด (นับสำเร็จสะสม)</div>
        <div className="admin-table-wrap" style={{ marginTop: 8 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>โค้ด</th>
                <th>ชวนสำเร็จ</th>
              </tr>
            </thead>
            <tbody>
              {data.topReferrers.length === 0 && (
                <tr>
                  <td colSpan={3} style={S.emptyCell}>
                    ยังไม่มีข้อมูล
                  </td>
                </tr>
              )}
              {data.topReferrers.map((r) => (
                <tr key={r.userId}>
                  <td>{r.displayName ?? '—'}</td>
                  <td>
                    <code>{r.referralCode ?? '—'}</code>
                  </td>
                  <td>{r.referralCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* campaign attribution — not implemented */}
      <div style={{ ...S.card, borderStyle: 'dashed', opacity: 0.85 }}>
        <div style={S.panelHead}>
          <strong>การระบุแคมเปญ (Campaign attribution)</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>Coming soon</span>
        </div>
        <p style={S.panelNote}>
          ยังไม่มีระบบแท็กแคมเปญ/คอนเทนต์ (hook_id / content) ในโค้ดเบส — โค้ดชวนเพื่อนผูกกับผู้ใช้
          รายคนเท่านั้น ยังแยกที่มาตามแคมเปญไม่ได้ จะเพิ่มเมื่อมีการวางระบบแท็ก
        </p>
      </div>
    </div>
  );
}

/**
 * Section 6: per-user storage-fill histogram + daily quota-warning counts. The
 * warning series are the two SOFT thresholds (80 / 95 — matching
 * STORAGE_WARN_THRESHOLD_LOW/HIGH) plus the true 100%-blocked case, which is the
 * separate feature_blocked_quota event (there is no threshold=100 warning).
 */
function StorageSection({ data }: { data: AdminStorage | null }) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  const maxUsers = Math.max(1, ...data.histogram.map((b) => b.users));

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* fill histogram */}
      <div style={S.card}>
        <div style={S.miniChartLabel}>การกระจายของ % พื้นที่ที่ใช้ต่อผู้ใช้</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 160, marginTop: 8 }}>
          {data.histogram.map((b) => (
            <div key={b.bucket} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {b.users.toLocaleString()}
              </div>
              <div
                style={{
                  height: `${Math.round((b.users / maxUsers) * 120)}px`,
                  background: b.bucket === '100+' ? 'var(--color-warning-text)' : 'var(--color-primary)',
                  borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                  marginTop: 4,
                  transition: 'height 400ms ease',
                }}
              />
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
                {b.bucket === '100+' ? '100%+' : `${b.bucket}%`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* daily warnings */}
      <div style={S.card}>
        <div style={S.miniChartLabel}>ผู้ใช้ที่ชนเพดานพื้นที่ต่อวัน</div>
        <StackedBars
          data={data.warningsDaily}
          series={[
            { key: 'warn80', color: 'var(--color-primary-light)' },
            { key: 'warn95', color: 'var(--color-warning-text)' },
            { key: 'blocked', color: 'var(--color-danger, #d64545)' },
          ]}
        />
        <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
          <Legend color="var(--color-primary-light)" label="เตือน 80%" />
          <Legend color="var(--color-warning-text)" label="เตือน 95%" />
          <Legend color="var(--color-danger, #d64545)" label="เต็ม/อัปโหลดไม่ได้ (100%)" />
        </div>
      </div>
    </div>
  );
}

const MODULE_LABELS: Record<FeatureModule, string> = {
  storage: 'คลังไฟล์',
  vault: 'ห้องนิรภัย',
  diary: 'ไดอารี่',
  gift_box: 'กล่องของขวัญ',
  tasks: 'ระบบตามงาน',
  referral: 'ชวนเพื่อน',
};

const ERROR_FEATURE_LABELS: Record<string, string> = {
  convert: 'แปลงไฟล์เป็น Word',
  vault_unlock: 'ปลดล็อกห้องนิรภัย',
};

/**
 * Section 3: module-level adoption (% of active users touching each module),
 * the avg Feature Depth Score, and per-feature error rates. Error rates are only
 * shown where a failure event actually exists — uploads log no failure, so an
 * upload error rate is deliberately absent rather than faked.
 */
function AdoptionSection({ data }: { data: AdminAdoption | null }) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={S.kpiGrid}>
        <Kpi label="ผู้ใช้ที่ active" value={data.activeUsers} hint={`${data.days} วัน`} />
        <Kpi
          label="ความลึกฟีเจอร์เฉลี่ย"
          value={data.avgDepth}
          hint="จำนวนโมดูลเฉลี่ยต่อผู้ใช้"
          tone={data.avgDepth >= 2 ? 'good' : 'muted'}
        />
      </div>

      <div style={S.card}>
        <div style={S.miniChartLabel}>สัดส่วนผู้ใช้ active ที่แตะแต่ละโมดูล</div>
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {data.modules.map((m) => (
            <div key={m.module}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
                <span>{MODULE_LABELS[m.module]}</span>
                <span>
                  <strong>{m.pctOfActive === null ? '—' : `${m.pctOfActive}%`}</strong>{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>({m.users.toLocaleString()} คน)</span>
                </span>
              </div>
              <div style={{ ...S.funnelBarTrack, marginTop: 4 }}>
                <div style={{ ...S.funnelBarFill, width: `${m.pctOfActive ?? 0}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>อัตราความผิดพลาดต่อฟีเจอร์</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>เฉพาะฟีเจอร์ที่มี event ความล้มเหลว</span>
        </div>
        <p style={S.panelNote}>
          การอัปโหลดไม่มี event บันทึกความล้มเหลว จึงไม่มีอัตราผิดพลาดให้แสดง (ไม่ใช่ 0%)
        </p>
        <div className="admin-table-wrap" style={{ marginTop: 8 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>ฟีเจอร์</th>
                <th>สำเร็จ</th>
                <th>ล้มเหลว</th>
                <th>อัตราผิดพลาด</th>
              </tr>
            </thead>
            <tbody>
              {data.errorRates.length === 0 && (
                <tr>
                  <td colSpan={4} style={S.emptyCell}>
                    ยังไม่มีข้อมูล
                  </td>
                </tr>
              )}
              {data.errorRates.map((e) => (
                <tr key={e.feature}>
                  <td>{ERROR_FEATURE_LABELS[e.feature] ?? e.feature}</td>
                  <td>{e.ok.toLocaleString()}</td>
                  <td>{e.fail.toLocaleString()}</td>
                  <td>
                    {e.errorRate === null ? (
                      '—'
                    ) : (
                      <span style={e.errorRate > 10 ? S.badgeWarn : undefined}>{e.errorRate}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const FUNNEL_LABELS: Record<FunnelStage, { label: string; hint: string }> = {
  awareness: { label: 'รู้จัก (Awareness)', hint: 'ผู้ใช้ที่สมัครทั้งหมด' },
  consideration: { label: 'สนใจ (Consideration)', hint: 'มีกิจกรรมในช่วงนี้' },
  conversion: { label: 'เริ่มใช้ (Conversion)', hint: 'ทำงานที่มีคุณค่า (เก็บ/สร้างไฟล์)' },
  activation: { label: 'ติดใช้ (Activation)', hint: 'active ≥ 2 วัน' },
  referral: { label: 'บอกต่อ (Referral)', hint: 'มีกิจกรรมชวนเพื่อน' },
  retention: { label: 'อยู่ต่อ (Retention)', hint: '≥ 2 วัน และ active ใน 7 วันล่าสุด' },
};

/** Green intensity for a retention %; 0 → faint, 100 → strong. CSS-only heatmap. */
function heatColor(pct: number | null): string {
  if (pct === null) return 'var(--color-surface-3)';
  // alpha 0.08 → 0.85 mapped over 0..100%
  const a = 0.08 + (Math.max(0, Math.min(100, pct)) / 100) * 0.77;
  return `color-mix(in srgb, var(--color-success) ${Math.round(a * 100)}%, transparent)`;
}

/**
 * Section 1: the 6-stage product funnel (reach per stage) + a weekly D1/D7/D30
 * retention cohort heatmap. Stages are distinct-user reach, not strict drop-off
 * (Referral/Retention are parallel AARRR outcomes) — labelled as such.
 */
function FunnelSection({ data }: { data: AdminFunnelOverview | null }) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  const max = Math.max(1, ...data.funnel.map((s) => s.count));

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>เส้นทางผู้ใช้ 6 ขั้น</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>จำนวนผู้ใช้ไม่ซ้ำต่อขั้น (ไม่ใช่ drop-off เชิงลำดับ)</span>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {data.funnel.map((s) => {
            const meta = FUNNEL_LABELS[s.stage];
            const topPct = Math.round((s.count / max) * 100);
            return (
              <div key={s.stage} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{meta.label}</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{meta.hint}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ ...S.funnelBarTrack, flex: 1, height: 22 }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${topPct}%`,
                        background: 'var(--color-primary)',
                        borderRadius: 'var(--radius-full)',
                        transition: 'width 400ms ease',
                      }}
                    />
                  </div>
                  <strong style={{ minWidth: 48, textAlign: 'right' }}>{s.count.toLocaleString()}</strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Retention cohort heatmap */}
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>Retention รายรุ่น (สมัครรายสัปดาห์)</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>กลับมาใช้หลังสมัคร D1 / D7 / D30</span>
        </div>
        <div className="admin-table-wrap" style={{ marginTop: 12 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>รุ่น (สัปดาห์)</th>
                <th>ขนาด</th>
                <th>D1</th>
                <th>D7</th>
                <th>D30</th>
              </tr>
            </thead>
            <tbody>
              {data.cohorts.length === 0 && (
                <tr>
                  <td colSpan={5} style={S.emptyCell}>
                    ยังไม่มีข้อมูล
                  </td>
                </tr>
              )}
              {data.cohorts.map((c) => (
                <CohortRow key={c.week} cohort={c} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CohortRow({ cohort }: { cohort: AdminRetentionCohort }) {
  const now = Date.now();
  const weekMs = new Date(cohort.week).getTime();
  const DAY = 86400000;
  // A Dk cell is only meaningful once the cohort has had k full days to return.
  const cell = (n: number, k: number): { pct: number | null; mature: boolean } => {
    const mature = now - weekMs >= k * DAY;
    const pct = cohort.size > 0 ? Math.round((n / cohort.size) * 100) : null;
    return { pct: mature ? pct : null, mature };
  };
  const cells: [number, number][] = [
    [cohort.d1, 1],
    [cohort.d7, 7],
    [cohort.d30, 30],
  ];
  return (
    <tr>
      <td>{cohort.week}</td>
      <td>{cohort.size.toLocaleString()}</td>
      {cells.map(([n, k]) => {
        const { pct, mature } = cell(n, k);
        return (
          <td key={k} style={{ padding: 4 }}>
            <div
              style={{
                background: heatColor(pct),
                borderRadius: 'var(--radius-sm)',
                padding: '6px 4px',
                textAlign: 'center',
                fontSize: 'var(--font-size-sm)',
                color: pct !== null && pct >= 50 ? '#fff' : 'var(--color-text-primary)',
              }}
              title={mature ? `${n} / ${cohort.size}` : 'ยังไม่ครบกำหนด'}
            >
              {pct === null ? '·' : `${pct}%`}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

/** Seconds → compact Thai duration (e.g. "2 ชม 5 นาที", "45 วินาที"). */
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} วินาที`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} วัน${h % 24 ? ` ${h % 24} ชม` : ''}`;
  return `${h} ชม${rem ? ` ${rem} นาที` : ''}`;
}

const TASK_TYPE_LABELS: Record<'single' | 'multi' | 'recurring', string> = {
  single: 'เดี่ยว',
  multi: 'หลายรายการ',
  recurring: 'ทำซ้ำ',
};

const TASK_TYPE_COLORS: Record<'single' | 'multi' | 'recurring', string> = {
  single: 'var(--color-primary)',
  multi: 'var(--color-teal)',
  recurring: 'var(--color-primary-light)',
};

/**
 * ระบบตามงาน dashboard: creation-by-type over time, current-status breakdown and
 * completion timing. Completion % is over completable tasks only — recurring
 * tasks never reach 'done' by design, so they're excluded from the rate.
 */
function TasksSection({ data }: { data: AdminTasks | null }) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  const t = data.totals;
  const st = t.byStatus;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* headline metrics */}
      <div style={S.kpiGrid}>
        <Kpi label="งานที่สร้าง" value={t.totalCreated} hint={`${data.days} วัน`} />
        <Kpi
          label="ทำเสร็จ"
          value={t.completionRate === null ? '—' : `${t.completionRate}%`}
          hint="ไม่รวมงานทำซ้ำ"
          tone={t.completionRate !== null && t.completionRate >= 50 ? 'good' : 'muted'}
        />
        <Kpi
          label="เวลาเฉลี่ยจนเสร็จ"
          value={t.avgCompleteSec === null ? '—' : formatDuration(t.avgCompleteSec)}
        />
        <Kpi label="บันทึกลงปฏิทิน (ICS)" value={t.icsDownloads} />
        <Kpi label="กดเสร็จ (รายคน-รายการ)" value={t.markDoneCount} hint="ไม่ใช่ระดับงาน" />
      </div>

      {/* created per day, stacked by type */}
      <div style={S.card}>
        <div style={S.miniChartLabel}>งานที่สร้างต่อวัน (แยกตามประเภท)</div>
        <StackedBars
          data={data.daily}
          series={[
            { key: 'single', color: TASK_TYPE_COLORS.single },
            { key: 'multi', color: TASK_TYPE_COLORS.multi },
            { key: 'recurring', color: TASK_TYPE_COLORS.recurring },
          ]}
        />
        <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
          {(['single', 'multi', 'recurring'] as const).map((k) => (
            <Legend
              key={k}
              color={TASK_TYPE_COLORS[k]}
              label={`${TASK_TYPE_LABELS[k]} (${t.byType[k].toLocaleString()})`}
            />
          ))}
        </div>
      </div>

      {/* status breakdown */}
      <div style={S.card}>
        <div style={S.miniChartLabel}>สถานะงาน (ที่สร้างในช่วงนี้)</div>
        <StatusBar
          segments={[
            { label: 'เสร็จ', value: st.done, color: 'var(--color-success)' },
            { label: 'กำลังทำ', value: st.inProgress, color: 'var(--color-teal)' },
            { label: 'รอทำ', value: st.pending, color: 'var(--color-primary-light)' },
            { label: 'ยกเลิก', value: st.cancelled, color: 'var(--color-text-muted)' },
          ]}
        />
      </div>

    </div>
  );
}

/** Horizontal 100%-width proportional status bar with an inline legend. */
function StatusBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div>
      <div style={{ display: 'flex', height: 16, borderRadius: 'var(--radius-full)', overflow: 'hidden', background: 'var(--color-surface-3)' }}>
        {total > 0 &&
          segments.map((s) => (
            <div
              key={s.label}
              title={`${s.label}: ${s.value}`}
              style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            />
          ))}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
        {segments.map((s) => (
          <Legend key={s.label} color={s.color} label={`${s.label} (${s.value.toLocaleString()})`} />
        ))}
      </div>
    </div>
  );
}

/**
 * Pro-interest demand test — the gift-box fake door. Its source table is
 * anonymous, so this is tap counts only: no views, no dedup, no conversion %.
 * (The task-feature panel that used to sit above it, with a real deduped
 * view→click funnel, went away with the two ระบบตามงาน fake doors.)
 */
function ProInterestSection({ data }: { data: AdminProInterest | null }) {
  if (!data) {
    return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  }
  const label = (id: string): string => PRO_FEATURE_LABELS[id] ?? id;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* --- Gift-box: anonymous, event count only --- */}
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>กล่องของขวัญ (Gift-box)</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>
            ไม่ระบุตัวตน · นับจำนวนครั้ง ไม่ dedup · ไม่มีคอนเวอร์ชัน
          </span>
        </div>
        <p style={S.panelNote}>
          แหล่งข้อมูลนี้ไม่บันทึกผู้ใช้ จึงมีแค่ “จำนวนการกด” — ไม่ใช่จำนวนคน และไม่มีคอนเวอร์ชัน
        </p>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {data.giftbox.length === 0 && <p style={S.emptyCell}>ยังไม่มีข้อมูล</p>}
          {data.giftbox.map((g) => (
            <div key={g.feature} style={S.tapRow}>
              <span>{label(g.feature)}</span>
              <span style={S.tapCount}>{g.taps.toLocaleString()} ครั้ง</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={S.miniChartLabel}>การกดต่อวัน (กล่องของขวัญ)</div>
          <MiniLineChart
            points={data.daily.map((d) => ({ day: d.day, value: d.giftboxTaps }))}
            stroke="var(--color-teal)"
          />
        </div>
      </div>
    </div>
  );
}

/** Dependency-free single-series line chart with its OWN y-scale. */
function MiniLineChart({
  points,
  stroke,
}: {
  points: { day: string; value: number }[];
  stroke: string;
}) {
  if (points.length === 0) {
    return <p style={{ ...S.emptyCell, padding: 16 }}>ยังไม่มีข้อมูล</p>;
  }
  const W = 720;
  const H = 140;
  const padL = 28;
  const padB = 20;
  const padT = 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const x = (i: number): number =>
    padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number): number => padT + innerH - (v / max) * innerH;
  const linePts = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 420, display: 'block' }}>
        {/* max gridline */}
        <line x1={padL} y1={y(max)} x2={W - 8} y2={y(max)} stroke="var(--color-border)" strokeDasharray="3 3" />
        <text x={padL - 4} y={y(max) + 3} fontSize={9} textAnchor="end" fill="var(--color-text-muted)">
          {max}
        </text>
        {points.length > 1 && <polyline points={linePts} fill="none" stroke={stroke} strokeWidth={2} />}
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={2.5} fill={stroke} />
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`t${i}`}
              x={x(i)}
              y={H - 5}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {p.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/** Dependency-free growth chart: active-user bars + a new-user dot line. */
function GrowthChart({ series }: { series: AdminTimeseriesPoint[] }) {
  if (series.length === 0) {
    return <p style={{ ...S.emptyCell, padding: 24 }}>ยังไม่มีข้อมูล — กราฟจะขึ้นเมื่อมีการใช้งาน</p>;
  }
  const W = 720;
  const H = 220;
  const padL = 32;
  const padB = 24;
  const padT = 12;
  const maxActive = Math.max(1, ...series.map((d) => d.activeUsers));
  const maxNew = Math.max(1, ...series.map((d) => d.newUsers));
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const barW = innerW / series.length;
  const x = (i: number): number => padL + i * barW;
  const yA = (v: number): number => padT + innerH - (v / maxActive) * innerH;
  const yN = (v: number): number => padT + innerH - (v / maxNew) * innerH;

  const linePts = series.map((d, i) => `${x(i) + barW / 2},${yN(d.newUsers)}`).join(' ');
  const labelEvery = Math.ceil(series.length / 8);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480, display: 'block' }}>
        {/* active-user bars */}
        {series.map((d, i) => {
          const h = padT + innerH - yA(d.activeUsers);
          return (
            <rect
              key={i}
              x={x(i) + barW * 0.15}
              y={yA(d.activeUsers)}
              width={barW * 0.7}
              height={Math.max(0, h)}
              rx={2}
              fill="var(--color-primary-light)"
              opacity={0.85}
            />
          );
        })}
        {/* new-user line */}
        {series.length > 1 && (
          <polyline points={linePts} fill="none" stroke="var(--color-teal)" strokeWidth={2} />
        )}
        {series.map((d, i) => (
          <circle key={`c${i}`} cx={x(i) + barW / 2} cy={yN(d.newUsers)} r={2.5} fill="var(--color-teal)" />
        ))}
        {/* x labels */}
        {series.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`t${i}`}
              x={x(i) + barW / 2}
              y={H - 6}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {d.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 'var(--font-size-sm)', marginTop: 4 }}>
        <Legend color="var(--color-primary-light)" label="ผู้ใช้ active/วัน" />
        <Legend color="var(--color-teal)" label="สมัครใหม่/วัน" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
    </span>
  );
}

/* ---------- inline style tokens (reuse global CSS variables) ---------- */

const S: Record<string, React.CSSProperties> = {
  rangeRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0' },
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
  kpiGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
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
  kpiLabel: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 6 },
  kpiValue: { fontSize: '1.7rem', fontWeight: 700, lineHeight: 1.1 },
  kpiHint: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 },
  funnelGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 12,
  },
  funnelBarTrack: {
    height: 10,
    background: 'var(--color-surface-3)',
    borderRadius: 'var(--radius-full)',
    overflow: 'hidden',
  },
  funnelBarFill: {
    height: '100%',
    background: 'var(--color-primary)',
    borderRadius: 'var(--radius-full)',
    transition: 'width 400ms ease',
  },
  emptyCell: { textAlign: 'center', color: 'var(--color-text-muted)' },
  panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  panelTag: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-primary)',
    background: 'var(--color-primary-soft, var(--color-surface-3))',
    borderRadius: 'var(--radius-full)',
    padding: '2px 10px',
    fontWeight: 600,
  },
  panelTagMuted: { color: 'var(--color-text-secondary)', background: 'var(--color-surface-3)' },
  panelNote: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 6 },
  miniChartLabel: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 },
  tapRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: 'var(--color-surface-3)',
    borderRadius: 'var(--radius-sm)',
  },
  tapCount: { fontWeight: 700, color: 'var(--color-text-primary)' },
  badgeWarn: {
    background: 'var(--color-warning-soft)',
    color: 'var(--color-warning-text)',
    borderRadius: 'var(--radius-full)',
    padding: '2px 8px',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
  },
};

/* ---------- UserDetailDrawer tokens ----------
   A right-side drawer has no equivalent in globals.css (.modal-overlay is a
   centred dialog with its own backdrop treatment), so these are local rather
   than a reuse of an existing class. */

const D: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.35)',
    display: 'flex',
    justifyContent: 'flex-end',
    zIndex: 60,
  },
  panel: {
    width: 'min(440px, 100%)',
    height: '100%',
    overflowY: 'auto',
    background: 'var(--color-surface)',
    borderLeft: '1px solid var(--color-border)',
    padding: 20,
    boxShadow: 'var(--shadow-lg, 0 0 24px rgba(0,0,0,0.2))',
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  title: { fontSize: 'var(--font-size-lg)', fontWeight: 700 },
  h3: { fontSize: 'var(--font-size-sm)', fontWeight: 700, margin: '18px 0 8px' },
  subtle: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: '2px 0' },
  errorText: { fontSize: 'var(--font-size-xs)', color: '#dc2626', margin: '2px 0' },
  badgeRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
  planBadge: {
    background: 'var(--color-primary)',
    color: '#fff',
    borderRadius: 'var(--radius-full)',
    padding: '2px 12px',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
  },
  rawBadge: {
    background: 'var(--color-surface-3)',
    color: 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-full)',
    padding: '2px 10px',
    fontSize: 'var(--font-size-xs)',
  },
  quotaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    fontSize: 'var(--font-size-xs)',
    marginBottom: 4,
  },

  /* ---------- TIER 2 write controls ----------
     Boxed and left-bordered so a control that CHANGES the account is visually
     distinct from the read-only fields it sits between. */
  control: {
    margin: '10px 0 4px',
    padding: '10px 12px',
    borderLeft: '3px solid var(--color-primary)',
    background: 'var(--color-surface-3)',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  controlLabel: { fontSize: 'var(--font-size-xs)', fontWeight: 700 },
  controlRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  smallBtn: { padding: '4px 12px', fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap' },
  dangerBtn: { color: 'var(--color-danger, #dc2626)', borderColor: 'rgba(220, 38, 38, 0.4)' },
  okText: { fontSize: 'var(--font-size-xs)', color: '#16a34a', fontWeight: 600 },
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
    width: 110,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
  },
};

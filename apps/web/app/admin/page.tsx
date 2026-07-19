'use client';

import { useEffect, useState } from 'react';
import {
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
  type AdminUser,
  type FeatureModule,
  type FunnelStage,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';

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

// Pro fake-door feature labels (task Pro features + gift-box demand-test entries).
const PRO_FEATURE_LABELS: Record<string, string> = {
  // task Pro features (migration 040 / ProFeatureSection)
  task_auto_reminder: 'เตือนงานอัตโนมัติ',
  task_voice_command: 'สั่งงานด้วยเสียง',
  // gift-box demand test (migration 034 / anonymous)
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
        <a className="btn secondary" href="/dashboard">
          กลับคลังไฟล์
        </a>
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
            <TasksSection data={tasks} proInterest={proInterest} />

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
                    <tr key={u.id}>
                      <td>
                        {u.displayName ?? '—'} {u.isAdmin && <span className="tag-chip">admin</span>}
                      </td>
                      <td>{u.plan}</td>
                      <td>{u.fileCount}</td>
                      <td>{formatBytes(u.storageUsed)}</td>
                      <td>{formatBytes(u.storageLimit)}</td>
                      <td>
                        <button className="btn secondary" onClick={() => void editQuota(u)}>
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
    </>
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
 * ระบบตามงาน dashboard: creation-by-type over time, current-status breakdown,
 * completion timing, and the two task Pro-features compared head-to-head (spec
 * Task 4). Completion % is over completable tasks only — recurring tasks never
 * reach 'done' by design, so they're excluded from the rate.
 */
function TasksSection({
  data,
  proInterest,
}: {
  data: AdminTasks | null;
  proInterest: AdminProInterest | null;
}) {
  if (!data) return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  const t = data.totals;
  const st = t.byStatus;

  // Task Pro-feature interest, as directly-comparable bars (unique interested
  // users, deduped). Pulled from the already-loaded pro-interest data.
  const proFeatures = proInterest?.tasks ?? [];
  const proMax = Math.max(1, ...proFeatures.map((f) => f.registeredUsers));

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

      {/* Pro-feature interest — directly comparable bars */}
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>ความสนใจฟีเจอร์ Pro ของงาน</strong>
          <span style={S.panelTag}>ผู้ใช้สนใจไม่ซ้ำ (deduped)</span>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {proFeatures.length === 0 && <p style={S.emptyCell}>ยังไม่มีข้อมูล</p>}
          {proFeatures.map((f) => (
            <div key={f.featureId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
                <span>{PRO_FEATURE_LABELS[f.featureId] ?? f.featureId}</span>
                <strong>{f.registeredUsers.toLocaleString()} คน</strong>
              </div>
              <div style={{ ...S.funnelBarTrack, marginTop: 4 }}>
                <div
                  style={{
                    ...S.funnelBarFill,
                    width: `${Math.round((f.registeredUsers / proMax) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
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

/** Dependency-free stacked bar chart over a daily series (each row summed). */
function StackedBars<T extends { day: string }>({
  data,
  series,
}: {
  data: T[];
  series: { key: keyof T; color: string }[];
}) {
  if (data.length === 0) {
    return <p style={{ ...S.emptyCell, padding: 16 }}>ยังไม่มีข้อมูล</p>;
  }
  const W = 720;
  const H = 180;
  const padL = 28;
  const padB = 20;
  const padT = 10;
  const total = (d: T): number => series.reduce((a, s) => a + Number(d[s.key] ?? 0), 0);
  const max = Math.max(1, ...data.map(total));
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const barW = innerW / data.length;
  const x = (i: number): number => padL + i * barW;
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 420, display: 'block' }}>
        <line x1={padL} y1={padT} x2={W - 8} y2={padT} stroke="var(--color-border)" strokeDasharray="3 3" />
        <text x={padL - 4} y={padT + 3} fontSize={9} textAnchor="end" fill="var(--color-text-muted)">
          {max}
        </text>
        {data.map((d, i) => {
          let yCursor = padT + innerH;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = Number(d[s.key] ?? 0);
                const h = (v / max) * innerH;
                yCursor -= h;
                return h > 0 ? (
                  <rect
                    key={String(s.key)}
                    x={x(i) + barW * 0.15}
                    y={yCursor}
                    width={barW * 0.7}
                    height={h}
                    fill={s.color}
                  />
                ) : null;
              })}
            </g>
          );
        })}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`t${i}`}
              x={x(i) + barW / 2}
              y={H - 5}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {d.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/**
 * Pro-interest demand test — TWO deliberately separate panels. Task features
 * have a real deduped view→click funnel; the gift-box test is anonymous tap
 * counts only. They are never put on a shared scale (that would imply the two
 * numbers are comparable, which they are not).
 */
function ProInterestSection({ data }: { data: AdminProInterest | null }) {
  if (!data) {
    return <p style={{ ...S.emptyCell, padding: 24 }}>กำลังโหลด…</p>;
  }
  const label = (id: string): string => PRO_FEATURE_LABELS[id] ?? id;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* --- Task Pro features: unique users, deduped --- */}
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>ฟีเจอร์งาน (Task)</strong>
          <span style={S.panelTag}>ผู้ใช้ไม่ซ้ำ · นับแบบ deduped</span>
        </div>
        <div className="admin-table-wrap" style={{ marginTop: 12 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>ฟีเจอร์</th>
                <th>เห็น (คน)</th>
                <th>กด “แจ้งเตือน” (คน)</th>
                <th>คอนเวอร์ชัน</th>
                <th>สนใจสะสม (คน)</th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.length === 0 && (
                <tr>
                  <td colSpan={5} style={S.emptyCell}>
                    ยังไม่มีข้อมูล
                  </td>
                </tr>
              )}
              {data.tasks.map((t) => (
                <tr key={t.featureId}>
                  <td>{label(t.featureId)}</td>
                  <td>{t.viewUsers.toLocaleString()}</td>
                  <td>{t.clickUsers.toLocaleString()}</td>
                  <td>
                    {t.conversionRate === null ? (
                      '—'
                    ) : (
                      <strong style={{ color: 'var(--color-primary)' }}>{t.conversionRate}%</strong>
                    )}
                  </td>
                  <td>{t.registeredUsers.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={S.miniChartLabel}>คลิกสนใจต่อวัน (ฟีเจอร์งาน)</div>
          <MiniLineChart
            points={data.daily.map((d) => ({ day: d.day, value: d.taskClicks }))}
            stroke="var(--color-primary)"
          />
        </div>
      </div>

      {/* --- Gift-box: anonymous, event count only --- */}
      <div style={S.card}>
        <div style={S.panelHead}>
          <strong>กล่องของขวัญ (Gift-box)</strong>
          <span style={{ ...S.panelTag, ...S.panelTagMuted }}>
            ไม่ระบุตัวตน · นับจำนวนครั้ง ไม่ dedup · ไม่มีคอนเวอร์ชัน
          </span>
        </div>
        <p style={S.panelNote}>
          แหล่งข้อมูลนี้ไม่บันทึกผู้ใช้ จึงมีแค่ “จำนวนการกด” — เทียบกับตัวเลขฟีเจอร์งานด้านบนไม่ได้
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

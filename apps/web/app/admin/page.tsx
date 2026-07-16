'use client';

import { useEffect, useState } from 'react';
import {
  ApiError,
  getAdminFeatures,
  getAdminOverview,
  getAdminPowerUsers,
  getAdminTimeseries,
  hasSession,
  listAdminSpaces,
  listAdminUsers,
  setUserQuota,
  type AdminFeatureRow,
  type AdminFunnel,
  type AdminOverview,
  type AdminPowerUser,
  type AdminSpace,
  type AdminTimeseriesPoint,
  type AdminUser,
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

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

export default function AdminPage() {
  const [days, setDays] = useState<Range>(30);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [series, setSeries] = useState<AdminTimeseriesPoint[]>([]);
  const [features, setFeatures] = useState<AdminFeatureRow[]>([]);
  const [funnels, setFunnels] = useState<AdminFunnel[]>([]);
  const [powerUsers, setPowerUsers] = useState<AdminPowerUser[]>([]);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [spaces, setSpaces] = useState<AdminSpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAnalytics(range: Range): Promise<void> {
    const [ov, ts, ft, pu] = await Promise.all([
      getAdminOverview(),
      getAdminTimeseries(range),
      getAdminFeatures(range),
      getAdminPowerUsers(range),
    ]);
    setOverview(ov);
    setSeries(ts.series);
    setFeatures(ft.features);
    setFunnels(ft.funnels);
    setPowerUsers(pu.users);
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

            {/* Feature adoption */}
            <SectionTitle>ฟีเจอร์ไหนถูกใช้จริง ({days} วัน)</SectionTitle>
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
                      {/* A row only exists when eventCount > 0, so uniqueUsers === 0
                          can only mean every event in it has a NULL user_id — i.e.
                          "not attributed", NOT "nobody used it". Rendering the raw 0
                          read as a measurement of zero and led to a wrong call about
                          which features were dead. */}
                      <td>
                        {f.uniqueUsers === 0 ? (
                          <span
                            style={S.unattributed}
                            title="ยังไม่ได้บันทึกว่าใครเป็นคนทำ — ดูจำนวนครั้งแทน"
                          >
                            —
                          </span>
                        ) : (
                          f.uniqueUsers.toLocaleString()
                        )}
                      </td>
                      <td>{f.eventCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={S.tableNote}>
              <strong>—</strong> ในคอลัมน์ &ldquo;ผู้ใช้&rdquo; แปลว่ายังไม่ได้บันทึกว่าใครเป็นคนทำ
              ไม่ได้แปลว่าไม่มีคนใช้ — ให้อ่านจำนวนครั้งแทน กิจกรรมจากแชทที่เก็บไว้ก่อนหน้านี้
              ยังไม่ผูกผู้ใช้ และจะทยอยผูกเองตั้งแต่ตอนนี้เป็นต้นไป
            </p>

            {/* Funnels */}
            <SectionTitle>อัตราทำสำเร็จของแต่ละฟีเจอร์ (funnel)</SectionTitle>
            <div style={S.funnelGrid}>
              {funnels.map((f) => (
                <FunnelCard key={f.name} funnel={f} />
              ))}
            </div>

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
  /** The "not attributed" dash — muted so it reads as absent data, not as a value. */
  unattributed: { color: 'var(--color-text-muted)', cursor: 'help' },
  tableNote: {
    margin: '8px 2px 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--color-text-muted)',
  },
  badgeWarn: {
    background: 'var(--color-warning-soft)',
    color: 'var(--color-warning-text)',
    borderRadius: 'var(--radius-full)',
    padding: '2px 8px',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
  },
};

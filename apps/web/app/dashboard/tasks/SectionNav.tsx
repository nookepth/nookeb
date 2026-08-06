'use client';

import styles from './tasks.module.css';

export type Section =
  | 'overview'
  | 'mine'
  | 'status'
  | 'calendar'
  | 'team'
  | 'analysis'
  | 'howto';

export const SECTION_ORDER: Section[] = [
  'overview',
  'mine',
  'status',
  'calendar',
  'team',
  'analysis',
  'howto',
];

export const SECTION_LABEL: Record<Section, string> = {
  overview: 'ภาพรวม',
  mine: 'งานของฉัน',
  status: 'ติดตามสถานะ',
  calendar: 'ปฏิทิน',
  team: 'รายงานทีม',
  analysis: 'วิเคราะห์',
  howto: 'วิธีใช้',
};

/** One-line description under the nav — says what THIS zone is for, so the
 *  page never has to be scanned to work out where something lives. */
export const SECTION_HINT: Record<Section, string> = {
  overview: 'สรุปงานทั้งหมดในหน้าเดียว — งานวันนี้ ยอดรวมแต่ละสถานะ และความเคลื่อนไหวล่าสุด',
  mine: 'รายการงานทั้งหมด ค้นหา กรอง เรียง และทำเครื่องหมายว่าเสร็จได้ตรงนี้',
  status: 'ดูว่างานแต่ละชิ้นค้างอยู่ขั้นไหน ตั้งแต่รอดำเนินการจนถึงรอตรวจและตีกลับ',
  calendar: 'ปฏิทินกำหนดส่ง แตะวันที่เพื่อดูเฉพาะงานของวันนั้น',
  team: 'สรุปงานรายคน ใครรับไปเท่าไหร่ เสร็จเท่าไหร่ และตรงเวลาแค่ไหน',
  analysis: 'สถิติการทำงานของเธอเอง แนวโน้มรายสัปดาห์ และจุดที่มักเลยกำหนด',
  howto: 'คำสั่งในแชท LINE และปุ่มลัดทั้งหมดที่หนูรองรับ',
};

function SectionIcon({ section, size = 16 }: { section: Section; size?: number }) {
  const p = { stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<Section, JSX.Element> = {
    overview: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" {...p} fill="none" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" {...p} fill="none" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" {...p} fill="none" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" {...p} fill="none" />
      </>
    ),
    mine: (
      <>
        <path d="M8 6h12M8 12h12M8 18h12" {...p} />
        <circle cx="4" cy="6" r="1.3" fill="currentColor" />
        <circle cx="4" cy="12" r="1.3" fill="currentColor" />
        <circle cx="4" cy="18" r="1.3" fill="currentColor" />
      </>
    ),
    status: (
      <>
        <path d="M4 18V9M10 18V5M16 18v-6M4 21h16" {...p} />
      </>
    ),
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" {...p} fill="none" />
        <path d="M3.5 9.5h17M8 2.8v4M16 2.8v4" {...p} />
      </>
    ),
    team: (
      <>
        <circle cx="9" cy="8.5" r="3.4" {...p} fill="none" />
        <path d="M3.2 19.5a5.8 5.8 0 0 1 11.6 0M16 5.4a3.4 3.4 0 0 1 0 6.4M17.5 14.2a5.8 5.8 0 0 1 3.3 5.3" {...p} fill="none" />
      </>
    ),
    analysis: (
      <>
        <path d="M4 16.5 9.5 11l3.5 3.5L20 7" {...p} />
        <path d="M20 12V7h-5" {...p} />
      </>
    ),
    howto: (
      <>
        <circle cx="12" cy="12" r="8.7" {...p} fill="none" />
        <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.5" {...p} />
        <circle cx="12" cy="16.8" r="1.1" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {paths[section]}
    </svg>
  );
}

/**
 * Page-level zone nav. Each entry is ONE focused data set — the four status
 * tabs (กำลังทำ / เลยกำหนด / เสร็จสิ้น / ยกเลิก) stay inside งานของฉัน, where
 * they belong, instead of competing with these for the same row.
 *
 * `badges` carries the number worth interrupting for (overdue count on
 * งานของฉัน, items awaiting review on ติดตามสถานะ) — never a plain total, which
 * would put a red dot on every tab permanently and mean nothing.
 */
export default function SectionNav({
  section,
  onChange,
  badges,
}: {
  section: Section;
  onChange: (s: Section) => void;
  badges?: Partial<Record<Section, number>>;
}) {
  return (
    <nav className={styles.sectionNav} aria-label="ส่วนของหน้า">
      <div className={styles.sectionNavRow} role="tablist">
        {SECTION_ORDER.map((s) => {
          const badge = badges?.[s] ?? 0;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={section === s}
              className={`${styles.sectionTab} ${section === s ? styles.sectionTabActive : ''}`}
              onClick={() => onChange(s)}
            >
              <span className={styles.sectionTabIcon}>
                <SectionIcon section={s} />
              </span>
              {SECTION_LABEL[s]}
              {badge > 0 && <span className={styles.sectionTabBadge}>{badge}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

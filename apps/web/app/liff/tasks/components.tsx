'use client';

import styles from './tasks.module.css';
import type { DraftMember } from '../../../lib/taskDraft';

/** Circle avatar: picture when available, else the name's first character. */
export function Avatar({
  member,
  size = 40,
}: {
  member: DraftMember;
  size?: number;
}) {
  const initial = (member.displayName ?? '?').trim().charAt(0) || '?';
  const style = { width: size, height: size, fontSize: size * 0.38 };
  return member.pictureUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain varies
    <img className={styles.avatar} style={style} src={member.pictureUrl} alt="" />
  ) : (
    <div className={styles.avatar} style={style}>
      {initial}
    </div>
  );
}

/** Overlapping avatar row, capped with a "+N" tail. */
export function AvatarStack({
  members,
  size = 28,
  max = 5,
}: {
  members: DraftMember[];
  size?: number;
  max?: number;
}) {
  const shown = members.slice(0, max);
  return (
    <div className={styles.stack}>
      {shown.map((m) => (
        <div key={m.lineUid} className={styles.stackItem}>
          <Avatar member={m} size={size} />
        </div>
      ))}
      {members.length > max && (
        <span className={styles.stackMore}>+{members.length - max}</span>
      )}
    </div>
  );
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DeadlineChip({ iso }: { iso: string | null }) {
  if (!iso) return <span className={styles.deadlineChip}>ตาม deadline งาน</span>;
  const overdue = new Date(iso).getTime() < Date.now();
  return (
    <span className={`${styles.deadlineChip} ${overdue ? styles.deadlineChipOverdue : ''}`}>
      {formatDeadline(iso)}
    </span>
  );
}

export function MemberRow({
  member,
  selected,
  onToggle,
}: {
  member: DraftMember;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={styles.memberRow} onClick={onToggle}>
      <Avatar member={member} />
      <span className={styles.memberName}>{member.displayName ?? 'สมาชิก'}</span>
      <span className={`${styles.checkmark} ${selected ? styles.checkmarkOn : ''}`}>✓</span>
    </button>
  );
}

/** Loading skeleton — list shape so nothing ever flashes a blank white page. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={styles.memberList} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <div className={styles.skeletonCircle} />
          <div className={styles.skeletonBar} style={{ width: `${45 + (i % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Empty roster: nobody has registered in this group yet. */
export function EmptyRoster() {
  const copy = () => {
    void navigator.clipboard?.writeText('/register').catch(() => {});
  };
  return (
    <div className={`${styles.card} ${styles.emptyState}`} style={{ margin: '0 20px' }}>
      <p className={styles.emptyTitle}>ยังไม่มีใครลงทะเบียนในกลุ่มนี้เลยน้า</p>
      <p className={styles.emptyText}>
        ให้เพื่อนๆ พิมพ์คำนี้ในกลุ่ม LINE
        <br />
        เพื่อให้เลือกมอบหมายงานได้
      </p>
      <div className={styles.codeBox}>
        <span>/register</span>
        <button type="button" className={styles.ghostBtn} onClick={copy}>
          คัดลอก
        </button>
      </div>
    </div>
  );
}

'use client';

import styles from './tasks.module.css';
import type { DraftMember } from '../../../lib/taskDraft';

/* ---- inline SVG icons (brand rule: no emoji in UI text) ---- */

export function IconSearch({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.8-3.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClose({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconCalendar({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 9.5h17M8 2.8v4M16 2.8v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconClipboard({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="4" width="15" height="17" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="8.5" y="2" width="7" height="4" rx="1.5" fill="currentColor" />
      <path d="M8.5 11h7M8.5 15h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconListChecks({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m3.5 5.5 1.5 1.5L7.5 4.5M3.5 12.5 5 14l2.5-2.5M3.5 19.5 5 21l2.5-2.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 6h9.5M11 13h9.5M11 20h9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconRepeat({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M17.5 2.5v4h-4M6.5 21.5v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconUsers({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M3 19c0-3 2.7-5 6-5s6 2 6 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M15.5 5.2a3.5 3.5 0 0 1 0 5.6M17.8 14.6c1.9.8 3.2 2.4 3.2 4.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconBell({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9a6 6 0 0 1 12 0c0 4 1.2 5.6 2 6.5H4c.8-.9 2-2.5 2-6.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9.5 19a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconMic({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconLock({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Circle avatar: picture when available, else the name's first character. */
export function Avatar({
  member,
  size = 44,
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
    <button
      type="button"
      className={`${styles.memberRow} ${selected ? styles.memberRowSelected : ''}`}
      aria-pressed={selected}
      onClick={onToggle}
    >
      <Avatar member={member} />
      <span className={styles.memberName}>{member.displayName ?? 'สมาชิก'}</span>
      <span className={`${styles.checkmark} ${selected ? styles.checkmarkOn : ''}`}>
        <IconCheck />
      </span>
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

/**
 * State card for every non-happy path (empty roster / not in group / session
 * expired / fetch failed): title + plain-language explanation + retry action.
 * Never a dead-end error string.
 */
export function StateNotice({
  title,
  body,
  onRetry,
  retryLabel = 'ลองใหม่อีกที',
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={styles.stateCard}>
      <div className={styles.stateIcon}>
        <IconUsers />
      </div>
      <p className={styles.stateTitle}>{title}</p>
      <p className={styles.stateText}>{body}</p>
      {onRetry && (
        <button type="button" className={styles.retryBtn} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

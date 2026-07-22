'use client';

import { FILTER_LABEL, SORT_LABEL, type TaskFilter, type TaskSort } from './taskInsights';
import styles from './tasks.module.css';

function SortIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M7 12h10M10 17h4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5v11m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 17.5v1.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-1.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Scope-filter chips + sort dropdown + Excel export. Selection persists in
 * sessionStorage (handled by the page). Chips scroll horizontally at 375px. */
export default function FilterSortBar({
  filter,
  sort,
  onFilter,
  onSort,
  onExport,
  exporting = false,
}: {
  filter: TaskFilter;
  sort: TaskSort;
  onFilter: (f: TaskFilter) => void;
  onSort: (s: TaskSort) => void;
  onExport?: () => void;
  exporting?: boolean;
}) {
  return (
    <div className={styles.filterBar}>
      <div className={styles.chipRow} role="group" aria-label="กรองงาน">
        {(Object.keys(FILTER_LABEL) as TaskFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.chip} ${filter === f ? styles.chipActive : ''}`}
            aria-pressed={filter === f}
            onClick={() => onFilter(f)}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      <div className={styles.filterActions}>
        <label className={styles.sortWrap}>
          <span className={styles.sortIcon}>
            <SortIcon />
          </span>
          <select
            className={styles.sortSelect}
            value={sort}
            onChange={(e) => onSort(e.target.value as TaskSort)}
            aria-label="เรียงตาม"
          >
            {(Object.keys(SORT_LABEL) as TaskSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {onExport && (
          <button
            type="button"
            className={styles.exportBtn}
            onClick={onExport}
            disabled={exporting}
            aria-label="ดาวน์โหลดงานเป็นไฟล์ Excel"
          >
            <DownloadIcon />
            {exporting ? 'กำลังสร้างไฟล์...' : 'Export Excel'}
          </button>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './tasks.module.css';

const SIZE = 84;
const STROKE = 8;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

/** Animated month-progress ring: sweeps 0 → pct on mount (skipped for
 * prefers-reduced-motion). Center shows "X/Y งาน". */
export default function ProgressRing({ done, total }: { done: number; total: number }) {
  const target = total > 0 ? done / total : 0;
  const [ratio, setRatio] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRatio(target);
      return;
    }
    const start = performance.now();
    const dur = 800;
    const tick = (now: number) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setRatio(target * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    // rAF is throttled/paused in background tabs — snap to the target so the
    // ring is never stuck at 0% when the tab becomes visible
    const failsafe = window.setTimeout(() => setRatio(target), dur + 200);
    return () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(failsafe);
    };
  }, [target]);

  const pct = Math.round(ratio * 100);
  return (
    <div
      className={styles.ringWrap}
      role="img"
      aria-label={`เดือนนี้เสร็จ ${done} จาก ${total} งาน (${Math.round(target * 100)}%)`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#f0e2e1" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="#b53a32"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - ratio)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <div className={styles.ringCenter}>
        <span className={styles.ringCount}>
          {done}/{total}
        </span>
        <span className={styles.ringLabel}>งาน</span>
      </div>
      <span className={styles.ringPct}>{pct}%</span>
    </div>
  );
}

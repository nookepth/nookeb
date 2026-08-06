'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  characterSrc,
  defaultPos,
  loadMascotPositions,
  loadMascotsHidden,
  saveMascotPositions,
  saveMascotsHidden,
  type MascotPos,
  type PersonStats,
} from './mascots';
import styles from './tasks.module.css';

/** How many faces may float at once. Beyond this the layer stops being ambient
 *  and starts being a crowd standing in front of the content. */
const MAX_FLOATING = 6;

/** Drag threshold in px — below it the gesture is a click (opens the report),
 *  above it the mascot moves. Without it every tap nudges the character. */
const DRAG_SLOP = 4;

function clamp01(v: number, pad: number): number {
  return Math.min(1 - pad, Math.max(pad, v));
}

function EyeOffIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8M6.5 6.7C4.6 8 3.2 9.9 2.5 12c1.6 4.2 5.3 6.8 9.5 6.8 1.6 0 3.1-.4 4.4-1.1M9.9 5.4A9.9 9.9 0 0 1 12 5.2c4.2 0 7.9 2.6 9.5 6.8-.6 1.6-1.5 3-2.7 4.2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SparkIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The floating crew — one draggable character per person in the roster.
 *
 * Implementation notes:
 * - No new dependency. The bob is a CSS keyframe on an INNER element, so it
 *   never fights the outer element's drag transform; the drag itself is plain
 *   Pointer Events with `setPointerCapture`, which is what a library would do
 *   anyway and survives the pointer leaving the element mid-drag.
 * - Positions are stored as viewport FRACTIONS, so a window resize (or a
 *   different monitor next visit) keeps everyone on screen instead of parking
 *   them past the right edge.
 * - Desktop only for this pass: the layer is hidden below 1024px in CSS, and it
 *   also skips coarse pointers, where a fixed sprite over the content would sit
 *   on top of the list people are trying to tap.
 */
export default function MascotLayer({
  people,
  onSelect,
}: {
  people: PersonStats[];
  /** clicking a mascot jumps to that person's row in รายงานทีม */
  onSelect?: (lineUid: string) => void;
}) {
  const [positions, setPositions] = useState<Record<string, MascotPos>>({});
  const [hidden, setHidden] = useState(true); // hidden until prefs load — no flash
  const [ready, setReady] = useState(false);
  const [draggingUid, setDraggingUid] = useState<string | null>(null);
  const dragState = useRef<{ uid: string; dx: number; dy: number; moved: boolean } | null>(null);
  const posRef = useRef<Record<string, MascotPos>>({});

  useEffect(() => {
    const stored = loadMascotPositions();
    posRef.current = stored;
    setPositions(stored);
    setHidden(loadMascotsHidden());
    setReady(true);
  }, []);

  const crew = people.slice(0, MAX_FLOATING);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, uid: string) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    dragState.current = { uid, dx: e.clientX - cx, dy: e.clientY - cy, moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // capture is an optimisation (it keeps the move events coming when the
      // pointer outruns the sprite); a browser that refuses it must not take
      // the whole drag down with it
    }
    setDraggingUid(uid);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (!st.moved && Math.abs(e.clientX - st.dx - cx) < DRAG_SLOP && Math.abs(e.clientY - st.dy - cy) < DRAG_SLOP) {
      return;
    }
    st.moved = true;
    // pad keeps the sprite fully on screen (half its own width, roughly)
    const x = clamp01((e.clientX - st.dx) / window.innerWidth, 0.04);
    const y = clamp01((e.clientY - st.dy) / window.innerHeight, 0.06);
    // The ref is written SYNCHRONOUSLY and is what gets persisted. Reading the
    // state on pointerup instead would save whatever React had committed by
    // then — reliably one move behind the place the user let go of.
    posRef.current = { ...posRef.current, [st.uid]: { x, y } };
    setPositions(posRef.current);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, uid: string) => {
      const st = dragState.current;
      dragState.current = null;
      setDraggingUid(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already released */
      }
      if (st?.moved) saveMascotPositions(posRef.current);
      else onSelect?.(uid);
    },
    [onSelect],
  );

  const toggleHidden = () => {
    setHidden((h) => {
      saveMascotsHidden(!h);
      return !h;
    });
  };

  if (!ready || crew.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className={styles.mascotToggle}
        onClick={toggleHidden}
        aria-pressed={!hidden}
        title={hidden ? 'แสดงเพื่อนร่วมงาน' : 'ซ่อนเพื่อนร่วมงาน'}
      >
        {hidden ? <SparkIcon /> : <EyeOffIcon />}
        {hidden ? 'เรียกทีมออกมา' : 'ซ่อนทีม'}
      </button>

      {!hidden && (
        <div className={styles.mascotLayer} aria-hidden={false}>
          {crew.map((p, i) => {
            const pos = positions[p.lineUid] ?? defaultPos(i);
            const dragging = draggingUid === p.lineUid;
            return (
              <div
                key={p.lineUid}
                className={`${styles.mascot} ${dragging ? styles.mascotDragging : ''}`}
                style={{
                  left: `${pos.x * 100}%`,
                  top: `${pos.y * 100}%`,
                  // stagger so the crew doesn't bob in lockstep
                  ['--mascot-delay' as string]: `${(i * 0.47).toFixed(2)}s`,
                  ['--mascot-dur' as string]: `${(3.4 + i * 0.31).toFixed(2)}s`,
                }}
                role="button"
                tabIndex={0}
                aria-label={`${p.name} — ค้างอยู่ ${p.pending} งาน จากทั้งหมด ${p.total} งาน, เสร็จแล้ว ${p.done}`}
                onPointerDown={(e) => onPointerDown(e, p.lineUid)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endDrag(e, p.lineUid)}
                onPointerCancel={(e) => endDrag(e, p.lineUid)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(p.lineUid);
                  }
                }}
              >
                <div className={styles.mascotBob}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- static sprite, next/image adds nothing here */}
                  <img className={styles.mascotImg} src={characterSrc(p.characterIndex)} alt="" draggable={false} />
                  {/* What this person is actually holding right now — live,
                      not-yet-done assignee slots (`pending`), the same unit the
                      รายงานทีม row and the .xlsx export count in. It used to
                      show `overdue` alone, so someone carrying eight on-time
                      tasks wore no badge at all and read as free. Overdue is
                      still surfaced, in the tooltip, where it belongs. */}
                  {p.pending > 0 && (
                    <span
                      className={styles.mascotBadge}
                      title={
                        p.overdue > 0
                          ? `${p.name} — ค้างอยู่ ${p.pending} งาน (เลยกำหนด ${p.overdue} งาน)`
                          : `${p.name} — ค้างอยู่ ${p.pending} งาน`
                      }
                    >
                      {p.pending}
                    </span>
                  )}
                </div>
                <span className={styles.mascotName}>
                  {p.name}
                  <span className={styles.mascotNameMeta}>
                    {p.done}/{p.total}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

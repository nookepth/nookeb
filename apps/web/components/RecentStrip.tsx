'use client';

import { useRef, useState } from 'react';
import type { FileDto } from '@nookeb/shared';
import { typeBadge } from '@/lib/filetype';

export interface RecentStripProps {
  files: FileDto[];
  onOpen: (file: FileDto) => void;
  onSeeAll: () => void;
}

/** Horizontal "เพิ่มล่าสุด" strip — last files added, drag-to-scroll on desktop. */
export function RecentStrip({ files, onOpen, onSeeAll }: RecentStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startScroll: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  if (files.length === 0) return null;

  function onPointerDown(e: React.PointerEvent): void {
    const el = stripRef.current;
    if (!el || e.pointerType !== 'mouse') return;
    drag.current = { startX: e.clientX, startScroll: el.scrollLeft, moved: false };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent): void {
    const el = stripRef.current;
    if (!el || !drag.current) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    el.scrollLeft = drag.current.startScroll - dx;
  }

  function onPointerUp(): void {
    // keep `moved` around briefly so the click handler can suppress accidental opens
    setDragging(false);
    const d = drag.current;
    setTimeout(() => {
      if (drag.current === d) drag.current = null;
    }, 0);
  }

  function handleOpen(file: FileDto): void {
    if (drag.current?.moved) return;
    onOpen(file);
  }

  return (
    <section className="recent-section" id="recent">
      <div className="section-head">
        <h2 className="section-title">เพิ่มล่าสุด</h2>
        <button className="section-link" onClick={onSeeAll}>
          ดูทั้งหมด
        </button>
      </div>
      <div
        ref={stripRef}
        className={`recent-strip ${dragging ? 'dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {files.map((f) => {
          const badge = typeBadge(f);
          return (
            <button key={f.id} className="recent-item" onClick={() => handleOpen(f)}>
              {f.thumbnailUrl ? (
                <img className="recent-thumb" src={f.thumbnailUrl} alt="" loading="lazy" draggable={false} />
              ) : (
                <span className="recent-thumb-fallback" style={{ background: `${badge.color}18` }}>
                  <span className="type-badge" style={{ background: badge.color }}>
                    {badge.label}
                  </span>
                </span>
              )}
              <div className="recent-name">{f.name}</div>
              <div className="recent-date">
                {new Date(f.createdAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

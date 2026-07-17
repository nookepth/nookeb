'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  filterStickersOutsideSafeZones,
  getStickerLayout,
  inflateRect,
  type Rect,
  type StickerPlacement,
} from '@nookeb/shared';
import { StickerArt } from './StickerArt';
import styles from './page.module.css';

/**
 * กล่องของขวัญ — the seeded corner stickers behind the reveal content.
 *
 * Two layers of protection keep stickers off the reading path:
 *  1. the seeded layout only ever anchors to the four screen corners
 *     (`getStickerLayout`), and
 *  2. at runtime every element marked `data-safe-margin="<px>"` is measured and
 *     any sticker intersecting one of those inflated rects is dropped — narrow
 *     screens are where content actually reaches into the corners.
 *
 * The layout is derived from the SLUG here rather than read from the API's
 * `stickerLayout` payload, so the placement rules hold even against an API that
 * hasn't been redeployed with the corner-based math yet. Both derive the same
 * layout from the same seed.
 */

/** re-measure after the phase transition has settled */
const SETTLE_MS = 320;

export function StickerField({ slug, phase }: { slug: string; phase: string }) {
  const [placements, setPlacements] = useState<StickerPlacement[]>([]);

  const measure = useCallback(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const zones: Rect[] = [];
    document.querySelectorAll<HTMLElement>('[data-safe-margin]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // not laid out (hidden stage)
      const margin = Number(el.dataset.safeMargin) || 0;
      zones.push(inflateRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, margin));
    });
    setPlacements(filterStickersOutsideSafeZones(getStickerLayout(slug), viewport, zones));
  }, [slug]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(measure);
    const settle = window.setTimeout(measure, SETTLE_MS);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.removeEventListener('resize', measure);
    };
  }, [measure, phase]);

  return (
    <div className={styles.stickerField} aria-hidden>
      {placements.map((p, i) => {
        const [vertical, horizontal] = p.corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
        return (
          <span
            key={p.corner}
            className={styles.sticker}
            style={
              {
                [horizontal]: `${p.offsetX}px`,
                [vertical]: `${p.offsetY}px`,
                zIndex: p.zIndex,
                '--size': `${p.size}px`,
                '--r': `${p.rotation}deg`,
                '--delay': `${i * 0.9}s`,
              } as React.CSSProperties
            }
          >
            <StickerArt id={p.sticker.id} />
          </span>
        );
      })}
    </div>
  );
}

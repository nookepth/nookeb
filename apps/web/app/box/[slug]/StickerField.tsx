'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fitStickersOutsideSafeZones,
  getStickerLayout,
  inflateRect,
  type Rect,
  type StickerPlacement,
} from '@nookeb/shared';
import { StickerArt } from './StickerArt';
import styles from './page.module.css';

/**
 * กล่องของขวัญ — the seeded stickers behind the reveal content.
 *
 * Two layers keep stickers off the reading path:
 *  1. the seeded layout only ever anchors to the screen edges — four corners
 *     plus the two vertical midpoints (`getStickerLayout`), never the content
 *     column, and
 *  2. at runtime every element marked `data-safe-margin="<px>"` is measured and
 *     each sticker is shrunk/nudged to clear those inflated rects, or dropped
 *     if it can't (`fitStickersOutsideSafeZones`) — narrow screens are where
 *     content actually reaches into the corners.
 *
 * The layout is derived from the SLUG here rather than read from the API's
 * `stickerLayout` payload, so the placement rules hold even against an API that
 * hasn't been redeployed with the current math yet. Both derive the same layout
 * from the same seed; only this side knows the viewport, so only this side fits.
 */

/** re-measure after the phase transition has settled */
const SETTLE_MS = 320;

/**
 * The rect a sticker must stay clear of.
 *
 * For `data-safe-text` elements this is the text's own ink, not its box: a
 * centered `<h1>`/`<p>` is block-level and reports the FULL page width, so
 * inflating that box by the text margin blacks out both corners at its height
 * and there is nowhere left to put a sticker. A Range over the contents
 * measures the glyphs actually painted (union of line boxes).
 */
function safeRect(el: HTMLElement): DOMRect {
  if (el.dataset.safeText === undefined) return el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  range.detach();
  // an empty/undisplayed range measures 0 — fall back to the element's box
  return r.width > 0 && r.height > 0 ? r : el.getBoundingClientRect();
}

export function StickerField({ slug, phase }: { slug: string; phase: string }) {
  const [placements, setPlacements] = useState<StickerPlacement[]>([]);

  const measure = useCallback(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const zones: Rect[] = [];
    document.querySelectorAll<HTMLElement>('[data-safe-margin]').forEach((el) => {
      // The reveal stage is mounted (and laid out) from first load, hidden with
      // CSS until the box opens — its children still report real rects, so ask
      // the stage itself whether it counts yet.
      if (el.closest('[data-safe-hidden]')) return;
      const r = safeRect(el);
      if (r.width === 0 || r.height === 0) return; // not laid out
      const margin = Number(el.dataset.safeMargin) || 0;
      zones.push(inflateRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, margin));
    });
    setPlacements(fitStickersOutsideSafeZones(getStickerLayout(slug), viewport, zones));
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

  /* The floaters share one 3s cycle, half a cycle apart, so the page never has
     two stickers rising together. */
  const floatDelay = new Map(
    placements.filter((p) => p.float).map((p, i) => [p.zone, `${i * 1.5}s`]),
  );

  return (
    <div className={styles.stickerField} aria-hidden>
      {placements.map((p) => {
        /* A centered sticker is pinned to the viewport middle and pulled back by
           half its own height; corner ones just inset from their two edges. */
        const position: React.CSSProperties =
          p.anchorY === 'center'
            ? { [p.anchorX]: `${p.offsetX}px`, top: `calc(50% + ${p.offsetY}px)` }
            : { [p.anchorX]: `${p.offsetX}px`, [p.anchorY]: `${p.offsetY}px` };
        return (
          <span
            key={p.zone}
            className={`${styles.sticker} ${p.float ? styles.stickerFloating : ''}`}
            style={
              {
                ...position,
                zIndex: p.zIndex,
                '--size': `${p.size}px`,
                '--r': `${p.rotation}deg`,
                /* half-height pull-back for the centered ones (0 otherwise) */
                '--pull': p.anchorY === 'center' ? `${-p.size / 2}px` : '0px',
                /* the two floaters are offset by half a cycle so they never
                   bob in lockstep */
                '--delay': floatDelay.get(p.zone) ?? '0s',
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

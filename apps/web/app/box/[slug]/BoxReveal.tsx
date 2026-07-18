'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LegacyBoxOpenResponse, LegacyBoxTheme } from '@nookeb/shared';
import { DEFAULT_TAGLINE, THEMES } from '@nookeb/shared';
import { ApiError, getLegacyBoxOpen } from '@/lib/api';
import { EmptyBoxIcon, GiftIcon } from './StickerArt';
import { StickerField } from './StickerField';
import { VoicePlayer } from './VoicePlayer';
import styles from './page.module.css';

/**
 * กล่องของขวัญ reveal — the recipient experience. Three phases:
 * closed (floating gift box) → opening (lid flies, burst, box shrinks) →
 * revealed (polaroid strip + message). Animation is transform/opacity only
 * (LINE in-app browser rule); prefers-reduced-motion cross-fades straight to
 * the reveal. The revealed content is mounted in the DOM as soon as data
 * arrives (hidden with CSS), plus a hard setTimeout failsafe flips to the
 * revealed state even if a CSS transition never fires — content can never be
 * stuck invisible.
 */

type Phase = 'loading' | 'notfound' | 'closed' | 'opening' | 'revealed';

const OPEN_BURST_AT_MS = 300;
const OPEN_REVEAL_AT_MS = 800;
/** hard failsafe: whatever happens, show the content */
const OPEN_FAILSAFE_MS = 2000;
const PARTICLE_COUNT = 30; // LINE in-app browser budget — keep ≤ 30

function spawnParticles(container: HTMLElement, theme: LegacyBoxTheme): void {
  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const el = document.createElement('div');
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
    const distance = 80 + Math.random() * 120;
    el.className = styles.particle!;
    el.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    el.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    el.style.setProperty('--delay', `${Math.random() * 200}ms`);
    el.style.setProperty('--shape', i % 4 === 0 ? '2px' : '50%');
    el.style.setProperty(
      '--color',
      i % 3 === 0 ? theme.accent : i % 3 === 1 ? theme.ribbon : '#fff',
    );
    return el;
  });
  particles.forEach((p) => container.appendChild(p));
  setTimeout(() => particles.forEach((p) => p.remove()), 1200);
}

export function BoxReveal({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [box, setBox] = useState<LegacyBoxOpenResponse | null>(null);
  const [activeDot, setActiveDot] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const particleLayerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const dragRef = useRef({ startX: 0, startLeft: 0, moved: false });
  const wheelSnapTimerRef = useRef(0);

  useEffect(() => {
    let active = true;
    getLegacyBoxOpen(slug)
      .then((data) => {
        if (!active) return;
        setBox(data);
        setPhase('closed');
      })
      .catch((err: unknown) => {
        if (!active) return;
        void err;
        setPhase('notfound');
      });
    return () => {
      active = false;
      timersRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, [slug]);

  const theme: LegacyBoxTheme = THEMES[box?.theme ?? 'rose'];

  const openBox = useCallback(() => {
    if (!box || phase !== 'closed') return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      setPhase('revealed');
      return;
    }

    setPhase('opening');
    const at = (ms: number, fn: () => void) =>
      timersRef.current.push(window.setTimeout(fn, ms));
    at(OPEN_BURST_AT_MS, () => {
      if (particleLayerRef.current) spawnParticles(particleLayerRef.current, theme);
    });
    at(OPEN_REVEAL_AT_MS, () => setPhase('revealed'));
    at(OPEN_FAILSAFE_MS, () => setPhase('revealed'));
  }, [box, phase, theme]);

  const onRowScroll = useCallback(() => {
    const row = rowRef.current;
    if (!row || !box) return;
    const cards = row.querySelectorAll(`.${styles.polaroid}`);
    const center = row.scrollLeft + row.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    cards.forEach((card, i) => {
      const el = card as HTMLElement;
      const cardCenter = el.offsetLeft + el.offsetWidth / 2;
      const dist = Math.abs(cardCenter - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setActiveDot(best);
  }, [box]);

  /* ---- desktop drag-to-scroll for the polaroid row (touch already works
     natively; this covers mouse users, where a hidden scrollbar left no way
     to scroll at all). While dragging, CSS disables scroll-snap so the row
     follows the cursor 1:1, then re-snaps on release. ---- */
  const onRowMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row || e.button !== 0) return;
    dragRef.current = { startX: e.pageX, startLeft: row.scrollLeft, moved: false };
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const row = rowRef.current;
      if (!row) return;
      const dx = e.pageX - dragRef.current.startX;
      if (Math.abs(dx) > 4) dragRef.current.moved = true;
      row.scrollLeft = dragRef.current.startLeft - dx;
      e.preventDefault();
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  /* mouse wheel → horizontal scroll (non-passive so we can keep the page
     from scrolling vertically while the cursor is over the row) */
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !box) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // trackpad h-scroll works natively
      const max = row.scrollWidth - row.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      row.classList.add(styles.freeScroll!);
      row.scrollLeft += e.deltaY;
      window.clearTimeout(wheelSnapTimerRef.current);
      wheelSnapTimerRef.current = window.setTimeout(() => {
        row.classList.remove(styles.freeScroll!);
      }, 250);
    };
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      row.removeEventListener('wheel', onWheel);
      window.clearTimeout(wheelSnapTimerRef.current);
    };
  }, [box]);

  /**
   * Re-sign the voice clip for the player's retry. Its presigned URL lasts an
   * hour and is only requested when the recipient taps play, so an open box left
   * sitting outlives it. preview=1: this is the same recipient on the box they
   * already opened — re-reading it must not tick the view counter again.
   */
  const refreshAudioSrc = useCallback(async () => {
    const data = await getLegacyBoxOpen(slug, { preview: true });
    return data.audio_url ?? null;
  }, [slug]);

  const shareBox = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast('คัดลอกลิงก์แล้ว!');
    } catch {
      setToast('คัดลอกไม่สำเร็จ ลองใหม่อีกทีน้า');
    }
    timersRef.current.push(window.setTimeout(() => setToast(null), 2000));
  }, []);

  const themeVars = {
    '--bx-bg': theme.bg,
    '--bx-card': theme.card,
    '--bx-accent': theme.accent,
    '--bx-text': theme.text,
    '--bx-ribbon': theme.ribbon,
    '--bx-box': theme.boxColor,
    '--bx-box-accent': theme.boxAccent,
    '--bx-glow': theme.glow,
    '--bx-gradient': theme.gradient,
  } as React.CSSProperties;

  if (phase === 'loading') {
    return (
      <main className={styles.page} style={themeVars}>
        <div className={styles.centerState}>
          <span className={`${styles.centerIcon} ${styles.loadingPulse}`} aria-hidden>
            <GiftIcon />
          </span>
          <p>กำลังห่อของขวัญ…</p>
        </div>
      </main>
    );
  }

  if (phase === 'notfound' || !box) {
    return (
      <main className={styles.page} style={themeVars}>
        <div className={styles.centerState}>
          <span className={styles.centerIcon} aria-hidden>
            <EmptyBoxIcon />
          </span>
          <h1>ไม่พบกล่องของขวัญนี้</h1>
          <p>ลิงก์อาจไม่ถูกต้อง หรือกล่องถูกลบไปแล้วน้า</p>
        </div>
      </main>
    );
  }

  const isClosedOrOpening = phase === 'closed' || phase === 'opening';

  return (
    <main className={styles.page} style={themeVars}>
      {/* seeded corner stickers — present in every phase, never over content
          (the field measures the [data-safe-margin] elements below) */}
      <StickerField slug={slug} phase={phase} />

      {/* ---------- Phase 1 + 2: the gift box ---------- */}
      {isClosedOrOpening && (
        <div
          className={`${styles.closedStage} ${phase === 'opening' ? styles.isOpening : ''}`}
        >
          <button
            type="button"
            className={styles.giftButton}
            onClick={openBox}
            aria-label="แตะเพื่อเปิดกล่องของขวัญ"
            data-safe-margin="60"
          >
            <span className={styles.giftGlow} aria-hidden />
            <span className={styles.giftShadow} aria-hidden />
            <span className={styles.giftWrapper}>
              <span className={styles.giftLid}>
                <span className={styles.giftBow} aria-hidden>
                  <span className={`${styles.giftBowTail} ${styles.giftBowTailL}`} />
                  <span className={`${styles.giftBowTail} ${styles.giftBowTailR}`} />
                  <span className={`${styles.giftBowLoop} ${styles.giftBowLoopL}`} />
                  <span className={`${styles.giftBowLoop} ${styles.giftBowLoopR}`} />
                  <span className={styles.giftBowKnot} />
                </span>
                <span className={styles.giftLidFace} aria-hidden />
              </span>
              <span className={styles.giftBody}>
                <span className={styles.giftRibbonV} aria-hidden />
                <span className={styles.giftSheen} aria-hidden />
              </span>
            </span>
            <span ref={particleLayerRef} className={styles.particleLayer} aria-hidden />
          </button>
          <h1 className={styles.closedTitle} data-safe-margin="48" data-safe-text>
            {box.title}
          </h1>
          <div className={styles.tapHint} aria-hidden data-safe-margin="60">
            แตะเพื่อเปิด
            <svg
              className={styles.tapArrow}
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20V6m0 0l-6 6m6-6l6 6" />
            </svg>
          </div>
        </div>
      )}

      {/* ---------- Phase 3: revealed (mounted early, CSS-hidden until open) ---------- */}
      {/* data-safe-hidden: while this stage is CSS-hidden its children still
          have layout boxes, so the sticker field would measure them as safe
          zones for content that isn't on screen and drop stickers for nothing. */}
      <div
        className={isClosedOrOpening ? styles.hiddenStage : styles.revealStage}
        data-safe-hidden={isClosedOrOpening ? '' : undefined}
      >
        <h1 className={styles.revealTitle} data-safe-margin="48" data-safe-text>
          {box.title}
        </h1>

        <div
          className={`${styles.polaroidRow} ${isDragging ? styles.isRowDragging : ''}`}
          ref={rowRef}
          onScroll={onRowScroll}
          onMouseDown={onRowMouseDown}
        >
          {box.photos.map((photo, i) => (
            <figure
              key={photo.sortOrder}
              className={styles.polaroid}
              data-safe-margin="32"
              style={
                {
                  /* alternating "spread on a table" tilt — deterministic by
                     position, so it matches on every render */
                  '--tilt': i % 2 === 0 ? '1.5deg' : '-1.5deg',
                  '--index': i,
                } as React.CSSProperties
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not a static asset */}
              <img
                className={styles.polaroidImg}
                src={photo.url}
                alt={`รูปที่ ${i + 1}`}
                loading={i < 2 ? 'eager' : 'lazy'}
                draggable={false}
              />
            </figure>
          ))}
        </div>

        {box.photos.length > 1 && (
          <div className={styles.dots} aria-hidden>
            {box.photos.map((_, i) => (
              <span
                key={i}
                className={`${styles.dot} ${i === activeDot ? styles.dotActive : ''}`}
              />
            ))}
          </div>
        )}

        {/* The sender's voice, between the photos and their closing words.
            Absent on every box without a recording (incl. all pre-035 ones),
            where the API sends audio_url: null. */}
        {box.audio_url && (
          <div className={styles.voiceWrap}>
            <VoicePlayer src={box.audio_url} onRefreshSrc={refreshAudioSrc} />
          </div>
        )}

        {box.message && (
          <section className={styles.messageSection}>
            <p className={styles.messageText} data-safe-margin="48" data-safe-text>
              {box.message}
            </p>
            <p className={styles.fromLine} data-safe-margin="48" data-safe-text>
              {/* the sender's closing line; the API already resolved NULL (every
                  pre-034 box) to the default this line used to hardcode */}
              {box.tagline || DEFAULT_TAGLINE}
            </p>
          </section>
        )}

        <p className={styles.poweredBy}>
          ส่งความทรงจำด้วย <a href="/">หนูเก็บ</a>
        </p>
      </div>

      {/* ---------- bottom bar (revealed only) ---------- */}
      {phase === 'revealed' && (
        <div className={styles.actionBar}>
          <button
            type="button"
            className={styles.shareBtn}
            onClick={() => void shareBox()}
            data-safe-margin="48"
          >
            แชร์กล่องนี้
          </button>
          <span className={styles.viewCount}>เปิดแล้ว {box.viewCount} ครั้ง</span>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </main>
  );
}

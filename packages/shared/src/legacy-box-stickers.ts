/**
 * กล่องของขวัญ (Legacy Box) — sticker decoration system (migration 033).
 *
 * Stickers are hand-drawn-style INLINE SVGs (no emoji — system emoji render
 * differently on every OS and clash with the curated look). This shared module
 * only defines the sticker IDs + the seeded layout math; the actual SVG art
 * lives client-side in `apps/web/app/box/[slug]/StickerArt.tsx`, keyed by id.
 * 100% self-contained (no CDN, no image assets).
 *
 * Placement is SEEDED off the box slug: the same slug always produces the same
 * layout, so the box a recipient opens today looks identical next month, and
 * the server and client can both derive it without storing coordinates.
 *
 * Stickers are DECORATION and must never sit on the reading path: they are
 * anchored to the four screen corners only (one each, at most two per screen),
 * and the renderer additionally drops any sticker whose box intersects a
 * measured safe zone (title / CTA / polaroid / message) — see
 * `getStickerRect` + `filterStickersOutsideSafeZones` below.
 */

export const STICKERS = [
  { id: 'heart', label: 'heart' },
  { id: 'star', label: 'star' },
  { id: 'sparkle', label: 'sparkle' },
  { id: 'bow', label: 'bow' },
  { id: 'flower', label: 'flower' },
  { id: 'camera', label: 'camera' },
  { id: 'letter', label: 'love letter' },
  { id: 'balloon', label: 'balloon' },
  { id: 'moon', label: 'moon' },
  { id: 'cloud', label: 'cloud' },
] as const;

export type Sticker = (typeof STICKERS)[number];
export type StickerId = Sticker['id'];

export const STICKER_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type StickerCorner = (typeof STICKER_CORNERS)[number];

/** each corner owns an 80x80 zone, held this far off the screen edge */
export const CORNER_ZONE_PX = 80;
export const CORNER_EDGE_INSET_PX = 16;
/** at most this many stickers are on screen at once */
export const MAX_STICKERS_PER_SCREEN = 2;

const SIZE_MIN_PX = 48;
const SIZE_MAX_PX = 56;
/** the 4-point glint reads as clutter at full size — cap it harder */
const SMALL_STICKER_IDS = new Set<string>(['sparkle']);
const SMALL_SIZE_MAX_PX = 32;

export interface StickerPlacement {
  sticker: Sticker;
  /** stickers live in corners only — never over the content column */
  corner: StickerCorner;
  /** px inset from the corner's vertical edge (left or right), >= CORNER_EDGE_INSET_PX */
  offsetX: number;
  /** px inset from the corner's horizontal edge (top or bottom) */
  offsetY: number;
  /** degrees, roughly -14..14 */
  rotation: number;
  /** final rendered size in px */
  size: number;
  zIndex: number;
}

/** An axis-aligned rect in viewport px. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Grow a rect by `margin` px on every side (safe-zone padding). */
export function inflateRect(rect: Rect, margin: number): Rect {
  return {
    left: rect.left - margin,
    top: rect.top - margin,
    right: rect.right + margin,
    bottom: rect.bottom + margin,
  };
}

/** Where a placement actually lands, given a viewport of `width` x `height` px. */
export function getStickerRect(
  placement: StickerPlacement,
  viewport: { width: number; height: number },
): Rect {
  const { corner, offsetX, offsetY, size } = placement;
  const left = corner.endsWith('left') ? offsetX : viewport.width - offsetX - size;
  const top = corner.startsWith('top') ? offsetY : viewport.height - offsetY - size;
  return { left, top, right: left + size, bottom: top + size };
}

/**
 * Drop every sticker that would touch readable/interactive content. Callers
 * pass safe zones ALREADY inflated by their margin (see `inflateRect`), since
 * the required padding differs per element (title 40, CTA 60, polaroid 24…).
 */
export function filterStickersOutsideSafeZones(
  placements: StickerPlacement[],
  viewport: { width: number; height: number },
  safeZones: Rect[],
): StickerPlacement[] {
  return placements.filter((p) => {
    const rect = getStickerRect(p, viewport);
    return !safeZones.some((zone) => rectsIntersect(rect, zone));
  });
}

/** Deterministic PRNG (mulberry32) — same seed, same sequence, every runtime. */
export function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash — turns a slug into a 32-bit PRNG seed. */
export function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

/**
 * Seeded sticker layout for a box — same slug always yields the same layout.
 *
 * Each sticker gets its OWN corner (corners are drawn without replacement), so
 * two stickers can never overlap each other, and `count` is clamped to the four
 * available corners / `MAX_STICKERS_PER_SCREEN`.
 */
export function getStickerLayout(
  slug: string,
  count = MAX_STICKERS_PER_SCREEN,
): StickerPlacement[] {
  const rand = mulberry32(fnv1a(slug));
  const total = Math.max(0, Math.min(count, MAX_STICKERS_PER_SCREEN, STICKER_CORNERS.length));

  // Fisher-Yates over the corners — deterministic, no repeats.
  const corners = [...STICKER_CORNERS];
  for (let i = corners.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [corners[i], corners[j]] = [corners[j]!, corners[i]!];
  }

  return Array.from({ length: total }, (_, i) => {
    const sticker = STICKERS[Math.floor(rand() * STICKERS.length)]!;
    const maxSize = SMALL_STICKER_IDS.has(sticker.id) ? SMALL_SIZE_MAX_PX : SIZE_MAX_PX;
    const size = Math.round(Math.min(SIZE_MIN_PX + rand() * (SIZE_MAX_PX - SIZE_MIN_PX), maxSize));
    // keep the whole sticker inside its 80x80 corner zone
    const slack = Math.max(0, CORNER_ZONE_PX - size);
    return {
      sticker,
      corner: corners[i]!,
      offsetX: Math.round(CORNER_EDGE_INSET_PX + rand() * slack),
      offsetY: Math.round(CORNER_EDGE_INSET_PX + rand() * slack),
      rotation: Math.round((rand() - 0.5) * 28),
      size,
      zIndex: i,
    };
  });
}

/** Seeded polaroid tilt (degrees) for photo `index` of a box — used on reveal. */
export function getPolaroidTilt(slug: string, index: number): number {
  const rand = mulberry32(fnv1a(`${slug}#tilt`) + index * 0x9e3779b9);
  return (rand() - 0.5) * 7; // roughly -3.5..3.5deg — subtle, physical
}

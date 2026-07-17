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

export interface StickerPlacement {
  sticker: Sticker;
  /** % from the left edge of the container */
  x: number;
  /** % from the top edge of the container */
  y: number;
  /** degrees, roughly -20..20 */
  rotation: number;
  /** 0.8..1.6 multiplier on the base sticker size */
  scale: number;
  zIndex: number;
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

/** Seeded sticker layout for a box — same slug always yields the same layout. */
export function getStickerLayout(slug: string, count = 6): StickerPlacement[] {
  const rand = mulberry32(fnv1a(slug));
  return Array.from({ length: count }, (_, i) => ({
    sticker: STICKERS[Math.floor(rand() * STICKERS.length)]!,
    x: 5 + rand() * 88,
    y: 5 + rand() * 88,
    rotation: (rand() - 0.5) * 40,
    scale: 0.8 + rand() * 0.8,
    zIndex: i,
  }));
}

/** Seeded polaroid tilt (degrees) for photo `index` of a box — used on reveal. */
export function getPolaroidTilt(slug: string, index: number): number {
  const rand = mulberry32(fnv1a(`${slug}#tilt`) + index * 0x9e3779b9);
  return (rand() - 0.5) * 7; // roughly -3.5..3.5deg — subtle, physical
}

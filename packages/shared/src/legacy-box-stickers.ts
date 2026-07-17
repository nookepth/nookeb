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
 * anchored to five edge zones (never the content column), and the renderer
 * additionally drops any sticker whose box intersects a measured safe zone
 * (title / CTA / polaroid / message / voice player) — see `getStickerRect` +
 * `filterStickersOutsideSafeZones` below. Dropping is the backstop, not the
 * plan: a layout that needs it on a normal screen is a layout bug.
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

/**
 * The five placement zones. Corners are inset from the screen edge; the two
 * side zones sit at the vertical middle of the viewport and may hang partly
 * off-screen. Nothing anchors to the horizontal center — that is the reading
 * column.
 */
export const STICKER_ZONES = [
  'top-left',
  'top-right',
  'left-center',
  'right-center',
  'bottom-left',
  'bottom-right',
] as const;

export type StickerZone = (typeof STICKER_ZONES)[number];

/** corners are held at least this far off the screen edge */
export const CORNER_EDGE_INSET_PX = 16;
/** a side sticker may hang at most this fraction of its width off-screen */
export const MAX_EDGE_OVERHANG = 0.3;
/** stickers rendered per box (2 large + 2 medium + 1–2 small) */
export const MIN_STICKERS_PER_SCREEN = 5;
export const MAX_STICKERS_PER_SCREEN = 6;

/** size tiers — mixed on purpose, so the field has visual rhythm */
const TIER_SIZES = {
  large: [72, 80],
  medium: [52, 60],
  small: [36, 40],
} as const satisfies Record<string, readonly [number, number]>;

export type StickerTier = keyof typeof TIER_SIZES;

/** the 4-point glint reads as clutter at anchor size — never let it go large */
const SMALL_STICKER_IDS = new Set<string>(['sparkle']);
const SMALL_SIZE_MAX_PX = 60;

export interface StickerPlacement {
  sticker: Sticker;
  /** stickers live along the edges only — never over the content column */
  zone: StickerZone;
  /** which screen edge `offsetX` is measured from */
  anchorX: 'left' | 'right';
  /** which screen edge `offsetY` is measured from ('center' = viewport middle) */
  anchorY: 'top' | 'bottom' | 'center';
  /** px inset from the `anchorX` edge; NEGATIVE means it hangs off-screen */
  offsetX: number;
  /** px inset from the `anchorY` edge, or px above/below the middle when centered */
  offsetY: number;
  /** degrees, -18..18 and never near 0 (flat reads as a mistake) */
  rotation: number;
  size: number;
  tier: StickerTier;
  /** the anchor pieces gently oscillate; the rest hold still */
  float: boolean;
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
  const { anchorX, anchorY, offsetX, offsetY, size } = placement;
  const left = anchorX === 'left' ? offsetX : viewport.width - offsetX - size;
  const top =
    anchorY === 'top'
      ? offsetY
      : anchorY === 'bottom'
        ? viewport.height - offsetY - size
        : viewport.height / 2 + offsetY - size / 2;
  return { left, top, right: left + size, bottom: top + size };
}

/** a sticker smaller than this is a smudge — drop it instead */
const MIN_RENDER_SIZE_PX = 28;
/** tried in order: full size first, so wide screens keep the intended scale */
const FIT_SCALES = [1, 0.85, 0.7, 0.55, 0.45];
/** how far out of its zone a sticker may be nudged, as a fraction of its width */
const FIT_OVERHANGS = [0, 0.15, MAX_EDGE_OVERHANG];
/**
 * px a side sticker may slide ALONG its edge, seeded position first. Only the
 * center-anchored ones: a corner sticker that slid would stop being in the
 * corner, but a side sticker is "somewhere down the left edge" either way, and
 * sliding is what gets it past full-width content (the voice card, the photo
 * row) that no horizontal nudge can clear.
 */
const FIT_SLIDES = [0, -80, 80, -160, 160, -240, 240];
/** a slid sticker still has to stay on screen, with a little air */
const VIEWPORT_PAD_PX = 8;

/**
 * Fit every sticker into the space that content leaves it. Callers pass safe
 * zones ALREADY inflated by their margin (see `inflateRect`), since the
 * required padding differs per element (text 48, polaroid 32…).
 *
 * Fit, not filter: on a phone the reading column plus its margins can leave a
 * gutter narrower than an anchor sticker, and a plain "drop on collision" pass
 * empties the page — the very sparseness the sticker field exists to fix. So a
 * colliding sticker is first shrunk, then nudged toward (and partly off) its
 * edge, and only dropped when even the smallest version has nowhere to sit.
 * Nothing here is random: same input, same output.
 */
export function fitStickersOutsideSafeZones(
  placements: StickerPlacement[],
  viewport: { width: number; height: number },
  safeZones: Rect[],
): StickerPlacement[] {
  const fits = (p: StickerPlacement): boolean => {
    const rect = getStickerRect(p, viewport);
    if (rect.top < VIEWPORT_PAD_PX || rect.bottom > viewport.height - VIEWPORT_PAD_PX) return false;
    return !safeZones.some((zone) => rectsIntersect(rect, zone));
  };

  return placements.flatMap((p) => {
    const slides = p.anchorY === 'center' ? FIT_SLIDES : [0];
    for (const scale of FIT_SCALES) {
      const size = Math.round(p.size * scale);
      if (size < MIN_RENDER_SIZE_PX) break;
      for (const slide of slides) {
        for (const overhang of FIT_OVERHANGS) {
          // Negative offsetX = off-screen. Never let the nudge push a sticker
          // further out than MAX_EDGE_OVERHANG of its (new) width.
          const offsetX = Math.max(
            -Math.floor(MAX_EDGE_OVERHANG * size),
            p.offsetX - Math.round(overhang * size),
          );
          const candidate = { ...p, size, offsetX, offsetY: p.offsetY + slide };
          if (fits(candidate)) return [candidate];
        }
      }
    }
    return [];
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

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function sizeFor(tier: StickerTier, stickerId: string, rand: () => number): number {
  const [min, max] = TIER_SIZES[tier];
  const cap = SMALL_STICKER_IDS.has(stickerId) ? Math.min(max, SMALL_SIZE_MAX_PX) : max;
  return Math.round(Math.min(min + rand() * (max - min), cap));
}

/** -18..-6 or 6..18 — enough to read as hand-placed, never chaotic. */
function rotationFor(rand: () => number): number {
  const magnitude = 6 + rand() * 12;
  return Math.round(rand() < 0.5 ? -magnitude : magnitude);
}

/**
 * Seeded sticker layout for a box — same slug always yields the same layout.
 *
 * Each sticker gets its OWN zone (drawn without replacement), so two stickers
 * can never overlap each other. Zones alternate left/right for balance, the
 * sparkle is forced into a TOP zone (it's the "magic" accent that greets the
 * reveal), and the two `large` anchors are the ones that float.
 */
export function getStickerLayout(slug: string): StickerPlacement[] {
  const rand = mulberry32(fnv1a(slug));

  // Both top corners + both side zones always; then one seeded bottom corner,
  // with the opposite one sometimes joining as a 6th. Indices 0 and 1 are the
  // top zones — `sparkleAt` below relies on that.
  const bottoms: StickerZone[] =
    rand() < 0.5 ? ['bottom-left', 'bottom-right'] : ['bottom-right', 'bottom-left'];
  const zones: StickerZone[] = [
    'top-left',
    'top-right',
    'right-center',
    'left-center',
    bottoms[0]!,
  ];
  if (rand() < 0.5) zones.push(bottoms[1]!);

  const tiers: StickerTier[] = ['large', 'large', 'medium', 'medium', 'small'];
  if (zones.length > MIN_STICKERS_PER_SCREEN) tiers.push('small');
  const tierByZone = shuffled(tiers, rand);

  const palette = shuffled(STICKERS, rand);
  // The sparkle greets the reveal from the top; take it out of the pool so it
  // can't also show up somewhere else.
  const sparkle = STICKERS.find((s) => s.id === 'sparkle')!;
  const rest = palette.filter((s) => s.id !== 'sparkle');
  const sparkleAt = rand() < 0.5 ? 0 : 1; // top-left or top-right

  return zones.map((zone, i) => {
    const sticker = i === sparkleAt ? sparkle : rest.shift()!;
    const tier = tierByZone[i]!;
    const size = sizeFor(tier, sticker.id, rand);
    const isSide = zone === 'left-center' || zone === 'right-center';

    // Side zones hug (and may hang off) the edge; corners stay fully on-screen.
    const offsetX = isSide
      ? // floor, not round: rounding a fractional cap upward would push the
        // sticker past MAX_EDGE_OVERHANG
        -Math.floor(MAX_EDGE_OVERHANG * size * rand())
      : Math.round(CORNER_EDGE_INSET_PX + rand() * 14);
    // Side stickers sit 40–130px off the vertical middle, above or below it.
    const centerOffset = Math.round((40 + rand() * 90) * (rand() < 0.5 ? -1 : 1));
    const offsetY = isSide ? centerOffset : Math.round(CORNER_EDGE_INSET_PX + rand() * 14);

    return {
      sticker,
      zone,
      anchorX: zone.includes('left') ? 'left' : 'right',
      anchorY: isSide ? 'center' : zone.startsWith('top') ? 'top' : 'bottom',
      offsetX,
      offsetY,
      rotation: rotationFor(rand),
      size,
      tier,
      float: tier === 'large',
      zIndex: i,
    };
  });
}

/** Seeded polaroid tilt (degrees) for photo `index` of a box. */
export function getPolaroidTilt(slug: string, index: number): number {
  const rand = mulberry32(fnv1a(`${slug}#tilt`) + index * 0x9e3779b9);
  return (rand() - 0.5) * 7; // roughly -3.5..3.5deg — subtle, physical
}

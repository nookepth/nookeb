/**
 * กล่องของขวัญ — inline-SVG sticker art (no emoji, no external assets).
 *
 * One cohesive "die-cut sticker" style: soft theme-colored fills, a thick
 * white outline on every shape, and a small gloss highlight. Colors come from
 * the theme CSS variables set on the page (`--bx-accent`, `--bx-ribbon`), so
 * every sticker automatically matches all 6 themes.
 *
 * The sticker ids are defined in `@nookeb/shared` (legacy-box-stickers.ts);
 * the API's stickerLayout payload references them by id. LEGACY_STICKER_IDS
 * maps ids from older layouts (emoji era) onto current art so an
 * already-deployed API keeps rendering.
 */

const ACCENT = 'var(--bx-accent, #E8507A)';
const RIBBON = 'var(--bx-ribbon, #F4A0B8)';
const OUTLINE = '#fff';

/** shared outline props — the one rule that makes the set cohesive */
const line = {
  stroke: OUTLINE,
  strokeWidth: 4,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const;

const STICKER_ART: Record<string, React.ReactNode> = {
  heart: (
    <>
      <path
        d="M32 52C18.5 42.4 8.5 33.4 8.5 23 8.5 15.6 14.4 10 21.5 10c4.3 0 8.1 2.1 10.5 5.6C34.4 12.1 38.2 10 42.5 10c7.1 0 13 5.6 13 13 0 10.4-10 19.4-23.5 29Z"
        fill={ACCENT}
        {...line}
      />
      <circle cx="21.5" cy="21" r="3.6" fill={OUTLINE} opacity="0.65" />
    </>
  ),
  star: (
    <>
      <path
        d="M32 7.5l7.4 15.1 16.6 2.4-12 11.7 2.8 16.5L32 45.4l-14.8 7.8L20 36.7 8 25l16.6-2.4L32 7.5Z"
        fill={RIBBON}
        {...line}
      />
      <circle cx="27" cy="22" r="3" fill={OUTLINE} opacity="0.6" />
    </>
  ),
  sparkle: (
    <>
      <path
        d="M28 8c2.2 12.6 6.4 16.8 19 19-12.6 2.2-16.8 6.4-19 19-2.2-12.6-6.4-16.8-19-19 12.6-2.2 16.8-6.4 19-19Z"
        fill={ACCENT}
        {...line}
      />
      <path
        d="M48 38c1.1 6 3 7.9 9 9-6 1.1-7.9 3-9 9-1.1-6-3-7.9-9-9 6-1.1 7.9-3 9-9Z"
        fill={RIBBON}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </>
  ),
  bow: (
    <>
      <path
        d="M27 31C14 22 4.5 25.5 7.5 34.5c2.2 6.6 12 7 19.5 2.5Z"
        fill={RIBBON}
        {...line}
      />
      <path
        d="M37 31c13-9 22.5-5.5 19.5 3.5-2.2 6.6-12 7-19.5 2.5Z"
        fill={RIBBON}
        {...line}
      />
      <path d="M28 38l-7 15 7.5-2.8 3.5 4.8 2-8Z" fill={RIBBON} {...line} strokeWidth="3.5" />
      <path d="M36 38l7 15-7.5-2.8-3.5 4.8-2-8Z" fill={RIBBON} {...line} strokeWidth="3.5" />
      <rect x="25.5" y="27.5" width="13" height="12" rx="4.5" fill={ACCENT} {...line} strokeWidth="3.5" />
    </>
  ),
  flower: (
    <>
      <g fill={RIBBON} stroke={OUTLINE} strokeWidth="3.5" strokeLinejoin="round">
        <circle cx="32" cy="14.5" r="9" />
        <circle cx="48.5" cy="26.5" r="9" />
        <circle cx="42.5" cy="45.5" r="9" />
        <circle cx="21.5" cy="45.5" r="9" />
        <circle cx="15.5" cy="26.5" r="9" />
      </g>
      <circle cx="32" cy="31.5" r="8.5" fill={ACCENT} stroke={OUTLINE} strokeWidth="3.5" />
      <circle cx="29" cy="28.5" r="2.4" fill={OUTLINE} opacity="0.6" />
    </>
  ),
  camera: (
    <>
      <path d="M23 19l3.4-6.5h11.2L41 19Z" fill={ACCENT} {...line} />
      <rect x="7" y="17.5" width="50" height="34" rx="8" fill={ACCENT} {...line} />
      <circle cx="32" cy="34.5" r="10.5" fill={OUTLINE} />
      <circle cx="32" cy="34.5" r="6.5" fill={RIBBON} />
      <circle cx="34.5" cy="32" r="2" fill={OUTLINE} opacity="0.85" />
      <circle cx="49" cy="25.5" r="2.6" fill={OUTLINE} opacity="0.9" />
    </>
  ),
  letter: (
    <>
      <rect x="6" y="14" width="52" height="36" rx="6.5" fill={RIBBON} {...line} />
      <path d="M9 19l23 17 23-17" fill="none" {...line} />
      <path
        d="M32 47.5c-4.7-3.4-7.5-6.2-7.5-9.4a4.4 4.4 0 017.5-2.9 4.4 4.4 0 017.5 2.9c0 3.2-2.8 6-7.5 9.4Z"
        fill={ACCENT}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </>
  ),
  balloon: (
    <>
      <path d="M32 47.5c-4.5 5 4.5 8 0 13" fill="none" stroke={OUTLINE} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="32" cy="24" rx="15.5" ry="18.5" fill={ACCENT} {...line} />
      <path d="M32 43l-4.2 5.5h8.4Z" fill={ACCENT} {...line} strokeWidth="3" />
      <ellipse cx="25.5" cy="17" rx="3.6" ry="5.8" fill={OUTLINE} opacity="0.55" transform="rotate(-22 25.5 17)" />
    </>
  ),
  moon: (
    <>
      <path
        d="M41.5 7.5C26 7.5 13.5 19 13.5 33.5s12.5 26 28 26c4.2 0 8.2-1 11.5-2.7-10.5-3.8-17.5-13-17.5-23.3s7-19.5 17.5-23.3A27.5 27.5 0 0041.5 7.5Z"
        fill={RIBBON}
        {...line}
      />
      <path
        d="M48 14c.9 4.8 2.4 6.3 7.2 7.2-4.8.9-6.3 2.4-7.2 7.2-.9-4.8-2.4-6.3-7.2-7.2 4.8-.9 6.3-2.4 7.2-7.2Z"
        fill={ACCENT}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </>
  ),
  cloud: (
    <>
      <path
        d="M19.5 49.5h26.5a10.5 10.5 0 003.2-20.5A15.5 15.5 0 0019 26a12 12 0 00.5 23.5Z"
        fill={RIBBON}
        {...line}
      />
      <circle cx="22" cy="35" r="3" fill={OUTLINE} opacity="0.55" />
    </>
  ),
};

/** ids from older seeded layouts (emoji era) → current art */
const LEGACY_STICKER_IDS: Record<string, string> = {
  ribbon: 'bow',
  daisy: 'flower',
  rose: 'flower',
  clover: 'flower',
  butterfly: 'sparkle',
  gem: 'star',
  cherry: 'heart',
  candy: 'heart',
};

export function StickerArt({ id }: { id: string }) {
  const art = STICKER_ART[id] ?? STICKER_ART[LEGACY_STICKER_IDS[id] ?? 'heart'];
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden focusable="false">
      {art}
    </svg>
  );
}

/** small state icons (loading / not-found) — same sticker style, no emoji */
export function GiftIcon() {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden focusable="false">
      <rect x="10" y="26" width="44" height="30" rx="5" fill={ACCENT} {...line} />
      <rect x="7" y="16" width="50" height="12" rx="4" fill={RIBBON} {...line} />
      <path d="M28 16v40M36 16v40" stroke={OUTLINE} strokeWidth="4" opacity="0.75" />
      <path d="M32 15c-3-7-12-9-12-3s8 5 12 3Zm0 0c3-7 12-9 12-3s-8 5-12 3Z" fill={RIBBON} {...line} strokeWidth="3" />
    </svg>
  );
}

export function EmptyBoxIcon() {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden focusable="false">
      <rect x="12" y="28" width="40" height="26" rx="4" fill={RIBBON} {...line} />
      <path d="M12 28L6 18h52l-6 10Z" fill={ACCENT} {...line} />
      <path d="M26 40h12" stroke={OUTLINE} strokeWidth="4" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}

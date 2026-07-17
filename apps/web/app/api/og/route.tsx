import { ImageResponse } from 'next/og';
import { THEMES, DEFAULT_THEME, isThemeId, type LegacyBoxThemeId } from '@nookeb/shared';

/**
 * กล่องของขวัญ (Legacy Box) — the share-link OG image.
 *
 * PRIVACY: this route takes a THEME, never a slug. It renders no box title,
 * message, photo, recipient or sender — nothing the box owner wrote. That is
 * deliberate: a gift link pasted into a LINE group unfurls for everyone in the
 * chat, and unfurler bots cache what they fetch on their own infra, so anything
 * rendered here stops being a surprise for whoever actually taps the link. The
 * theme colour is the only per-box detail that leaks, and it leaks nothing.
 * Keep it that way — see the Legacy Box section in CLAUDE.md.
 *
 * Satori constraints: no <img>, no CSS variables, no external stylesheets —
 * inline styles only, every colour resolved to a literal, all art inline SVG.
 */

export const runtime = 'edge';

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * Satori cannot read woff2 — it needs ttf/otf/woff. Requesting the Google Fonts
 * CSS API *without* a modern User-Agent makes it serve truetype instead of woff2.
 */
const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700';

type FontWeight = 400 | 600 | 700;

let fontCache: Promise<{ name: string; data: ArrayBuffer; weight: FontWeight; style: 'normal' }[]> | null =
  null;

async function loadFont(weight: FontWeight): Promise<ArrayBuffer> {
  const css = await fetch(`${FONT_CSS_URL.replace(/:wght@.*$/, '')}:wght@${weight}`, {
    // no UA header → truetype URLs
    headers: { 'User-Agent': '' },
  }).then((r) => r.text());

  const url = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
  if (!url) throw new Error(`no font url for weight ${weight}`);
  return fetch(url).then((r) => r.arrayBuffer());
}

/**
 * Fetched once per isolate. If Google Fonts is unreachable we fall back to no
 * custom font — which would render Thai as tofu, so the caller treats a font
 * failure as a hard failure rather than shipping a broken image.
 */
function loadFonts() {
  fontCache ??= Promise.all(
    ([400, 600, 700] as FontWeight[]).map(async (weight) => ({
      name: 'IBM Plex Sans Thai',
      data: await loadFont(weight),
      weight,
      style: 'normal' as const,
    })),
  ).catch((err) => {
    fontCache = null; // let the next request retry instead of caching the failure
    throw err;
  });
  return fontCache;
}

/**
 * The palette's theme.gradient is a near-white pastel meant for the reveal
 * page — white text on it would be invisible. For the OG surface we build the
 * gradient from the SAME palette's saturated accent → deep text colour, so it
 * stays on-brand per theme without inventing any new colours.
 *
 * (Only two stops: every theme's boxAccent is identical to its accent, so a
 * midpoint stop there would just flatten the first half of the ramp.)
 */
function ogGradient(t: (typeof THEMES)[LegacyBoxThemeId]): string {
  return `linear-gradient(135deg, ${t.accent} 0%, ${t.text} 100%)`;
}

/** sRGB relative luminance (WCAG) of a #rrggbb colour */
function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * Scrim behind the text zone, strength derived from the accent's luminance.
 *
 * The themes split hard: butter (L≈0.51) and mint (L≈0.46) cannot carry white
 * text on their accent — white on #E6B800 is ~2:1 — while rose/lilac/sky/peach
 * (L≈0.19–0.26) are fine and a scrim only muddies them. The accent itself can't
 * be darkened without losing the theme's identity, so the fix is a scrim scaled
 * to how light the accent actually is: heavy for butter, barely there for
 * lilac. Deriving it from luminance means a future palette edit stays legible
 * on its own. Fades out before the box so the right half stays pure theme.
 */
function textScrim(accent: string): string {
  const alpha = Math.min(0.42, Math.max(0.14, 0.02 + relativeLuminance(accent) * 0.62));
  return `linear-gradient(90deg, rgba(0,0,0,${alpha.toFixed(3)}) 0%, rgba(0,0,0,${(
    alpha * 0.6
  ).toFixed(3)}) 45%, rgba(0,0,0,0) 78%)`;
}

/**
 * Grain (rendered at 8%). resvg runs feTurbulence, so the noise is generated at
 * request time rather than shipped as an asset. One octave: at 8% opacity the
 * extra octaves were indistinguishable and only cost render time.
 *
 * This is what makes the PNG ~1.1 MB (noise doesn't compress). That's fine
 * here: there are only 6 possible renders, they're cached immutable, and
 * unfurlers fetch once and then serve their own re-encoded thumbnail.
 */
const GRAIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="1" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
const GRAIN_URL = `data:image/svg+xml;base64,${btoa(GRAIN_SVG)}`;

/**
 * die-cut sticker art, same silhouettes as the reveal page's StickerArt.tsx.
 *
 * Satori serialises <svg> children by stringifying them, which chokes on a
 * Fragment's $$typeof Symbol and on the `false` a `{cond && ...}` branch leaves
 * behind. So each sticker is a single <g> element — never a fragment, never a
 * conditional child.
 */
const STICKER_LINE = {
  stroke: '#fff',
  strokeWidth: 4,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
};

type StickerKind = 'heart' | 'star' | 'sparkle';

const STICKER_ART: Record<StickerKind, (fill: string, accent: string) => JSX.Element> = {
  heart: (fill) => (
    <g>
      <path
        d="M32 52C18.5 42.4 8.5 33.4 8.5 23 8.5 15.6 14.4 10 21.5 10c4.3 0 8.1 2.1 10.5 5.6C34.4 12.1 38.2 10 42.5 10c7.1 0 13 5.6 13 13 0 10.4-10 19.4-23.5 29Z"
        fill={fill}
        {...STICKER_LINE}
      />
      <circle cx="21.5" cy="21" r="3.6" fill="#fff" opacity="0.65" />
    </g>
  ),
  star: (fill) => (
    <g>
      <path
        d="M32 7.5l7.4 15.1 16.6 2.4-12 11.7 2.8 16.5L32 45.4l-14.8 7.8L20 36.7 8 25l16.6-2.4L32 7.5Z"
        fill={fill}
        {...STICKER_LINE}
      />
      <circle cx="27" cy="22" r="3" fill="#fff" opacity="0.6" />
    </g>
  ),
  sparkle: (fill, accent) => (
    <g>
      <path
        d="M28 8c2.2 12.6 6.4 16.8 19 19-12.6 2.2-16.8 6.4-19 19-2.2-12.6-6.4-16.8-19-19 12.6-2.2 16.8-6.4 19-19Z"
        fill={fill}
        {...STICKER_LINE}
      />
      <path
        d="M48 38c1.1 6 3 7.9 9 9-6 1.1-7.9 3-9 9-1.1-6-3-7.9-9-9 6-1.1 7.9-3 9-9Z"
        fill={accent}
        stroke="#fff"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </g>
  ),
};

function Sticker({
  kind,
  size,
  fill,
  accent,
  rotate,
  style,
}: {
  kind: StickerKind;
  size: number;
  fill: string;
  accent: string;
  rotate: number;
  style: React.CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', position: 'absolute', transform: `rotate(${rotate}deg)`, ...style }}>
      <svg width={size} height={size} viewBox="0 0 64 64">
        {STICKER_ART[kind](fill, accent)}
      </svg>
    </div>
  );
}

/** the gift box itself — flat OG version of the reveal page's CSS box */
function GiftBox({ theme }: { theme: (typeof THEMES)[LegacyBoxThemeId] }) {
  const line = {
    stroke: '#fff',
    strokeWidth: 3,
    strokeLinejoin: 'round' as const,
  };
  return (
    <div style={{ display: 'flex' }}>
      <svg width={320} height={320} viewBox="0 0 64 64">
        {/* lid, tilted slightly ajar — the box reads as "about to open" */}
        <g transform="rotate(-7 32 20)">
          <rect x="5" y="15.5" width="54" height="13" rx="4" fill={theme.ribbon} {...line} />
          <rect x="28" y="15.5" width="8" height="13" fill={theme.boxAccent} opacity="0.9" />
          <path
            d="M32 15c-3.4-7.6-13-9.6-13-3.2 0 4.6 8.4 5.4 13 3.2Zm0 0c3.4-7.6 13-9.6 13-3.2 0 4.6-8.4 5.4-13 3.2Z"
            fill={theme.boxAccent}
            {...line}
          />
        </g>
        {/* body */}
        <rect x="9" y="29" width="46" height="28" rx="4.5" fill={theme.boxColor} {...line} />
        <rect x="28" y="29" width="8" height="28" fill={theme.boxAccent} opacity="0.9" />
        <rect x="9" y="29" width="46" height="6" fill="#fff" opacity="0.18" />
      </svg>
    </div>
  );
}

export async function GET(request: Request) {
  const themeParam = new URL(request.url).searchParams.get('theme') ?? '';
  const themeId: LegacyBoxThemeId = isThemeId(themeParam) ? themeParam : DEFAULT_THEME;
  const theme = THEMES[themeId];

  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          backgroundImage: ogGradient(theme),
          fontFamily: '"IBM Plex Sans Thai", system-ui, sans-serif',
        }}
      >
        {/* text-zone scrim (under the grain, under the content) */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: WIDTH,
            height: HEIGHT,
            display: 'flex',
            backgroundImage: textScrim(theme.accent),
          }}
        />

        {/* grain — Satori has no `inset` shorthand, so size it explicitly */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: WIDTH,
            height: HEIGHT,
            display: 'flex',
            backgroundImage: `url("${GRAIN_URL}")`,
            opacity: 0.08,
          }}
        />

        {/* LEFT — text (55%) */}
        <div
          style={{
            width: '55%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 0 0 72px',
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              color: '#fff',
              opacity: 0.75,
              letterSpacing: 4,
            }}
          >
            หนูเก็บ · กล่องของขวัญ
          </div>
          <div
            style={{
              fontSize: 78,
              fontWeight: 700,
              color: '#fff',
              lineHeight: 1.18,
              marginTop: 18,
            }}
          >
            มีของขวัญรอคุณอยู่
          </div>
          <div style={{ fontSize: 32, color: '#fff', opacity: 0.85, marginTop: 16 }}>
            ใครบางคนส่งความทรงจำมาให้คุณ
          </div>
          <div style={{ display: 'flex', marginTop: 40 }}>
            <div
              style={{
                display: 'flex',
                background: '#fff',
                color: theme.text,
                fontSize: 26,
                fontWeight: 700,
                padding: '12px 28px',
                borderRadius: 999,
              }}
            >
              แตะเพื่อเปิด →
            </div>
          </div>
        </div>

        {/* RIGHT — visual (45%) */}
        <div
          style={{
            width: '45%',
            display: 'flex',
            position: 'relative',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              position: 'absolute',
              width: 560,
              height: 560,
              display: 'flex',
              borderRadius: 999,
              backgroundImage:
                'radial-gradient(circle, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 70%)',
            }}
          />
          <GiftBox theme={theme} />
          {/*
            Sticker fills come from the palette's LIGHT end (boxColor/ribbon):
            the OG gradient is built from accent → text, so an accent-filled
            sticker would sit on a background of its own colour and disappear.
          */}
          <Sticker
            kind="heart"
            size={64}
            fill={theme.boxColor}
            accent={theme.ribbon}
            rotate={-14}
            style={{ top: 78, left: 30 }}
          />
          <Sticker
            kind="star"
            size={56}
            fill={theme.ribbon}
            accent={theme.boxColor}
            rotate={12}
            style={{ top: 108, right: 52 }}
          />
          <Sticker
            kind="sparkle"
            size={52}
            fill={theme.boxColor}
            accent={theme.ribbon}
            rotate={-6}
            style={{ bottom: 96, right: 96 }}
          />
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts,
      headers: {
        // The image carries no box content, so it is safe (and cheap) to cache
        // hard at the unfurler/CDN — there are only 6 distinct renders.
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    },
  );
}

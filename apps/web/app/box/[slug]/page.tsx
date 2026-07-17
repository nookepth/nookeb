import type { Metadata } from 'next';
import { DEFAULT_THEME, isThemeId, type LegacyBoxThemeId } from '@nookeb/shared';
import { BoxReveal } from './BoxReveal';

// PUBLIC gift-reveal page (กล่องของขวัญ, migration 033). The slug is the
// credential; the page must never be indexed, and the OG preview must never
// carry the box's own content — no title, message, photo or creator name. A
// gift link pasted into a LINE group unfurls for the whole chat and is cached
// by the unfurler, so anything in the preview stops being a surprise for the
// person meant to open it. The only per-box detail in the image is the theme
// COLOUR (see app/api/og/route.tsx).

// generateMetadata runs per-request → this page is dynamic.
export const dynamic = 'force-dynamic';

const API_ORIGIN = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';

/**
 * Theme lookup for the OG image. Uses the open endpoint's NON-COUNTING
 * `preview=1` read: this runs on every request to /box/:slug — unfurl bots that
 * never open the box, plus once alongside the real client fetch on every
 * genuine open — so a counting read here would double real views and invent
 * views that never happened.
 *
 * Never throws: a failed lookup just yields the default-theme image.
 */
async function fetchBoxTheme(slug: string): Promise<LegacyBoxThemeId> {
  try {
    const res = await fetch(
      `${API_ORIGIN}/legacy-box/open/${encodeURIComponent(slug)}?preview=1`,
      { cache: 'no-store', signal: AbortSignal.timeout(2500) },
    );
    if (!res.ok) return DEFAULT_THEME;
    const data = (await res.json()) as { theme?: string };
    return data.theme && isThemeId(data.theme) ? data.theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const theme = await fetchBoxTheme(params.slug);
  const image = {
    url: `/api/og?theme=${theme}`,
    width: 1200,
    height: 630,
    alt: 'มีกล่องของขวัญรอคุณอยู่ — หนูเก็บ',
  };

  return {
    title: 'มีกล่องของขวัญรอคุณอยู่ 🎁 — หนูเก็บ',
    description: 'เปิดดูสิ่งที่เขาส่งมาให้คุณ',
    robots: { index: false, follow: false },
    openGraph: {
      title: 'มีกล่องของขวัญรอคุณอยู่ 🎁',
      description: 'เปิดดูสิ่งที่เขาส่งมาให้คุณ',
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'มีกล่องของขวัญรอคุณอยู่ 🎁',
      description: 'เปิดดูสิ่งที่เขาส่งมาให้คุณ',
      images: [image],
    },
  };
}

export default function BoxPage({ params }: { params: { slug: string } }) {
  return <BoxReveal slug={params.slug} />;
}

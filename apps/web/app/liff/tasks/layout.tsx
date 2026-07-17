import type { Metadata, Viewport } from 'next';
import { Prompt } from 'next/font/google';

// LIFF pages are in-app tooling, never search results (robots.ts also
// disallows /liff).
export const metadata: Metadata = {
  title: 'หนูเก็บ — ตามงาน',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1, // LIFF webview: pinch-zoom off keeps the sticky footer stable
};

// LINE Seed Sans Thai isn't redistributable via npm/Google Fonts; Prompt is
// the closest rounded Thai face. next/font self-hosts + preloads the woff2 and
// generates a metric-matched fallback, so Thai text renders without FOUT/CLS.
// Exposed as --font-liff; tasks.module.css .page consumes it.
const promptFont = Prompt({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-liff',
  display: 'swap',
});

export default function LiffTasksLayout({ children }: { children: React.ReactNode }) {
  // display:contents — the wrapper only exists to scope the font variable to
  // the LIFF subtree without adding a layout box.
  return (
    <div className={promptFont.variable} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

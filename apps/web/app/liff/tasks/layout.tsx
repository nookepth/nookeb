import type { Metadata, Viewport } from 'next';

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

export default function LiffTasksLayout({ children }: { children: React.ReactNode }) {
  return children;
}

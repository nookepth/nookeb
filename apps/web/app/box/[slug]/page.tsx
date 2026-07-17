import type { Metadata } from 'next';
import { BoxReveal } from './BoxReveal';

// PUBLIC gift-reveal page (กล่องของขวัญ, migration 033). The slug is the
// credential; the page must never be indexed, and the OG preview stays a
// generic branded image — never the recipient's actual photos.
export const metadata: Metadata = {
  title: 'มีกล่องของขวัญรอคุณอยู่ 🎁 — หนูเก็บ',
  description: 'เปิดดูสิ่งที่เขาส่งมาให้คุณ',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'มีกล่องของขวัญรอคุณอยู่ 🎁',
    description: 'เปิดดูสิ่งที่เขาส่งมาให้คุณ',
    images: ['/og-legacy-box.png'],
  },
};

export default function BoxPage({ params }: { params: { slug: string } }) {
  return <BoxReveal slug={params.slug} />;
}

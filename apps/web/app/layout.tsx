import type { Metadata } from 'next';
import { IBM_Plex_Sans_Thai } from 'next/font/google';
import './globals.css';

const ibmPlexSansThai = IBM_Plex_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-ibm-plex-sans-thai',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'หนูเก็บ — คลังไฟล์จาก LINE',
  description: 'ส่งไฟล์ผ่าน LINE เก็บถาวร เปิดดูได้ทุกที่',
  openGraph: {
    title: 'หนูเก็บ — คลังไฟล์จาก LINE',
    description: 'ส่งไฟล์ผ่าน LINE เก็บถาวร เปิดดูได้ทุกที่',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary',
    title: 'หนูเก็บ — คลังไฟล์จาก LINE',
    description: 'ส่งไฟล์ผ่าน LINE เก็บถาวร เปิดดูได้ทุกที่',
    images: ['/logo.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={ibmPlexSansThai.variable}>
      <body>{children}</body>
    </html>
  );
}

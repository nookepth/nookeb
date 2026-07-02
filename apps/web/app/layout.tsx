import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'หนูเก็บ — คลังไฟล์จาก LINE',
  description: 'ส่งไฟล์ผ่าน LINE เก็บถาวร เปิดดูได้ทุกที่',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}

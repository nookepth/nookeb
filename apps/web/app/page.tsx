import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Itim } from 'next/font/google';

import ChatDemo from '@/components/landing/ChatDemo';
import Reveal from '@/components/landing/Reveal';
import { INSTAGRAM_URL, LINE_ADD_FRIEND_URL, LINE_ID, SITE_URL, TIKTOK_URL } from '@/lib/site';
import styles from './page.module.css';

/* Handwritten Thai accent font — self-hosted by next/font, loaded on this route only. */
const itim = Itim({
  subsets: ['thai', 'latin'],
  weight: '400',
  variable: '--font-itim',
  display: 'swap',
});

/* ============================================================
   V2 — "ฝากไว้กับหนูเก็บ"

   The v1 page sold ONE feature (a file locker). Playbook v2 ส่วนที่ 1 retires
   that position: หนูเก็บ is now "ที่ฝากของใจกลางไลน์" and the brand leads with
   the umbrella verb ฝาก, with a variant per feature family. This page is built
   around that system — the "ฝากอะไรได้บ้าง" locker wall is the spine, and every
   other section either proves it (demo, steps) or removes a reason to leave
   (free space, trust, FAQ).

   Every claim below is checked against the playbook's ตาราง 2.2 (เคลมได้) and
   2.3 (ห้ามเคลม). The three that bite hardest, because the live v1 page broke
   two of them:
   - NO auto-reminder claim for ตามงาน — reminders exist in code but ship
     disabled (TASK_NOTIFICATIONS_ENABLED=false).
   - NO group notify toggle — "หนูเก็บปิดแจ้งเตือน" was retired; groups now
     store silently, always. (v1's FAQ still taught the dead command.)
   - NO unconditional "เก็บถาวรตลอดไป" — say "ไม่หมดอายุเหมือนไฟล์ในแชท" and
     be upfront about ถังขยะ.
   Also absent on purpose: Google Sheets sync (Pro-locked, not on sale).
   ============================================================ */

const TITLE = 'หนูเก็บ (Nookeb) — ฝากไฟล์ งาน และความทรงจำไว้ในไลน์ ฟรี 1 GB';
const DESCRIPTION =
  'ฝากไว้กับหนูเก็บ — ส่งรูปหรือไฟล์เข้าแชท LINE แล้วเก็บเข้าล็อคเกอร์บนคลาวด์ทันที ' +
  'ไม่หมดอายุเหมือนไฟล์ในแชท ค้นหาเจอแม้จำชื่อไฟล์ไม่ได้ สแกนเอกสารเป็น PDF รวมไฟล์ PDF ' +
  'แปลงรูปเป็น Word ตั้งงานตามในกลุ่ม ไดอารี่ 365 วัน ห้องนิรภัย และกล่องของขวัญ ' +
  'เริ่มฟรี 1 GB ไม่ต้องโหลดแอป ไม่ต้องสมัครสมาชิก';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'หนูเก็บ',
    'nookeb',
    'ฝากไว้กับหนูเก็บ',
    'เก็บไฟล์ LINE',
    'ฝากไฟล์ออนไลน์',
    'ไฟล์หมดอายุ LINE',
    'สแกนเอกสารเป็น PDF ฟรี',
    'รวมไฟล์ PDF',
    'แปลงรูปเป็น Word',
    'ไดอารี่ 365 วัน',
    'ตามงานในกลุ่มไลน์',
    'LINE bot เก็บไฟล์',
  ],
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    locale: 'th_TH',
    url: '/',
    siteName: 'หนูเก็บ (Nookeb)',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: '/landing/og.jpg', width: 1200, height: 1360, alt: 'หนูเก็บ — ฝากไว้กับหนูเก็บ' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/landing/og.jpg'],
  },
};

/* ============================================================
   Content
   ============================================================ */

/* The umbrella verb, one item per tagline variant (playbook ส่วนที่ 1). */
const MARQUEE_ITEMS = [
  'ฝากไฟล์',
  'ฝากเอกสาร',
  'ฝากไว้ทั้งกลุ่ม',
  'ฝากตามงาน',
  'ฝากความทรงจำ',
  'ฝากไฟล์สำคัญ',
  'ฝากส่งให้กัน',
  'ฝากไว้กับหนูเก็บ',
];

/* IMAGE: the R2 static/onboarding/ set is one card per ฝาก variant — locker
   door, torn note, hook line, and a "ฝาก___" pill. It IS the v2 tagline system
   drawn out, so it drives this section rather than decorating it. */
interface Deposit {
  /** Card artwork. `art` renders a CSS locker door instead (see note below). */
  img?: { src: string; alt: string };
  art?: { tint: string; hook: string; line: string };
  tint: 'red' | 'gold' | 'navy' | 'teal' | 'pink' | 'rose';
  kicker: string;
  title: string;
  bullets: string[];
  chip: string;
  fine?: string;
}

const DEPOSITS: Deposit[] = [
  {
    img: {
      src: '/landing/onboarding/files.webp',
      alt: 'การ์ดหนูเก็บ: ไฟล์สำคัญในไลน์หมดอายุแล้ว — ฝากไว้กับหนูเก็บ ไม่หายอีกแล้ว',
    },
    tint: 'red',
    kicker: 'ฝากไฟล์',
    title: 'ไฟล์หมดอายุ ไม่ต้องเจออีกแล้วน้า',
    bullets: [
      'ส่งรูป เอกสาร วิดีโอ หรือเสียงเข้าแชท เก็บให้ทันที ไฟล์ละไม่เกิน 1 GB',
      'จำชื่อไฟล์ไม่ได้ก็หาเจอ — พิมพ์คำที่อยู่ในใบเสร็จหรือเอกสารได้เลย',
      'จัดโฟลเดอร์ ติดแท็ก เปลี่ยนชื่อ ดาวน์โหลด ทำได้หมดบนเว็บล็อคเกอร์',
    ],
    chip: 'ส่งไฟล์เข้าแชทได้เลย ไม่ต้องพิมพ์คำสั่ง',
  },
  {
    img: {
      src: '/landing/onboarding/docs.webp',
      alt: 'การ์ดหนูเก็บ: แปลงไฟล์ สแกน และรวมรูป — ฝากทำเอกสาร หนูเก็บคอยช่วย',
    },
    tint: 'gold',
    kicker: 'ฝากเอกสาร',
    title: 'ร้านถ่ายเอกสารอยู่ในไลน์พี่แล้ว',
    bullets: [
      'ถ่ายเอกสารทีละหน้า พิมพ์ "เสร็จ" ได้ PDF ไฟล์เดียว คมชัดเหมือนเครื่องสแกน',
      'มี PDF หลายไฟล์ ส่งให้หนูรวมเป็นไฟล์เดียวได้ (ไฟล์ละไม่เกิน 20 MB สูงสุด 20 ไฟล์)',
      'ถ่ายรูปเอกสารมา หนูแปลงเป็นไฟล์ Word ให้เอาไปแก้ต่อได้เลย',
    ],
    chip: '"หนูเก็บฟีเจอร์เอกสาร"',
    fine: 'ใช้ในแชทส่วนตัวกับหนูเก็บ',
  },
  {
    // IMAGE: used as-is, caption rewritten to avoid notification claims
    img: {
      src: '/landing/onboarding/tasks.webp',
      alt: 'การ์ดหนูเก็บ: สั่งงานในกลุ่มแล้วรู้ว่าใครทำถึงไหน — ฝากตามงาน',
    },
    tint: 'teal',
    kicker: 'ฝากตามงาน',
    title: 'สั่งงานในกลุ่ม แล้วรู้ว่าใครทำถึงไหน',
    bullets: [
      'มอบหมายงานในกลุ่มได้ 3 แบบ — งานเดียวมอบหลายคน · แยกงานเป็นรายการ · งานประจำทำซ้ำตามรอบ',
      'เปิดห้องทีมดูได้ตลอดว่าใครสั่งอะไร ใครรับไปแล้ว และงานไหนยังค้างอยู่',
      'ไฟล์ที่แนบกับงานอยู่รวมกันเป็นประวัติของทีม ไม่ต้องไล่ขอไฟล์เดิมซ้ำอีก',
    ],
    chip: '"หนูเก็บสร้างงาน"',
    fine: 'อยู่คนเดียวก็ใช้ได้ — พิมพ์ในแชทส่วนตัวจะได้งานส่วนตัวที่มีแค่พี่คนเดียว',
  },
  {
    img: {
      src: '/landing/onboarding/diary.webp',
      alt: 'การ์ดหนูเก็บ: บันทึกไดอารี่ 365 วัน — ฝากความทรงจำ',
    },
    tint: 'pink',
    kicker: 'ฝากความทรงจำ',
    title: 'วันละรูป ครบปีได้หนังชีวิตตัวเอง',
    bullets: [
      'ส่งรูปวันละ 1 รูป พิมพ์แคปชั่นไปด้วยก็ได้',
      'หนูเรียงให้เป็นตาราง 365 ช่อง พร้อมนับ streak วันติดต่อกัน',
      'เปิดย้อนดูได้ว่า "วันนี้เมื่อ 100 วันก่อน" พี่ทำอะไรอยู่',
    ],
    chip: '"หนูเก็บไดอารี่"',
    fine: 'ใช้ในแชทส่วนตัวกับหนูเก็บ',
  },
  {
    img: {
      src: '/landing/onboarding/gift.webp',
      alt: 'การ์ดหนูเก็บ: ส่งของขวัญให้คนพิเศษ — ฝากส่งกล่องของขวัญดิจิทัล',
    },
    tint: 'rose',
    kicker: 'ฝากส่งให้กัน',
    title: 'อยากบอกรัก แต่ไม่รู้จะพูดยังไง',
    bullets: [
      'ใส่รูป 1–10 รูป ข้อความ และเสียงพูดสั้น ๆ ของพี่เอง',
      'เลือกโอกาสและธีมสี แล้วได้ลิงก์ไว้ส่งให้คนพิเศษ',
      'คนรับกดเปิดเป็นแอนิเมชันแกะกล่อง เซอร์ไพรส์กว่าส่งรูปเปล่า ๆ',
    ],
    chip: 'สร้างที่เว็บล็อคเกอร์',
  },
  {
    img: {
      src: '/landing/onboarding/group.webp',
      alt: 'การ์ดหนูเก็บ: ดึงหนูเก็บเข้ากลุ่ม ไฟล์ไม่หายอีก — ฝากเก็บไฟล์ในทีม',
    },
    tint: 'navy',
    kicker: 'ฝากไว้ทั้งกลุ่ม',
    title: 'ดึงหนูเข้ากลุ่ม ไฟล์ทั้งกลุ่มไม่หายอีกเลย',
    bullets: [
      'ไฟล์ที่สมาชิกส่งหลังจากนั้น เก็บเข้าพื้นที่กลางของกลุ่มอัตโนมัติ',
      'ทุกคนเปิดดูย้อนหลังได้ ไม่ต้องไล่ขอไฟล์ใหม่จากใคร',
      'ในกลุ่มหนูเก็บให้เงียบ ๆ เสมอ ไม่เด้งกวนแชทเลยน้า',
    ],
    chip: 'เชิญหนูเก็บเข้ากลุ่มไลน์',
  },
];

const STEPS: { title: string; desc: string; quote?: string }[] = [
  {
    title: 'เพิ่มเพื่อน "หนูเก็บ"',
    desc: `กดปุ่มเพิ่มเพื่อน หรือค้นหา LINE ID ${LINE_ID} แล้วทักสวัสดีหนูได้เลยน้า`,
  },
  {
    title: 'ส่งรูปหรือไฟล์เข้าแชท',
    desc: 'เหมือนส่งให้เพื่อนอีกคน เดี๋ยวหนูเก็บเข้าล็อคเกอร์ให้ทันที พร้อมการ์ดบอกความคืบหน้า',
    quote: 'หนูเก็บให้แล้วน้า',
  },
  {
    title: 'เปิดดูได้ทุกที่',
    desc: 'เข้าเว็บล็อคเกอร์ด้วย LINE Login — ดู ค้นหา จัดโฟลเดอร์ ติดแท็ก และดาวน์โหลดได้จากทุกเครื่อง',
  },
];

const RUNGS: { gb: string; label: string; top?: boolean }[] = [
  { gb: '1 GB', label: 'เริ่มเลย ฟรี' },
  { gb: '2.5 GB', label: 'ชวนเพื่อน 3 คน' },
  { gb: '4 GB', label: 'ชวนเพื่อน 5 คน', top: true },
];

const TRUST: { icon: React.ReactNode; title: string; desc: string }[] = [
  {
    icon: <IcoBellOff />,
    title: 'หนูไม่ทักก่อน ไม่สแปม',
    desc: 'ในแชทส่วนตัว หนูเก็บตอบเฉพาะตอนพี่ทักหรือส่งไฟล์มา ไม่มีโฆษณายิงใส่แชท — แชทของพี่คือพื้นที่ของพี่น้า',
  },
  {
    icon: <IcoLock />,
    title: 'ไฟล์สำคัญ ก็ฝากได้',
    desc: 'ไฟล์สำคัญฝากไว้ที่หนูได้เลย หนูเก็บดูแลให้เหมือนห้องนิรภัย — ปลอดภัยแน่นอนน้า',
  },
  {
    icon: <IcoUndo />,
    title: 'ลบผิดยังกู้คืนได้',
    desc: 'ไฟล์ที่ลบไปพักในถังขยะก่อน กู้คืนได้ภายใน 5 วัน แล้วค่อยถูกล้างจริง',
  },
  {
    icon: <IcoTimer />,
    title: 'ลิงก์ดาวน์โหลดชั่วคราว',
    desc: 'ลิงก์ดาวน์โหลดหมดอายุใน 1 ชั่วโมง ป้องกันไฟล์หลุดต่อโดยไม่ตั้งใจ',
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: 'หนูเก็บฟรีจริงไหม? มีเก็บเงินทีหลังหรือเปล่า?',
    a: 'ตอนนี้ทุกฟีเจอร์ใช้ฟรี เริ่มต้นได้ 1 GB โดยไม่ต้องผูกบัตรหรือกรอกข้อมูลจ่ายเงินใด ๆ ยังไม่มีระบบชำระเงินในหนูเก็บเลยน้า อยากได้พื้นที่เพิ่มก็ชวนเพื่อนมาใช้ด้วยกัน — ชวนครบ 5 คนได้ 4 GB ถาวร',
  },
  {
    q: 'ต้องโหลดแอปเพิ่มไหม?',
    a: 'ไม่ต้องน้า หนูเก็บอยู่ใน LINE ที่พี่ใช้อยู่ทุกวันแล้ว ไม่มีแอปหนูเก็บให้โหลด ส่วนการเปิดดูและจัดระเบียบไฟล์ทำผ่านเว็บเบราว์เซอร์ ล็อกอินด้วย LINE ได้เลย ไม่ต้องสมัครสมาชิกใหม่ ไม่ต้องจำรหัสผ่าน',
  },
  {
    q: 'ฝากอะไรกับหนูเก็บได้บ้าง?',
    a: 'ฝากไฟล์ (รูป เอกสาร วิดีโอ เสียง ไฟล์ละไม่เกิน 1 GB) · ฝากเอกสาร (สแกนเป็น PDF รวมรูป รวมไฟล์ PDF แปลงเป็น Word) · ฝากไว้ทั้งกลุ่ม (พื้นที่กลางของกลุ่มไลน์) · ฝากตามงาน (สร้างและมอบหมายงานในกลุ่ม หรือจดงานส่วนตัว) · ฝากความทรงจำ (ไดอารี่ 365 วัน) · ฝากไฟล์สำคัญ (ห้องนิรภัยล็อก PIN) · และฝากส่งให้กัน (กล่องของขวัญ) น้า',
  },
  {
    q: 'ไฟล์ที่ขึ้น "หมดอายุ" ในไลน์ไปแล้ว กู้คืนได้ไหม?',
    a: 'อันนี้หนูช่วยไม่ได้จริง ๆ น้า — ไฟล์ที่หมดอายุไปแล้ว ระบบไหนก็เปิดไม่ได้ วิธีที่ดีที่สุดคือเก็บก่อนหมดอายุ เห็นไฟล์สำคัญเมื่อไหร่ ฟอร์เวิร์ดมาให้หนูทันทีเลยน้า',
  },
  {
    q: 'เผลอลบไฟล์ในล็อคเกอร์ กู้คืนได้ไหม?',
    a: 'ได้น้า ไฟล์ที่ลบจะไปพักในถังขยะก่อน กดกู้คืนได้ภายใน 5 วัน พ้นกำหนดแล้วถึงจะถูกล้างจริง — เพราะงั้นหนูเลยไม่กล้าพูดว่า "เก็บถาวรตลอดไป" แบบไม่มีเงื่อนไขน้า แต่ไฟล์ที่พี่ไม่ได้ลบ อยู่ในล็อคเกอร์ต่อไป ไม่หมดอายุเหมือนไฟล์ในแชท',
  },
  {
    q: 'ไฟล์ของฉันปลอดภัยแค่ไหน?',
    a: 'ไฟล์ถูกเก็บบนคลาวด์ระดับองค์กร แยกพื้นที่ของแต่ละบัญชีชัดเจน ลิงก์ดาวน์โหลดเป็นลิงก์ชั่วคราวที่หมดอายุใน 1 ชั่วโมง ถ้าเป็นข้อมูลส่วนตัวจริง ๆ ใช้ "ห้องนิรภัย" บนเว็บได้ — ล็อกด้วย PIN 6 หลัก ไฟล์ถูกเข้ารหัสไว้ เปิดดูได้อย่างเดียวและมีลายน้ำชื่อผู้ดู ใส่ PIN ผิด 5 ครั้งล็อก 15 นาที และไม่มีระบบรีเซ็ต PIN น้า',
  },
  {
    q: 'ใช้ในกลุ่มไลน์ได้ไหม? หนูเก็บจะกวนแชทหรือเปล่า?',
    a: 'ใช้ได้น้า เชิญหนูเก็บเข้ากลุ่ม แล้วไฟล์ที่สมาชิกส่งหลังจากนั้นจะถูกเก็บเข้าพื้นที่กลางของกลุ่มอัตโนมัติ — และในกลุ่มหนูเก็บให้เงียบ ๆ เสมอ ไม่ตอบอะไรกลับเลย ไม่ต้องตั้งค่าอะไรทั้งนั้น ยกเว้นตอนมีคนสร้างงานในระบบตามงาน หนูถึงจะโพสต์การ์ดประกาศงานให้ทั้งกลุ่มเห็น (ส่วนสแกน รวมรูป รวมไฟล์ แปลงไฟล์ และไดอารี่ ใช้ในแชทส่วนตัวกับหนูเก็บน้า)',
  },
  {
    q: 'ทำไมถึงชื่อ "หนูเก็บ"?',
    a: 'หนูเกิดมาจากเอกสารที่ใช้เสร็จแล้วถูกทิ้ง เลยตั้งใจเก็บกระดาษ รูป และความทรงจำของพี่ ๆ ให้เป็นระเบียบ ไม่ให้หล่นหาย ชื่อ "หนูเก็บ" เลยอ่านได้สองแบบ — หนูน้อยที่ชอบเก็บของ และประโยคที่หนูพูดเสมอว่า "หนูเก็บให้เองน้า"',
  },
];

/* JSON-LD — WebSite + SoftwareApplication + FAQPage (คำตอบตรงกับ FAQ บนหน้าเป๊ะ) */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: 'หนูเก็บ',
      alternateName: 'Nookeb',
      url: SITE_URL,
      inLanguage: 'th',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'หนูเก็บ (Nookeb)',
      url: SITE_URL,
      image: `${SITE_URL}/landing/og.jpg`,
      description: DESCRIPTION,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Web, LINE',
      inLanguage: 'th',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'THB' },
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

export default function Home() {
  return (
    <div className={`${styles.landing} ${itim.variable}`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      {/* JS ปิดอยู่ → โชว์เนื้อหาทั้งหมดทันที (Reveal ไม่ทำงาน) */}
      <noscript>
        <style>{'[data-reveal]{opacity:1 !important;transform:none !important}'}</style>
      </noscript>
      {/* Failsafe ไม่พึ่ง hydration: ถ้า reveal ตัวไหนยังไม่ถูกเปิดใน 4 วิ ให้เปิดเลย
          (กันกรณี JS โหลด/รันไม่สำเร็จ — เนื้อหาต้องไม่ค้างล่องหน) */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "setTimeout(function(){for(var l=document.querySelectorAll('[data-reveal]:not([data-visible])'),i=0;i<l.length;i++)l[i].setAttribute('data-visible','true')},4000);",
        }}
      />

      {/* ============ Nav ============ */}
      <header className={styles.nav}>
        <div className={`${styles.wrap} ${styles.navInner}`}>
          <Link href="/" className={styles.brand} aria-label="หนูเก็บ — หน้าแรก">
            <Image src="/logo.png" alt="" width={34} height={34} className={styles.brandLogo} priority />
            <span className={styles.brandName}>หนูเก็บ</span>
            <span className={styles.beta}>beta</span>
          </Link>
          <nav className={styles.navLinks} aria-label="เมนูหลัก">
            <a href="#deposit" className={styles.navLink}>ฝากอะไรได้บ้าง</a>
            <a href="#try" className={styles.navLink}>ลองเล่น</a>
            <a href="#how" className={styles.navLink}>วิธีใช้</a>
            <a href="#free" className={styles.navLink}>พื้นที่ฟรี</a>
            <a href="#faq" className={styles.navLink}>คำถามพบบ่อย</a>
          </nav>
          <div className={styles.navCtas}>
            <Link href="/dashboard" className={`${styles.btnSecondary} ${styles.btnSm} ${styles.navGhostHide}`}>
              เปิดล็อคเกอร์
            </Link>
            <a href={LINE_ADD_FRIEND_URL} className={`${styles.btnPrimary} ${styles.btnSm}`}>
              <IcoChat size={17} />
              เพิ่มเพื่อนฟรี
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* ============ Hero ============ */}
        <section className={styles.hero}>
          <div className={`${styles.wrap} ${styles.heroInner}`}>
            <div>
              <p className={styles.heroBadge}>
                <IcoStarFill size={15} />
                ที่ฝากของใจกลางไลน์ — ฟรี ไม่ต้องโหลดแอป
              </p>
              <h1 className={styles.heroTitle}>
                <span className={styles.noWrap}>ฝากไว้กับหนูเก็บ</span>
                <span className={`${styles.heroTitleAccent} ${styles.hand}`}>
                  — เดี๋ยวหนูดูแลให้เองน้า
                </span>
              </h1>
              <p className={styles.heroSub}>
                เคยเปิดรูปในแชทแล้วเจอ &ldquo;ไฟล์หมดอายุ&rdquo; ไหมน้า? ส่งไฟล์ ฝากงาน
                หรือเก็บความทรงจำ — <strong>ส่งเข้าแชทหนูเก็บแล้วจบ</strong>{' '}
                ไม่หมดอายุเหมือนไฟล์ในแชท ค้นหาเจอ เปิดดูได้ทุกที่
              </p>
              <div className={styles.heroCtas}>
                <a href={LINE_ADD_FRIEND_URL} className={styles.btnPrimary}>
                  <IcoChat size={19} />
                  เพิ่มเพื่อนใน LINE — ฟรี
                </a>
                <Link href="/dashboard" className={styles.btnSecondary}>
                  เปิดล็อคเกอร์ของฉัน
                  <IcoArrowRight size={17} />
                </Link>
              </div>
              <div className={styles.heroChips}>
                <span className={styles.chip}><IcoCheck size={15} />ฟรี 1 GB ไม่ผูกบัตร</span>
                <span className={styles.chip}><IcoCheck size={15} />ล็อกอินด้วย LINE ไม่ต้องสมัคร</span>
                <span className={styles.chip}><IcoCheck size={15} />ไม่ทักก่อน ไม่สแปม</span>
              </div>
            </div>

            {/* chat mockup + สติกเกอร์ */}
            <div className={styles.heroVisual} aria-hidden="true">
              <div className={styles.noteSticker}>
                <IcoPin />
                <span className={styles.hand}>ไม่หมดอายุน้า</span>
              </div>
              <div className={styles.starSticker}>
                <IcoStarBig />
              </div>

              <div className={styles.chatCard}>
                <div className={styles.chatHead}>
                  <Image src="/logo.png" alt="" width={38} height={38} className={styles.chatAvatar} priority />
                  <div>
                    <div className={styles.chatName}>หนูเก็บ</div>
                    <div className={styles.chatStatus}>
                      <span className={styles.dotOnline} />
                      ผู้ดูแลล็อคเกอร์ · พร้อมเก็บเสมอ
                    </div>
                  </div>
                </div>
                <div className={styles.chatBody}>
                  <span className={styles.chatDay}>วันนี้ 09:12</span>

                  <div className={styles.msgUser}>
                    <span className={styles.photoMsg}>
                      <IcoReceiptPhoto />
                      <span className={styles.photoMsgName}>ใบเสร็จค่าเทอม.jpg</span>
                    </span>
                    <span className={styles.msgMeta}>ส่งแล้ว 09:12</span>
                  </div>

                  <div className={styles.msgBot}>แป๊บนึงน้าพี่ เดี๋ยวเก็บเข้าล็อคเกอร์ให้เลยน้า</div>

                  <div className={styles.msgBotCard}>
                    <div className={styles.msgBotCardHead}>
                      <IcoCheckCircle size={19} />
                      หนูเก็บให้แล้วน้า
                    </div>
                    <div className={styles.fileRow}>
                      <IcoFolder size={20} />
                      <span className={styles.fileName}>
                        ใบเสร็จค่าเทอม.jpg
                        <span className={styles.fileHint}>อยู่ในล็อคเกอร์แล้ว · ไม่หมดอายุเหมือนไฟล์ในแชท</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.folderSticker}>
                <IcoFolderSticker />
              </div>
              <div className={styles.mascot}>
                <Image src="/logo.png" alt="" width={148} height={148} priority />
              </div>
            </div>
          </div>
        </section>

        {/* ============ Marquee ============ */}
        <div className={styles.marquee} aria-hidden="true">
          <div className={styles.marqueeTrack}>
            {[0, 1].map((dup) => (
              <div className={styles.marqueeGroup} key={dup}>
                {MARQUEE_ITEMS.map((item) => (
                  <span className={styles.marqueeItem} key={item}>
                    <IcoStarFill size={14} />
                    {item}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ============ Locker wall — "ฝากอะไรได้บ้าง" ============ */}
        <section id="deposit" className={styles.section} aria-labelledby="deposit-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.depositHead}>
                <div>
                  <p className={`${styles.kicker} ${styles.hand}`}>
                    <IcoSparkle size={18} />
                    ล็อคเกอร์ของหนูเก็บ
                  </p>
                  <h2 id="deposit-title" className={styles.sectionTitle}>
                    ฝากอะไรกับหนูเก็บได้บ้างน้า
                  </h2>
                  <p className={styles.sectionSub}>
                    หนูเก็บโตจาก &ldquo;ที่เก็บไฟล์&rdquo; มาเป็น &ldquo;ที่ฝากของ&rdquo; หลายแบบแล้วน้า
                    — เปิดล็อคเกอร์ดูได้เลยว่าฝากอะไรไว้กับหนูได้บ้าง
                  </p>
                </div>
                <figure className={styles.depositHeroCard}>
                  <span className={styles.tape} aria-hidden="true" />
                  <Image
                    src="/landing/onboarding/umbrella.webp"
                    alt="การ์ดหนูเก็บ: ฝากไว้กับหนูเก็บ — เก็บทุกอย่างไว้อย่างปลอดภัย"
                    width={450}
                    height={450}
                    className={styles.depositHeroImg}
                  />
                </figure>
              </div>
            </Reveal>

            <div className={styles.depositGrid}>
              {DEPOSITS.map((d, i) => (
                <Reveal className={styles.reveal} delay={(i % 3) * 90} key={d.kicker}>
                  <article className={`${styles.depositCard} ${styles[d.tint]}`}>
                    {d.img ? (
                      <Image
                        src={d.img.src}
                        alt={d.img.alt}
                        width={380}
                        height={380}
                        className={styles.depositImg}
                        sizes="(max-width: 620px) 92vw, (max-width: 980px) 46vw, 32vw"
                      />
                    ) : null}
                    {d.art ? (
                      /* CSS stand-in for the one card whose official artwork
                         carries a claim we may not make — see the TODO above. */
                      <div className={styles.depositArt} aria-hidden="true">
                        <span className={styles.depositArtVent} />
                        <span className={styles.depositArtNote}>
                          <em>{d.art.hook}</em>
                          <strong>{d.art.line}</strong>
                        </span>
                      </div>
                    ) : null}

                    <div className={styles.depositBody}>
                      <p className={`${styles.depositKicker} ${styles.hand}`}>{d.kicker}</p>
                      <h3 className={styles.depositTitle}>{d.title}</h3>
                      <ul className={styles.depositList}>
                        {d.bullets.map((b) => (
                          <li key={b}>
                            <IcoCheck size={15} />
                            <span>{b}</span>
                          </li>
                        ))}
                      </ul>
                      <span className={styles.cmdChip}>
                        <IcoChat size={13} />
                        {d.chip}
                      </span>
                      {d.fine ? <span className={styles.finePrint}>{d.fine}</span> : null}
                    </div>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ Interactive demo ============ */}
        <section id="try" className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="try-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  ลองก่อนเพิ่มเพื่อนก็ได้
                </p>
                <h2 id="try-title" className={styles.sectionTitle}>ลองคุยกับหนูดูน้า</h2>
                <p className={styles.sectionSub}>
                  กดคำสั่งดูได้เลยว่าหนูตอบว่าอะไร — พิมพ์แค่นี้จริง ๆ ไม่มีเมนูซ้อนเมนู
                  ไม่ต้องตั้งค่าอะไรเลยน้า
                </p>
              </div>
            </Reveal>
            <Reveal className={styles.reveal} delay={100}>
              <ChatDemo />
            </Reveal>
            <Reveal className={styles.reveal} delay={160}>
              <div className={styles.stepsCta}>
                <a href={LINE_ADD_FRIEND_URL} className={styles.btnPrimary}>
                  <IcoChat size={19} />
                  ลองของจริงเลยน้า
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ 3 steps ============ */}
        <section id="how" className={styles.section} aria-labelledby="how-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  ใช้งานง่ายมาก
                </p>
                <h2 id="how-title" className={styles.sectionTitle}>เริ่มใช้ได้ใน 3 ขั้นตอน</h2>
                <p className={styles.sectionSub}>ไม่ต้องตั้งค่าอะไรทั้งนั้น ถ้าส่งไลน์เป็น ก็ใช้หนูเก็บเป็นแล้ว</p>
              </div>
            </Reveal>
            <div className={styles.steps}>
              {STEPS.map((s, i) => (
                <Reveal className={styles.reveal} delay={i * 120} key={s.title}>
                  <div className={styles.step}>
                    <div className={`${styles.stepNum} ${styles.hand}`}>{i + 1}</div>
                    <h3 className={styles.stepTitle}>{s.title}</h3>
                    <p className={styles.stepDesc}>{s.desc}</p>
                    {s.quote ? (
                      <span className={styles.stepQuote}>
                        <IcoCheckCircle size={16} />
                        {s.quote}
                      </span>
                    ) : null}
                    {i < STEPS.length - 1 ? (
                      <span className={styles.stepArrow} aria-hidden="true">
                        <IcoDoodleArrow />
                      </span>
                    ) : null}
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ Free space ============ */}
        <section id="free" className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="free-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  พื้นที่ฟรี
                </p>
                <h2 id="free-title" className={styles.sectionTitle}>ฟรี 1 GB — ชวนเพื่อนขยายได้ถึง 4 GB</h2>
              </div>
            </Reveal>
            <Reveal className={styles.reveal} delay={120}>
              <div className={styles.freeCard}>
                <figure className={styles.freeArt}>
                  <Image
                    src="/landing/onboarding/referral.webp"
                    alt="การ์ดหนูเก็บ: ชวนเพื่อนได้พื้นที่ฟรี — ได้พื้นที่เพิ่มทั้งคู่"
                    width={430}
                    height={430}
                    className={styles.freeArtImg}
                    sizes="(max-width: 900px) 84vw, 40vw"
                  />
                </figure>
                <div>
                  <p className={`${styles.freeKicker} ${styles.hand}`}>เริ่มต้นที่</p>
                  <p className={styles.freeBig}>
                    1 <span>GB</span>
                  </p>
                  <p className={styles.freeDesc}>
                    ไม่ต้องผูกบัตร ไม่มีค่ารายเดือน ตอนนี้ทุกฟีเจอร์ใช้ฟรีทั้งหมด
                    อยากได้พื้นที่เพิ่ม แค่ชวนเพื่อนมาใช้ด้วยกัน — ได้พื้นที่เพิ่มทั้งคู่เลยน้า
                  </p>
                  <div className={styles.ladder}>
                    {RUNGS.map((r) => (
                      <div className={`${styles.rung} ${r.top ? styles.rungTop : ''}`} key={r.gb}>
                        {r.top ? (
                          <span className={styles.rungCrown}>
                            <IcoCrown size={18} />
                          </span>
                        ) : null}
                        <span className={styles.rungGb}>{r.gb}</span>
                        <span className={styles.rungLabel}>{r.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.freeNotes}>
                    <p className={styles.freeNote}>
                      <IcoCheck size={16} />
                      กรอกโค้ดของเพื่อนตอนเริ่มใช้ รับพื้นที่เพิ่ม 0.5 GB
                    </p>
                    <p className={styles.freeNote}>
                      <IcoCheck size={16} />
                      ชวนสำเร็จ 3 · 5 คน พื้นที่รวมเป็น 2.5 · 4 GB ถาวร (5 คนคือขั้นสูงสุด)
                    </p>
                    <p className={styles.freeNote}>
                      <IcoCheck size={16} />
                      พิมพ์ &ldquo;หนูเก็บเชิญ&rdquo; ในแชทเพื่อดูโค้ดของตัวเอง
                    </p>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ Trust ============ */}
        <section className={styles.section} aria-labelledby="trust-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  เชื่อหนูได้น้า
                </p>
                <h2 id="trust-title" className={styles.sectionTitle}>ฝากของไว้กับหนู แล้วสบายใจได้</h2>
              </div>
            </Reveal>
            <div className={styles.trustRow}>
              {TRUST.map((t, i) => (
                <Reveal className={styles.reveal} delay={(i % 2) * 100} key={t.title}>
                  <div className={styles.trustItem}>
                    <div className={styles.trustIcon}>{t.icon}</div>
                    <div>
                      <h3 className={styles.trustTitle}>{t.title}</h3>
                      <p className={styles.trustDesc}>{t.desc}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section id="faq" className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="faq-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  สงสัยตรงไหน ถามหนูได้
                </p>
                <h2 id="faq-title" className={styles.sectionTitle}>คำถามที่พี่ ๆ ถามบ่อย</h2>
              </div>
            </Reveal>
            <Reveal className={styles.reveal} delay={100}>
              <div className={styles.faqList}>
                {FAQS.map((f) => (
                  <details className={styles.faqItem} key={f.q}>
                    <summary className={styles.faqQ}>
                      {f.q}
                      <span className={styles.faqPlus}>
                        <IcoPlus size={18} />
                      </span>
                    </summary>
                    <p className={styles.faqA}>{f.a}</p>
                  </details>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ Final CTA ============ */}
        <section className={styles.section} aria-labelledby="cta-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.cta}>
                <div className={styles.ctaInner}>
                  <div>
                    <h2 id="cta-title" className={styles.ctaTitle}>
                      มีอะไรอยากฝากหนูไหมน้า
                    </h2>
                    <p className={styles.ctaSub}>
                      เพิ่มเพื่อนแล้วลองส่งไฟล์แรกได้เลย — ฟรี ไม่ต้องโหลดแอป ไม่ต้องสมัครสมาชิก
                      ฝากไว้กับหนูเก็บ เดี๋ยวหนูดูแลให้เองน้า
                    </p>
                    <div className={styles.ctaBtns}>
                      <a href={LINE_ADD_FRIEND_URL} className={styles.btnWhite}>
                        <IcoChat size={19} />
                        เพิ่มเพื่อนใน LINE
                      </a>
                      <span className={styles.ctaLineId}>
                        <IcoQr size={17} />
                        LINE ID: {LINE_ID}
                      </span>
                    </div>
                  </div>
                  <div className={styles.ctaMascotWrap}>
                    <figure className={styles.ctaPolaroid}>
                      <Image
                        src="/landing/onboarding/cover.webp"
                        alt="การ์ดหนูเก็บ: ลองเขียนว่า หนูเก็บ ในแชทไลน์"
                        width={280}
                        height={280}
                      />
                      <figcaption className={`${styles.ctaPolaroidCap} ${styles.hand}`}>
                        ลองพิมพ์ว่า &ldquo;หนูเก็บ&rdquo; น้า
                      </figcaption>
                    </figure>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ============ Footer ============ */}
      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div className={styles.footGrid}>
            <div className={styles.footBrand}>
              <div className={styles.footBrandRow}>
                <Image src="/logo.png" alt="" width={32} height={32} />
                <span className={styles.brandName}>หนูเก็บ</span>
                <span className={styles.beta}>beta</span>
              </div>
              <p className={styles.footTagline}>
                ที่ฝากของของคนไทย — อยู่ในแอปที่พี่เปิดทุกวันอยู่แล้ว
              </p>
              <p className={`${styles.footHandwrite} ${styles.hand}`}>ฝากไว้กับหนูเก็บ เดี๋ยวหนูดูแลให้เองน้า</p>
            </div>
            <div>
              <h3 className={styles.footColTitle}>เมนู</h3>
              <div className={styles.footLinks}>
                <a href="#deposit" className={styles.footLink}>ฝากอะไรได้บ้าง</a>
                <a href="#try" className={styles.footLink}>ลองเล่น</a>
                <a href="#how" className={styles.footLink}>วิธีใช้</a>
                <a href="#free" className={styles.footLink}>พื้นที่ฟรี</a>
                <a href="#faq" className={styles.footLink}>คำถามพบบ่อย</a>
                <Link href="/dashboard" className={styles.footLink}>เปิดล็อคเกอร์</Link>
              </div>
            </div>
            <div>
              <h3 className={styles.footColTitle}>ติดตามหนูเก็บ</h3>
              <div className={styles.socialRow}>
                <a
                  href={LINE_ADD_FRIEND_URL}
                  className={styles.socialBtn}
                  aria-label="เพิ่มเพื่อนหนูเก็บใน LINE"
                >
                  <IcoChat size={19} />
                </a>
                <a
                  href={INSTAGRAM_URL}
                  className={styles.socialBtn}
                  aria-label="Instagram ของหนูเก็บ"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IcoInstagram size={19} />
                </a>
                <a
                  href={TIKTOK_URL}
                  className={styles.socialBtn}
                  aria-label="TikTok ของหนูเก็บ"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IcoTiktok size={18} />
                </a>
              </div>
              <p className={styles.footTagline} style={{ marginTop: 12 }}>
                LINE ID: {LINE_ID}
              </p>
            </div>
          </div>
          <div className={styles.footBase}>
            <span>© 2026 หนูเก็บ (nookeb) — สงวนลิขสิทธิ์</span>
            <span>หนูเก็บเป็นบริการอิสระ ไม่ใช่บริการอย่างเป็นทางการของ LINE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ============================================================
   Inline SVG icons — stroke สไตล์เดียวกับ components/icons.tsx
   (ห้ามใช้อีโมจิบนหน้าเว็บ · ห้ามวาดมาสคอตใหม่ — ใช้ artwork จริงเท่านั้น)
   ============================================================ */

interface IconProps {
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
}

function IcoCheck({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

function IcoCheckCircle({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 5-6" />
    </svg>
  );
}

function IcoPlus({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IcoArrowRight({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

function IcoChat({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3.5c-5 0-9 3.2-9 7.2 0 2.3 1.3 4.3 3.4 5.6l-.8 3.3c-.1.4.3.7.7.5l3.8-2.1c.6.1 1.2.2 1.9.2 5 0 9-3.2 9-7.2s-4-7.5-9-7.5Z" />
    </svg>
  );
}

function IcoCrown({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19.5 18a1.5 1.5 0 0 1-1.5 1.2H6A1.5 1.5 0 0 1 4.5 18L3 8.5Z" />
    </svg>
  );
}

function IcoStarFill({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5 14.9 8.6l6.6.8-4.9 4.5 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5-4.9-4.5 6.6-.8L12 2.5Z" />
    </svg>
  );
}

function IcoSparkle({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5c.9 4.8 2.7 6.6 7.5 7.5-4.8.9-6.6 2.7-7.5 7.5-.9-4.8-2.7-6.6-7.5-7.5 4.8-.9 6.6-2.7 7.5-7.5ZM19 15.5c.4 2.1 1.2 2.9 3.3 3.3-2.1.4-2.9 1.2-3.3 3.3-.4-2.1-1.2-2.9-3.3-3.3 2.1-.4 2.9-1.2 3.3-3.3Z" />
    </svg>
  );
}

function IcoLock({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
      <circle cx="12" cy="15.2" r="1.3" fill="currentColor" stroke="none" />
      <path d="M12 16.4v1.5" />
    </svg>
  );
}

function IcoUndo({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.5 9.5h6V3.6" />
      <path d="M4.6 15a8 8 0 1 0 1.3-7.2" />
    </svg>
  );
}

function IcoBellOff({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M13.9 20.5a2 2 0 0 1-3.8 0" />
      <path d="M6.4 6.6A6.2 6.2 0 0 0 5.8 9.3c0 5-2.3 6.9-2.3 6.9h13" />
      <path d="M18.2 13.5c-.3-1.1-.4-2.5-.4-4.2a6 6 0 0 0-8.7-5.4" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

function IcoTimer({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 10v3.8l2.6 2.2M9.5 2.5h5" />
    </svg>
  );
}

function IcoQr({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
      <path d="M14 14h2.8v2.8H14zM17.8 17.8h2.7v2.7h-2.7z" />
    </svg>
  );
}

function IcoFolder({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.5 7.5v11a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 1.5Z" />
    </svg>
  );
}

function IcoInstagram({ size = 19 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IcoTiktok({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.5 8.6a6.3 6.3 0 0 1-3.9-1.4V15a5.9 5.9 0 1 1-5.9-5.9c.3 0 .6 0 .9.1v3.1a2.9 2.9 0 1 0 2 2.7V2.5h3a3.9 3.9 0 0 0 3.9 3.9v2.2Z" />
    </svg>
  );
}

/* ---------- decorative (multi-color, aria-hidden ทั้งกลุ่มจาก parent) ---------- */

function IcoStarBig() {
  return (
    <svg width="46" height="46" viewBox="0 0 46 46" fill="none" aria-hidden>
      <path
        d="M23 4.5 28.6 16l12 1.6-8.8 8.4 2.2 12L23 32.3 12 38l2.2-12-8.8-8.4 12-1.6L23 4.5Z"
        fill="#d9a53f"
        stroke="#c08c2c"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IcoPin() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="7" r="5" fill="#b53a32" stroke="#8e2a24" strokeWidth="1.2" />
      <circle cx="8.3" cy="5.4" r="1.5" fill="#d4574d" />
      <path d="M10 12v6" stroke="#6b6b6b" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IcoFolderSticker() {
  return (
    <svg width="88" height="70" viewBox="0 0 88 70" fill="none" aria-hidden>
      <path
        d="M6 16a5 5 0 0 1 5-5h20l6 7h40a5 5 0 0 1 5 5v36a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5V16Z"
        fill="#eec95e"
        stroke="#d9a53f"
        strokeWidth="2"
      />
      <rect x="14" y="10" width="52" height="40" rx="3" fill="#fffdf9" stroke="#e8e4df" strokeWidth="1.5" />
      <path d="M20 20h34M20 27h26M20 34h30" stroke="#c9c2b8" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M6 28h76v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5V28Z"
        fill="#f4d778"
        stroke="#d9a53f"
        strokeWidth="2"
      />
    </svg>
  );
}

function IcoDoodleArrow() {
  return (
    <svg width="42" height="22" viewBox="0 0 42 22" fill="none" aria-hidden>
      <path
        d="M2 15C10 5 26 4 38 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="4 4"
      />
      <path d="m32 5 6.5 5-7.5 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function IcoReceiptPhoto() {
  return (
    <svg width="190" height="120" viewBox="0 0 190 120" aria-hidden>
      <rect width="190" height="120" fill="#f0ede8" />
      <rect x="52" y="10" width="86" height="116" rx="3" fill="#ffffff" stroke="#e8e4df" strokeWidth="1.5" />
      <path d="M64 26h62M64 38h48M64 50h56M64 62h40" stroke="#c9c2b8" strokeWidth="3" strokeLinecap="round" />
      <path d="M64 78h62" stroke="#e8e4df" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M64 92h30" stroke="#c9c2b8" strokeWidth="3" strokeLinecap="round" />
      <path d="M104 92h22" stroke="#b53a32" strokeWidth="4" strokeLinecap="round" />
      <circle cx="30" cy="96" r="14" fill="#eec95e" opacity="0.85" />
      <circle cx="163" cy="26" r="9" fill="#fdeaea" />
    </svg>
  );
}

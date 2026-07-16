import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Itim } from 'next/font/google';

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

const TITLE = 'หนูเก็บ (Nookeb) — ฝากไฟล์ใน LINE เก็บถาวรไม่หมดอายุ ฟรี 1 GB';
const DESCRIPTION =
  'ส่งรูปหรือไฟล์เข้าแชท LINE ให้หนูเก็บ เก็บเข้าล็อคเกอร์บนคลาวด์ถาวร ไม่มีวันหมดอายุ ' +
  'ค้นหาเจอแม้จำชื่อไฟล์ไม่ได้ สแกนเอกสารเป็น PDF แปลงรูปเป็น Word ไดอารี่ 365 วัน ' +
  'เริ่มฟรี 1 GB ไม่ต้องโหลดแอป ไม่ต้องสมัครสมาชิก';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'หนูเก็บ',
    'nookeb',
    'เก็บไฟล์ LINE',
    'ฝากไฟล์ออนไลน์',
    'ไฟล์หมดอายุ LINE',
    'สแกนเอกสารเป็น PDF ฟรี',
    'แปลงรูปเป็น Word',
    'ไดอารี่ 365 วัน',
    'คลังเก็บไฟล์ออนไลน์',
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
    images: [{ url: '/landing/og.jpg', width: 1200, height: 1360, alt: 'หนูเก็บ — ผู้ช่วยในการเก็บข้อมูล' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/landing/og.jpg'],
  },
};

/* ============================================================
   Content (ยึดตาราง "เคลมได้/ห้ามเคลม" ใน brand playbook ส่วนที่ 2)
   ============================================================ */

const MARQUEE_ITEMS = [
  'เก็บรูปและไฟล์ถาวร',
  'ไม่มีวันหมดอายุ',
  'สแกนเป็น PDF',
  'แปลงรูปเป็น Word',
  'ไดอารี่ 365 วัน',
  'ใช้กับแก๊งในกลุ่ม',
  'ค้นหาเจอเสมอ',
  'ฟรี 1 GB',
];

const FEATURES: {
  icon: React.ReactNode;
  tint: 'red' | 'teal' | 'pink' | 'gold';
  title: string;
  desc: string;
  chip: string;
  fine?: string;
}[] = [
  {
    icon: <IcoInbox />,
    tint: 'red',
    title: 'เก็บทุกอย่างจากแชท',
    desc: 'รูป เอกสาร วิดีโอ เสียง — แค่ส่งเข้าแชท หนูเก็บเก็บเข้าล็อคเกอร์ให้ทันที ไฟล์ละไม่เกิน 1 GB เก็บถาวร ไม่หมดอายุเหมือนไฟล์ในแชทไลน์',
    chip: 'แค่ส่งไฟล์เข้าแชท',
  },
  {
    icon: <IcoSearchImg />,
    tint: 'red',
    title: 'ค้นหาเจอแม้จำชื่อไฟล์ไม่ได้',
    desc: 'หนูอ่านตัวหนังสือในรูปให้อัตโนมัติ (ไทย + อังกฤษ) พิมพ์คำที่อยู่ในใบเสร็จหรือเอกสารลงช่องค้นหา ก็เจอรูปนั้นเลยน้า',
    chip: 'พิมพ์คำที่อยู่ในรูป',
  },
  {
    icon: <IcoUsers />,
    tint: 'teal',
    title: 'ใช้กับแก๊งในกลุ่ม',
    desc: 'เชิญหนูเก็บเข้ากลุ่มไลน์ ไฟล์ที่ทุกคนส่งหลังจากนั้นถูกเก็บเข้าพื้นที่กลางของกลุ่มอัตโนมัติ ตั้งทีมและจัดการสมาชิกผ่านแดชบอร์ดได้',
    chip: 'เชิญหนูเก็บเข้ากลุ่ม',
  },
  {
    icon: <IcoDocEdit />,
    tint: 'red',
    title: 'แปลงรูปเป็นไฟล์ Word',
    desc: 'ส่งรูปหรือ PDF (ไม่เกิน 10 MB) หนูอ่านเอกสารแล้วสร้างเป็นไฟล์ .docx ให้เอาไปแก้ต่อได้เลย — เอกสารตัวพิมพ์ชัด ๆ ได้ผลดีที่สุด',
    chip: '"หนูเก็บแปลงไฟล์"',
    fine: 'ใช้ในแชทส่วนตัวกับหนูเก็บ',
  },
  {
    icon: <IcoCalHeart />,
    tint: 'pink',
    title: 'ไดอารี่ 365 วัน',
    desc: 'ถ่ายรูปวันละรูปพร้อมเขียนแคปชั่น หนูเรียงเป็นตาราง 365 ช่อง สะสม streak วันติดต่อกัน เปิดย้อนดูความทรงจำได้ทั้งปี',
    chip: '"หนูเก็บไดอารี่"',
    fine: 'ใช้ในแชทส่วนตัวกับหนูเก็บ',
  },
  {
    icon: <IcoScan />,
    tint: 'gold',
    title: 'สแกนเอกสารเป็น PDF',
    desc: 'ถ่ายรูปเอกสารทีละหน้า พอครบพิมพ์ "เสร็จ" หนูรวมเป็น PDF ไฟล์เดียว ปรับภาพคมชัดเหมือนเครื่องสแกน เลือกได้ทั้งสีและขาวดำ',
    chip: '"หนูเก็บสแกนสี"',
    fine: 'ใช้ในแชทส่วนตัวกับหนูเก็บ',
  },
];

const GALLERY: { src: string; alt: string; cap: string }[] = [
  { src: '/landing/card-2.jpg', alt: 'การ์ดแนะนำหนูเก็บ ผู้ช่วยในการเก็บข้อมูล', cap: 'แนะนำตัวหน่อยน้า' },
  { src: '/landing/card-4.jpg', alt: 'การ์ดฟีเจอร์ รวมรูปเป็น PDF และสแกนเอกสาร', cap: 'รวมรูปเป็น PDF ได้น้า' },
  { src: '/landing/card-5.jpg', alt: 'การ์ดฟีเจอร์ ใช้หนูเก็บกับกลุ่มเพื่อน', cap: 'ชวนแก๊งมาเก็บด้วยกัน' },
  { src: '/landing/card-6.jpg', alt: 'การ์ดสติกเกอร์ไลน์ของหนูเก็บ', cap: 'มีสติกเกอร์ด้วยน้า' },
  { src: '/landing/card-1.jpg', alt: 'การ์ดแนะนำวิธีเรียกหนูเก็บ', cap: 'เรียกหนูว่า "หนูเก็บ"' },
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
    desc: 'หนูเก็บตอบเฉพาะตอนพี่ทักหรือส่งไฟล์มา ไม่มีโฆษณายิงใส่แชท — แชทของพี่คือพื้นที่ของพี่',
  },
  {
    icon: <IcoShield />,
    title: 'ล็อคเกอร์ที่มีหนูเฝ้า',
    desc: 'ไฟล์อยู่บนคลาวด์ระดับองค์กร แยกพื้นที่ของแต่ละบัญชีชัดเจน หนูเฝ้าให้ตลอดน้า',
  },
  {
    icon: <IcoTimer />,
    title: 'ลิงก์ดาวน์โหลดปลอดภัย',
    desc: 'ลิงก์ดาวน์โหลดเป็นลิงก์ชั่วคราว หมดอายุใน 1 ชั่วโมง ป้องกันไฟล์ถูกส่งต่อโดยไม่ตั้งใจ',
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: 'หนูเก็บฟรีจริงไหม? มีเก็บเงินทีหลังหรือเปล่า?',
    a: 'ตอนนี้ทุกฟีเจอร์ใช้ฟรี เริ่มต้นได้ 1 GB โดยไม่ต้องผูกบัตรหรือกรอกข้อมูลจ่ายเงินใด ๆ อยากได้พื้นที่เพิ่มก็ชวนเพื่อนมาใช้ด้วยกัน — ชวนครบ 5 คนได้ 4 GB ถาวร ยังไม่มีแพ็กเกจเสียเงินในระบบเลยน้า',
  },
  {
    q: 'ต้องโหลดแอปเพิ่มไหม?',
    a: 'ไม่ต้องน้า หนูเก็บอยู่ใน LINE ที่พี่ใช้อยู่ทุกวันแล้ว ส่วนการเปิดดูและจัดระเบียบไฟล์ทำผ่านเว็บเบราว์เซอร์ ล็อกอินด้วย LINE ได้เลย ไม่ต้องสมัครสมาชิกใหม่ ไม่ต้องจำรหัสผ่าน',
  },
  {
    q: 'เก็บไฟล์แบบไหนได้บ้าง ใหญ่สุดแค่ไหน?',
    a: 'รูปภาพ ไฟล์เอกสาร วิดีโอ และเสียงที่ส่งในแชท ขนาดไฟล์ละไม่เกิน 1 GB เก็บแล้วอยู่ถาวรในล็อคเกอร์ ไม่หมดอายุเหมือนไฟล์ในแชทไลน์',
  },
  {
    q: 'ไฟล์ที่ขึ้น "หมดอายุ" ในไลน์ไปแล้ว กู้คืนได้ไหม?',
    a: 'อันนี้หนูช่วยไม่ได้จริง ๆ น้า — ไฟล์ที่หมดอายุไปแล้ว ระบบไหนก็เปิดไม่ได้ วิธีที่ดีที่สุดคือเก็บก่อนหมดอายุ เห็นไฟล์สำคัญเมื่อไหร่ ฟอร์เวิร์ดมาให้หนูทันทีเลยน้า',
  },
  {
    q: 'ไฟล์ของฉันปลอดภัยแค่ไหน?',
    a: 'ไฟล์ถูกเก็บบนคลาวด์ระดับองค์กร แยกพื้นที่ของแต่ละบัญชีชัดเจน ลิงก์ดาวน์โหลดเป็นลิงก์ปลอดภัยแบบชั่วคราวที่หมดอายุใน 1 ชั่วโมง และหนูเก็บไม่เคยทักหาใครก่อน ไม่ส่งโฆษณาใส่แชทน้า',
  },
  {
    q: 'ใช้ในกลุ่มไลน์ได้ไหม?',
    a: 'ได้น้า เชิญหนูเก็บเข้ากลุ่ม แล้วไฟล์ที่สมาชิกส่งหลังจากนั้นจะถูกเก็บเข้าพื้นที่กลางของกลุ่มอัตโนมัติ (โหมดสแกน แปลงไฟล์ และไดอารี่ ใช้ในแชทส่วนตัวกับหนูเก็บ) ถ้าอยากให้เก็บแบบเงียบ ๆ พิมพ์ "หนูเก็บปิดแจ้งเตือน" ในกลุ่มได้เลย',
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
            <a href="#features" className={styles.navLink}>ฟีเจอร์</a>
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
                ล็อคเกอร์เก็บไฟล์ใน LINE — ฟรี ไม่ต้องโหลดแอป
              </p>
              <h1 className={styles.heroTitle}>
                <span className={styles.noWrap}>ส่งเข้าไลน์ปุ๊บ</span>{' '}
                <span className={styles.noWrap}>เก็บถาวรปั๊บ</span>
                <span className={`${styles.heroTitleAccent} ${styles.hand}`}>— หนูเก็บให้เองน้า</span>
              </h1>
              <p className={styles.heroSub}>
                เคยเปิดรูปในแชทแล้วเจอ &ldquo;ไฟล์หมดอายุ&rdquo; ไหม? แค่ส่งรูปหรือไฟล์เข้าแชทหนูเก็บ{' '}
                <strong>ทุกอย่างจะถูกเก็บเข้าล็อคเกอร์บนคลาวด์ทันที</strong> ไม่หมดอายุ ค้นหาเจอ
                เปิดดูได้ทุกที่
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
                        <span className={styles.fileHint}>อยู่ในล็อคเกอร์แล้ว · เก็บถาวร ไม่หมดอายุ</span>
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

        {/* ============ Features ============ */}
        <section id="features" className={styles.section} aria-labelledby="features-title">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  ฟีเจอร์ทั้งหมด
                </p>
                <h2 id="features-title" className={styles.sectionTitle}>หนูเก็บทำอะไรได้บ้างน้า</h2>
                <p className={styles.sectionSub}>
                  ครบทุกอย่างที่ &ldquo;ที่เก็บไฟล์ของคนไทย&rdquo; ควรมี — ใช้ผ่านแชทที่พี่เปิดอยู่ทุกวัน
                  ไม่ต้องเปลี่ยนพฤติกรรมอะไรเลย
                </p>
              </div>
            </Reveal>
            <div className={styles.featureGrid}>
              {FEATURES.map((f, i) => (
                <Reveal className={styles.reveal} delay={(i % 3) * 90} key={f.title}>
                  <article className={styles.featureCard}>
                    <div className={`${styles.featureIcon} ${f.tint !== 'red' ? styles[f.tint] : ''}`}>
                      {f.icon}
                    </div>
                    <h3 className={styles.featureTitle}>{f.title}</h3>
                    <p className={styles.featureDesc}>{f.desc}</p>
                    <span className={styles.cmdChip}>
                      <IcoChat size={13} />
                      {f.chip}
                    </span>
                    {f.fine ? <span className={styles.finePrint}>{f.fine}</span> : null}
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ Scrapbook gallery ============ */}
        <section className={`${styles.section} ${styles.sectionAlt}`} aria-label="บอร์ดภาพแนะนำหนูเก็บ">
          <div className={styles.wrap}>
            <Reveal className={styles.reveal}>
              <div className={styles.sectionHead}>
                <p className={`${styles.kicker} ${styles.hand}`}>
                  <IcoSparkle size={18} />
                  จากบอร์ดของหนูเก็บ
                </p>
                <h2 className={styles.sectionTitle}>แปะไว้ให้พี่ดูน้า</h2>
              </div>
            </Reveal>
            <Reveal className={styles.reveal} delay={120}>
              <div className={styles.gallery}>
                {GALLERY.map((g) => (
                  <figure className={styles.polaroid} key={g.src}>
                    <span className={styles.tape} aria-hidden="true" />
                    <Image src={g.src} alt={g.alt} width={204} height={204} className={styles.polaroidImg} />
                    <figcaption className={`${styles.polaroidCap} ${styles.hand}`}>{g.cap}</figcaption>
                  </figure>
                ))}
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
            <Reveal className={styles.reveal} delay={200}>
              <div className={styles.stepsCta}>
                <a href={LINE_ADD_FRIEND_URL} className={styles.btnPrimary}>
                  <IcoChat size={19} />
                  ลองส่งไฟล์แรกเลยน้า
                </a>
              </div>
            </Reveal>
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
                <div>
                  <p className={`${styles.freeKicker} ${styles.hand}`}>เริ่มต้นที่</p>
                  <p className={styles.freeBig}>
                    1 <span>GB</span>
                  </p>
                  <p className={styles.freeDesc}>
                    ไม่ต้องผูกบัตร ไม่มีค่ารายเดือน ตอนนี้ทุกฟีเจอร์ใช้ฟรีทั้งหมด
                    อยากได้พื้นที่เพิ่ม แค่ชวนเพื่อนมาใช้ด้วยกันน้า
                  </p>
                </div>
                <div>
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
                      ชวนสำเร็จ 3 · 5 คน พื้นที่รวมเป็น 2.5 · 4 GB ถาวร
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
        <section className={styles.section} aria-label="ความเป็นส่วนตัวและความปลอดภัย">
          <div className={styles.wrap}>
            <div className={styles.trustRow}>
              {TRUST.map((t, i) => (
                <Reveal className={styles.reveal} delay={i * 100} key={t.title}>
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
                      พร้อมให้หนูดูแลไฟล์ของพี่หรือยังน้า
                    </h2>
                    <p className={styles.ctaSub}>
                      เพิ่มเพื่อนแล้วลองส่งไฟล์แรกได้เลย — ฟรี ไม่ต้องโหลดแอป ไม่ต้องสมัครสมาชิก
                      เดี๋ยวหนูเก็บให้เองน้า
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
                        src="/landing/card-7.jpg"
                        alt="หนูเก็บชวนลองใช้งาน — ส่งรูปหรือเอกสารเข้ามา หนูเก็บช่วยจัดเก็บให้ทันที"
                        width={280}
                        height={280}
                      />
                      <figcaption className={`${styles.ctaPolaroidCap} ${styles.hand}`}>
                        ลองใช้งานเลยน้า
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
                ล็อคเกอร์เก็บไฟล์ของคนไทย — อยู่ในแอปที่พี่เปิดทุกวันอยู่แล้ว
              </p>
              <p className={`${styles.footHandwrite} ${styles.hand}`}>เก็บให้ ไม่ลืม ไม่หาย ไม่หมดอายุ</p>
            </div>
            <div>
              <h3 className={styles.footColTitle}>เมนู</h3>
              <div className={styles.footLinks}>
                <a href="#features" className={styles.footLink}>ฟีเจอร์</a>
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

function IcoInbox({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1Z" />
    </svg>
  );
}

function IcoSearchImg({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="13" height="12" rx="2" />
      <path d="m3 13 3.2-3.2L9.5 13" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="16.5" cy="15.5" r="4" />
      <path d="m19.5 18.5 2.5 2.5" />
    </svg>
  );
}

function IcoScan({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M6 12h12" />
    </svg>
  );
}

function IcoDocEdit({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="m10.5 16.5 5.5-5.5 1.5 1.5-5.5 5.5H10.5v-1.5Z" />
    </svg>
  );
}

function IcoCalHeart({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path
        d="M12 18.2s-2.8-1.9-2.8-3.6c0-1 .8-1.7 1.6-1.7.7 0 1.2.5 1.2.5s.5-.5 1.2-.5c.8 0 1.6.7 1.6 1.7 0 1.7-2.8 3.6-2.8 3.6Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function IcoUsers({ size = 24 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20v-1.5A5 5 0 0 1 7.5 13.5h3a5 5 0 0 1 5 5V20" />
      <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M21.5 20v-1.5a5 5 0 0 0-3.5-4.8" />
    </svg>
  );
}

function IcoShield({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 21.5s7.5-3.4 7.5-9.3V5.5L12 2.8 4.5 5.5v6.7c0 5.9 7.5 9.3 7.5 9.3Z" />
      <path d="m9 11.5 2.2 2.2 4-4.5" />
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
      <circle cx="10" cy="7" r="5" fill="#c0392b" stroke="#962d22" strokeWidth="1.2" />
      <circle cx="8.3" cy="5.4" r="1.5" fill="#e74c3c" />
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
      <path d="M104 92h22" stroke="#c0392b" strokeWidth="4" strokeLinecap="round" />
      <circle cx="30" cy="96" r="14" fill="#eec95e" opacity="0.85" />
      <circle cx="163" cy="26" r="9" fill="#fdeaea" />
    </svg>
  );
}

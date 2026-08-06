'use client';

import styles from './tasks.module.css';

/**
 * วิธีใช้ — the command reference that used to live only in the LINE chat card
 * (`buildTaskCommandHelpCard`). Everything here is a real handler in
 * `apps/api/src/routes/webhook/line.ts`; keep the two in sync if a command is
 * added or retired. No emoji — brand rule.
 */

const CHAT_COMMANDS: { cmd: string; where: string; what: string }[] = [
  {
    cmd: 'หนูเก็บเตือนงาน @คนรับ <งาน> ส่ง <วัน>',
    where: 'ในกลุ่ม',
    what: 'สั่งงานจากแชทได้เลย หนูจะสรุปเป็นการ์ดให้กดยืนยันก่อนสร้างจริง',
  },
  {
    cmd: 'หนูเก็บเตือนงาน',
    where: 'ในกลุ่ม / แชทส่วนตัว',
    what: 'พิมพ์เปล่าๆ ในกลุ่มจะได้การ์ดสอนใช้ ส่วนในแชทส่วนตัวจะเปิดฟอร์มสร้างงานส่วนตัว',
  },
  {
    cmd: 'พิมพ์ธรรมดาแล้ว @คนรับ',
    where: 'ในกลุ่ม',
    what: 'ไม่ต้องขึ้นต้นด้วยหนูเก็บก็ได้ ถ้าหนูเดาได้ว่าเป็นการสั่งงาน จะถามกลับให้ยืนยันน้า',
  },
  {
    cmd: 'หนูเก็บงานของฉัน',
    where: 'แชทส่วนตัว',
    what: 'ส่งลิงก์มาที่หน้านี้ให้เลย',
  },
  {
    cmd: 'หนูเก็บผูกทีม <เลข>',
    where: 'ในกลุ่ม',
    what: 'ผูกกลุ่ม LINE เข้ากับทีม เพื่อให้ไฟล์และงานอยู่ในคลังเดียวกัน',
  },
  {
    cmd: 'หนูเก็บคู่มือทีม',
    where: 'ทุกที่',
    what: 'การ์ดแนะนำการใช้งานทีมแบบเต็ม',
  },
];

const CARD_ACTIONS: { label: string; what: string }[] = [
  { label: 'รับทราบ', what: 'ผู้รับงานกดเพื่อบอกว่าเห็นแล้ว งานจะขยับเป็น "กำลังทำ" ทันที' },
  { label: 'เสร็จแล้ว', what: 'ปิดงานของตัวเอง พอทุกคนกดครบ ทั้งงานถึงจะนับว่าเสร็จ' },
  { label: 'ส่งงานกลับ', what: 'แนบไฟล์แล้วส่งให้คนสั่งงานตรวจ สถานะจะเป็น "รอตรวจ" ยังไม่นับว่าเสร็จ' },
  { label: 'รับงาน / ตีกลับ', what: 'คนสั่งงานเป็นคนตัดสิน ถ้าตีกลับต้องใส่เหตุผลด้วยทุกครั้ง' },
];

const PAGE_TIPS: { label: string; what: string }[] = [
  { label: 'กด 1–4', what: 'สลับแท็บสถานะในส่วน "งานของฉัน" ได้จากคีย์บอร์ด' },
  { label: 'กด /', what: 'กระโดดไปช่องค้นหาทันที' },
  { label: 'ดาวข้างงาน', what: 'ปักหมุดงานให้ลอยขึ้นบนสุดเสมอ (จำไว้ให้ข้ามวันด้วย)' },
  { label: 'ปุ่ม "..." บนการ์ด', what: 'ทำเสร็จ / เลื่อน deadline / ยกเลิกงาน ได้โดยไม่ต้องเปิดเข้าไป' },
  { label: 'ลากตัวการ์ตูน', what: 'ย้ายเพื่อนร่วมงานไปวางตรงไหนก็ได้ กดที่ตัวเพื่อกระโดดไปดูสรุปของคนนั้น' },
];

export default function HowToSection() {
  return (
    <>
      <section className={styles.howtoCard} aria-label="คำสั่งในแชท">
        <h2 className={styles.activityTitle}>สั่งงานจากแชท LINE</h2>
        <p className={styles.howtoLead}>
          ไม่ต้องเปิดเว็บก็สั่งงานได้ พิมพ์ในกลุ่มที่เชิญหนูเข้าไปแล้วได้เลยน้า
        </p>
        <ul className={styles.howtoList}>
          {CHAT_COMMANDS.map((c) => (
            <li key={c.cmd} className={styles.howtoRow}>
              <code className={styles.howtoCmd}>{c.cmd}</code>
              <span className={styles.howtoWhere}>{c.where}</span>
              <span className={styles.howtoWhat}>{c.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.howtoCard} aria-label="ปุ่มบนการ์ดงาน">
        <h2 className={styles.activityTitle}>ปุ่มบนการ์ดงานใน LINE</h2>
        <ul className={styles.howtoSimpleList}>
          {CARD_ACTIONS.map((a) => (
            <li key={a.label} className={styles.howtoSimpleRow}>
              <span className={styles.howtoChip}>{a.label}</span>
              <span className={styles.howtoWhat}>{a.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.howtoCard} aria-label="ทางลัดในหน้านี้">
        <h2 className={styles.activityTitle}>ทางลัดในหน้านี้</h2>
        <ul className={styles.howtoSimpleList}>
          {PAGE_TIPS.map((t) => (
            <li key={t.label} className={styles.howtoSimpleRow}>
              <span className={styles.howtoChip}>{t.label}</span>
              <span className={styles.howtoWhat}>{t.what}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

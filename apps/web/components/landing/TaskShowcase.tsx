import Image from 'next/image';
import Link from 'next/link';

import { LINE_ADD_FRIEND_URL } from '@/lib/site';
import s from './TaskShowcase.module.css';

/**
 * ระบบตามงาน — the flagship feature block on the landing page.
 *
 * STATIC ON PURPOSE. No 'use client', no timers, no state: the thread on the
 * right is a mockup, and a landing page should not ship JS to fake a chat that
 * the user can have for real one tap away. The section's entrance animation is
 * the page's existing <Reveal> wrapper.
 *
 * THE MOCKUP MUST STAY TRUTHFUL. Two rules, both learned from the page it
 * lives on:
 *
 * 1. The command in the outgoing bubble is the REAL syntax
 *    (`หนูเก็บเตือนงาน @คน <งาน> ส่ง <เมื่อไหร่>`, CLAUDE.md §6). A landing
 *    page that teaches a command the webhook does not parse is a support
 *    ticket generator — the whole point of showing the thread is that the
 *    reader can retype it verbatim.
 * 2. The two cards mirror the real Flex builders in
 *    apps/api/src/services/lineMessage.ts — `buildTaskCreatedFlex` (brand-red
 *    header · มอบหมายให้ body · ดูงาน + รับทราบ footer) and `buildReminderFlex`
 *    (the header colour IS the urgency band; #FF9800 is URGENCY_COLOR's real
 *    '1_day' value). If those builders change shape, this changes with them.
 *
 * REMINDER CLAIM: this block does say หนูเก็บ reminds you before a deadline.
 * That is accurate as of 2026-08-01 — TASK_NOTIFICATIONS_ENABLED is a
 * default-ON kill switch and scheduled reminders ship. It is deliberately the
 * ONE forward claim on this page; nothing here promises Google Sheets, a
 * configurable approval chain, or anything else the playbook's ตาราง 2.3 bars.
 *
 * No emoji anywhere — brand rule (CLAUDE.md §3 rule 13). Icons are inline SVG.
 */
export default function TaskShowcase() {
  return (
    <div className={s.grid}>
      {/* ---------- left: what it is ---------- */}
      <div className={s.copy}>
        <p className={s.kicker}>
          <IcoSparkle />
          ระบบตามงาน
        </p>
        <h2 id="tasks-title" className={s.title}>
          ตามงานได้ในแชท — ไม่ต้องเปิดแอปอื่น
        </h2>
        <p className={s.lead}>
          หนูเก็บเตือนงานถึงใจผ่าน LINE — <strong>แค่พิมพ์สร้างงาน หนูเก็บจัดการให้</strong>
        </p>
        <ul className={s.points}>
          <li>
            <IcoCheck />
            <span>พิมพ์สั่งงานในกลุ่มได้เลย หนูอ่านชื่อคนที่แท็กและกำหนดส่งให้เอง</span>
          </li>
          <li>
            <IcoCheck />
            <span>หนูโพสต์การ์ดงานเข้ากลุ่ม กดรับทราบ ส่งงาน หรือตีกลับได้ในแชทเลย</span>
          </li>
          <li>
            <IcoCheck />
            <span>ใกล้ถึงกำหนด หนูเตือนให้เอง แล้วเปิดห้องทีมดูได้ว่าใครทำถึงไหน</span>
          </li>
        </ul>
        <div className={s.ctas}>
          <a href={LINE_ADD_FRIEND_URL} className={s.btnPrimary}>
            <IcoChat />
            ลองสั่งงานในกลุ่ม
          </a>
          <Link href="/dashboard/tasks" className={s.btnSecondary}>
            เปิดหน้างานของฉัน
            <IcoArrowRight />
          </Link>
        </div>
      </div>

      {/* ---------- right: the thread ---------- */}
      <div className={s.stage} aria-hidden="true">
        <span className={s.badge}>
          <IcoBell />
          หนูเตือนให้เอง
        </span>

        <div className={s.phone}>
          <div className={s.head}>
            <Image src="/logo.png" alt="" width={34} height={34} className={s.avatar} />
            <div>
              <div className={s.name}>ทีมการตลาด</div>
              <div className={s.sub}>
                <span className={s.dot} />
                หนูเก็บอยู่ในกลุ่มนี้
              </div>
            </div>
          </div>

          <div className={s.body}>
            <span className={s.day}>วันนี้ 09:40</span>

            <p className={s.out}>หนูเก็บเตือนงาน @ปอนด์ สรุปวาระประชุม BOD ส่งพรุ่งนี้ 10 โมง</p>

            {/* buildTaskCreatedFlex */}
            <div className={s.flex}>
              <div className={s.flexHead}>
                <div className={s.flexType}>งานเดียว</div>
                <div className={s.flexTitle}>สรุปวาระประชุม BOD</div>
                <div className={s.flexDeadline}>กำหนดส่ง พรุ่งนี้ 10:00 น.</div>
              </div>
              <div className={s.flexBody}>
                <div className={s.flexLabel}>มอบหมายให้</div>
                <div className={s.flexItem}>สรุปวาระประชุม BOD</div>
                <div className={s.flexMeta}>ปอนด์ • พรุ่งนี้ 10:00 น.</div>
              </div>
              <div className={s.flexFoot}>
                <span className={s.flexBtn}>ดูงาน</span>
                <span className={s.flexBtnPrimary}>รับทราบ</span>
              </div>
            </div>

            {/* buildReminderFlex — '1_day' band */}
            <div className={s.remind}>
              <div className={s.remindHead}>
                <IcoBell />
                พรุ่งนี้ถึงกำหนดแล้ว
              </div>
              <div className={s.remindBody}>
                <div className={s.remindTitle}>สรุปวาระประชุม BOD</div>
                <div className={s.remindPending}>ยังไม่ส่ง: ปอนด์ • กำหนดส่ง 10:00 น.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- icons (stroke style shared with the page) ---------- */

function stroke(size: number) {
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

function IcoCheck() {
  return (
    <svg {...stroke(16)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

function IcoArrowRight() {
  return (
    <svg {...stroke(17)}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

function IcoBell() {
  return (
    <svg {...stroke(15)}>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" />
      <path d="M13.9 19.5a2 2 0 0 1-3.8 0" />
    </svg>
  );
}

function IcoChat() {
  return (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3.5c-5 0-9 3.2-9 7.2 0 2.3 1.3 4.3 3.4 5.6l-.8 3.3c-.1.4.3.7.7.5l3.8-2.1c.6.1 1.2.2 1.9.2 5 0 9-3.2 9-7.2s-4-7.5-9-7.5Z" />
    </svg>
  );
}

function IcoSparkle() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5c.9 4.8 2.7 6.6 7.5 7.5-4.8.9-6.6 2.7-7.5 7.5-.9-4.8-2.7-6.6-7.5-7.5 4.8-.9 6.6-2.7 7.5-7.5ZM19 15.5c.4 2.1 1.2 2.9 3.3 3.3-2.1.4-2.9 1.2-3.3 3.3-.4-2.1-1.2-2.9-3.3-3.3 2.1-.4 2.9-1.2 3.3-3.3Z" />
    </svg>
  );
}

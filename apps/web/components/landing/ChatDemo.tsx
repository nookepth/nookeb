'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import s from './ChatDemo.module.css';

/**
 * Interactive "ลองคุยกับหนูเก็บ" demo for the landing page.
 *
 * Why it exists: the biggest activation blocker is that a new user does not
 * know there is anything to TYPE — they add the OA and stop. The playbook's KPI
 * note says the number that decides everything is activation (ส่งไฟล์แรก), so
 * the page has to teach the command vocabulary before the user leaves. Tapping
 * a command here shows หนูเก็บ's real reply: the cheapest possible rehearsal of
 * the first message they will ever send.
 *
 * Copy rules (brand playbook ส่วนที่ 2–4):
 * - Every reply is the system's own voice: แทนตัว "หนู" · เรียก "พี่" ·
 *   ลงท้าย "น้า". Limits quoted are the real ones (ภาคผนวก A).
 * - NO emoji — the landing page is emoji-free by house rule even though the
 *   in-chat bot voice allows up to two.
 * - Nothing here may claim a feature the system does not have (ตาราง 2.3):
 *   no auto reminders, no Google Sheets, no PIN reset.
 */

interface Scene {
  /** Text shown in the outgoing bubble — what the user would actually type. */
  cmd: string;
  /** Short chip label (the command itself is too long for a chip). */
  chip: string;
  /** Optional attachment bubble rendered before the bot replies. */
  sent?: string;
  /** หนูเก็บ's reply bubbles, in order. */
  replies: string[];
  /** Optional result card under the replies. */
  card?: { title: string; name: string; hint: string };
  /** Where the feature works — fine print under the thread. */
  note: string;
}

/** Non-empty by construction — the tuple type is what lets `SCENES[0]` be the
    safe fallback under noUncheckedIndexedAccess without a non-null assertion. */
const SCENES: [Scene, ...Scene[]] = [
  {
    cmd: 'ส่งรูปเข้าแชทได้เลย ไม่ต้องพิมพ์อะไร',
    chip: 'ส่งไฟล์',
    sent: 'ใบเสร็จค่าเทอม.jpg',
    replies: ['แป๊บนึงน้าพี่ เดี๋ยวเก็บเข้าล็อคเกอร์ให้เลยน้า'],
    card: {
      title: 'หนูเก็บให้แล้วน้า',
      name: 'ใบเสร็จค่าเทอม.jpg',
      hint: 'อยู่ในล็อคเกอร์แล้ว · ไม่หมดอายุเหมือนไฟล์ในแชท',
    },
    note: 'ส่งรูป ไฟล์เอกสาร วิดีโอ หรือเสียงเข้ามาได้เลย ไฟล์ละไม่เกิน 1 GB',
  },
  {
    cmd: 'หนูเก็บสแกนสี',
    chip: 'สแกนเอกสาร',
    replies: [
      'เปิดโหมดสแกนให้แล้วน้า',
      'ส่งรูปเอกสารมาทีละหน้าได้เลยน้า ครบแล้วพิมพ์ "เสร็จ" หนูจะรวมเป็น PDF ไฟล์เดียวให้น้า',
    ],
    note: 'ใช้ในแชทส่วนตัวกับหนูเก็บ · เลือกได้ทั้ง "หนูเก็บสแกนสี" และ "หนูเก็บสแกนขาวดำ"',
  },
  {
    cmd: 'หนูเก็บแปลงไฟล์',
    chip: 'แปลงเป็น Word',
    replies: [
      'ส่งรูปหรือไฟล์ PDF มา 1 ไฟล์ได้เลยน้า ไม่เกิน 10 MB',
      'เดี๋ยวหนูอ่านให้ แล้วทำเป็นไฟล์ Word ที่พี่เอาไปแก้ต่อได้เลยน้า',
    ],
    note: 'ใช้ในแชทส่วนตัวกับหนูเก็บ · เอกสารตัวพิมพ์ชัด ๆ ได้ผลดีที่สุดน้า',
  },
  {
    cmd: 'หนูเก็บรวมไฟล์',
    chip: 'รวม PDF',
    replies: [
      'เปิดโหมดรวมไฟล์ให้แล้วน้า',
      'ส่งไฟล์ PDF มาทีละไฟล์ได้เลยน้า ครบแล้วพิมพ์ "เสร็จ" หนูจะรวมเป็นไฟล์เดียวให้น้า',
    ],
    note: 'ใช้ในแชทส่วนตัวกับหนูเก็บ · รับเฉพาะไฟล์ .pdf ไฟล์ละไม่เกิน 20 MB สูงสุด 20 ไฟล์ เรียงตามลำดับที่ส่ง',
  },
  {
    cmd: 'หนูเก็บไดอารี่',
    chip: 'ไดอารี่',
    replies: [
      'วันนี้พี่อยากบันทึกอะไรน้า พิมพ์แคปชั่นก่อนก็ได้',
      'แล้วส่งรูปมา 1 รูป หนูจะเก็บเป็นไดอารี่ของวันนี้ให้น้า',
    ],
    note: 'ใช้ในแชทส่วนตัวกับหนูเก็บ · วันละ 1 รูป เปิดดูตาราง 365 ช่องและ streak ได้บนเว็บ',
  },
  {
    cmd: 'หนูเก็บสร้างงาน',
    chip: 'ตามงาน',
    replies: [
      'เปิดหน้าสร้างงานให้แล้วน้า',
      'เลือกแบบงาน ใส่กำหนดส่ง แล้วมอบหมายให้ใครในกลุ่มก็ได้ หนูจะโพสต์การ์ดประกาศงานเข้ากลุ่มให้น้า',
    ],
    note: 'พิมพ์ในกลุ่มได้การ์ดห้องทีม · พิมพ์ในแชทส่วนตัวได้ "งานส่วนตัว" ที่มีแค่พี่คนเดียว',
  },
];

/** Delay between bubbles, so the thread feels typed rather than pasted. */
const STEP_MS = 520;

export default function ChatDemo() {
  const [active, setActive] = useState(0);
  /** How many bubbles of the active scene are revealed. Starts fully open so
      the server-rendered markup is never a half-empty thread. */
  const [shown, setShown] = useState(99);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const play = useCallback(
    (index: number) => {
      clearTimers();
      setActive(index);

      const next = SCENES[index] ?? SCENES[0];
      const total = (next.sent ? 1 : 0) + next.replies.length + (next.card ? 1 : 0);

      // Reduced motion: show the whole thread at once. The staged reveal is
      // decoration — never the only way to read the copy.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setShown(total);
        return;
      }

      setShown(0);
      for (let i = 1; i <= total; i += 1) {
        timers.current.push(window.setTimeout(() => setShown(i), i * STEP_MS));
      }
    },
    [clearTimers],
  );

  // Play the first scene on mount, and never leave a timer behind.
  useEffect(() => {
    play(0);
    return clearTimers;
  }, [play, clearTimers]);

  const scene = SCENES[active] ?? SCENES[0];
  // Bubble ordinals so `shown` can gate each one without inline arithmetic.
  let seq = 0;
  const sentSeq = scene.sent ? (seq += 1) : 0;
  const replySeqs: number[] = scene.replies.map(() => (seq += 1));
  const cardSeq = scene.card ? (seq += 1) : 0;

  return (
    <div className={s.demo}>
      <div className={s.chips} role="tablist" aria-label="คำสั่งของหนูเก็บ">
        {SCENES.map((sc, i) => (
          <button
            key={sc.cmd}
            type="button"
            role="tab"
            id={`nookeb-demo-tab-${i}`}
            aria-selected={i === active}
            aria-controls="nookeb-demo-thread"
            tabIndex={i === active ? 0 : -1}
            className={s.chip}
            data-active={i === active || undefined}
            onClick={() => play(i)}
            onKeyDown={(e) => {
              // Roving tabindex: arrows move between commands, as tabs should.
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const next =
                (i + (e.key === 'ArrowRight' ? 1 : SCENES.length - 1)) % SCENES.length;
              play(next);
              document.getElementById(`nookeb-demo-tab-${next}`)?.focus();
            }}
          >
            {sc.chip}
          </button>
        ))}
      </div>

      <div className={s.phone}>
        <div className={s.head}>
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed 34px avatar; next/image adds no value and this file stays dependency-free */}
          <img src="/logo.png" alt="" width={34} height={34} className={s.avatar} />
          <div>
            <div className={s.name}>หนูเก็บ</div>
            <div className={s.status}>
              <span className={s.dot} />
              ผู้ดูแลล็อคเกอร์ · พร้อมเก็บเสมอ
            </div>
          </div>
        </div>

        <div
          className={s.body}
          id="nookeb-demo-thread"
          role="tabpanel"
          aria-labelledby={`nookeb-demo-tab-${active}`}
        >
          <div className={s.out}>
            <span className={s.outBubble}>{scene.cmd}</span>
          </div>

          {scene.sent ? (
            <div className={s.out} data-on={shown >= sentSeq || undefined}>
              <span className={s.file}>
                <IcoImage />
                {scene.sent}
              </span>
            </div>
          ) : null}

          {scene.replies.map((r, i) => (
            <p key={r} className={s.in} data-on={shown >= (replySeqs[i] ?? 0) || undefined}>
              {r}
            </p>
          ))}

          {scene.card ? (
            <div className={s.card} data-on={shown >= cardSeq || undefined}>
              <div className={s.cardHead}>
                <IcoCheckCircle />
                {scene.card.title}
              </div>
              <div className={s.cardRow}>
                <IcoFolder />
                <span className={s.cardName}>
                  {scene.card.name}
                  <span className={s.cardHint}>{scene.card.hint}</span>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* aria-live: the staged reveal is visual only, so the note (which carries
          the "personal chat only" caveat) has to arrive as one whole update. */}
      <p className={s.note} aria-live="polite">
        {scene.note}
      </p>
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

function IcoImage() {
  return (
    <svg {...stroke(15)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m3 16 4.5-4.5L14 18" />
      <circle cx="8.5" cy="9" r="1.4" />
    </svg>
  );
}

function IcoCheckCircle() {
  return (
    <svg {...stroke(18)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 5-6" />
    </svg>
  );
}

function IcoFolder() {
  return (
    <svg {...stroke(19)}>
      <path d="M3.5 7.5v11a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 1.5Z" />
    </svg>
  );
}

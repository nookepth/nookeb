'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../tasks.module.css';
import { initLiff, queryGroupId } from '../../../../lib/liff';
import { emptyDraft, saveDraft, type TaskDraft } from '../../../../lib/taskDraft';
import { IconClipboard, IconListChecks, IconRepeat } from '../components';

const TYPES: { type: TaskDraft['type']; icon: ReactNode; title: string; sub: string }[] = [
  {
    type: 'single',
    icon: <IconClipboard />,
    title: 'งานเดียว มอบหลายคน',
    sub: 'deadline เดียว หลายคนรับผิดชอบร่วมกัน',
  },
  {
    type: 'multi',
    icon: <IconListChecks />,
    title: 'แยกงานเป็นรายการ',
    sub: 'แต่ละข้อเลือกคนรับผิดชอบและ deadline ต่างกันได้',
  },
  {
    type: 'recurring',
    icon: <IconRepeat />,
    title: 'งานประจำ',
    sub: 'ตั้งครั้งเดียว เตือนอัตโนมัติทุกรอบ',
  },
];

export default function CreateTaskPage() {
  const router = useRouter();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'no-group' | 'error'>('loading');

  useEffect(() => {
    initLiff()
      .then((liffState) => {
        // Fail fast on a broken session HERE rather than letting the user pick a
        // type and hit a wall of 401s on the next (member) step.
        if (!liffState.authed) {
          setState('error');
          return;
        }
        // initLiff() is memoized — its groupId may predate the client-side
        // redirect that put ?groupId= on THIS URL, so re-read the query here.
        const resolved = liffState.groupId ?? queryGroupId();
        if (!resolved) {
          setState('no-group');
          return;
        }
        setGroupId(resolved);
        setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  const pick = (type: TaskDraft['type']) => {
    if (!groupId) return;
    const draft = emptyDraft(type);
    draft.groupId = groupId;
    saveDraft(draft);
    router.push(`/liff/tasks/create/${type}/members`);
  };

  return (
    <main className={styles.page} style={{ paddingBottom: 24 }}>
      <header className={styles.header}>
        <h1 className={styles.headerTitle}>สร้างงานแบบไหนดี~</h1>
        <p className={styles.headerSub}>เลือกรูปแบบงานที่จะมอบหมายในกลุ่ม</p>
      </header>

      {state === 'loading' && (
        <div className={styles.cardList}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.card} style={{ height: 84 }}>
              <div className={styles.skeletonBar} style={{ width: '55%', marginBottom: 10 }} />
              <div className={styles.skeletonBar} style={{ width: '80%' }} />
            </div>
          ))}
        </div>
      )}

      {state === 'no-group' && (
        <div className={styles.errorBox}>
          หน้านี้ต้องเปิดจากในกลุ่ม LINE น้า — กดปุ่มสร้างงานจากเมนูในกลุ่มที่ต้องการมอบหมายงาน
        </div>
      )}

      {state === 'error' && (
        <div className={styles.errorBox}>เชื่อมต่อ LINE ไม่สำเร็จ ลองปิดแล้วเปิดใหม่อีกทีน้า</div>
      )}

      {state === 'ready' && (
        <div className={styles.cardList}>
          {TYPES.map((t) => (
            <button key={t.type} type="button" className={styles.typeCard} onClick={() => pick(t.type)}>
              <span className={styles.typeIcon} aria-hidden>
                {t.icon}
              </span>
              <span>
                <span className={styles.typeTitle} style={{ display: 'block' }}>
                  {t.title}
                </span>
                <span className={styles.typeSub} style={{ display: 'block' }}>
                  {t.sub}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

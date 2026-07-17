'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../tasks.module.css';
import { initLiff, queryGroupId } from '../../../../../lib/liff';
import { emptyDraft, saveDraft, type TaskDraft } from '../../../../../lib/taskDraft';

/**
 * Deep-link entry for the create flow: the "สร้างงาน" Flex card links to
 * https://liff.line.me/{liffId}/create/{type}, which LIFF resolves under the
 * endpoint (/liff/tasks) to THIS route. The type is already chosen by the card
 * tap, so this page just seeds the draft (same as the picker's pick()) and
 * forwards straight into the members step. Unknown type → back to the picker.
 */

const TASK_TYPES: readonly TaskDraft['type'][] = ['single', 'multi', 'recurring'];

function isTaskType(value: string): value is TaskDraft['type'] {
  return (TASK_TYPES as readonly string[]).includes(value);
}

export default function CreateTypeEntryPage({ params }: { params: { type: string } }) {
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'no-group' | 'error'>('loading');

  useEffect(() => {
    if (!isTaskType(params.type)) {
      router.replace('/liff/tasks/create');
      return;
    }
    const type = params.type;
    initLiff()
      .then((liffState) => {
        // initLiff() is memoized — its groupId may predate the client-side
        // redirect that put ?groupId= on THIS URL, so re-read the query here.
        const groupId = liffState.groupId ?? queryGroupId();
        if (!groupId) {
          setState('no-group');
          return;
        }
        const draft = emptyDraft(type);
        draft.groupId = groupId;
        saveDraft(draft);
        router.replace(`/liff/tasks/create/${type}/members`);
      })
      .catch(() => setState('error'));
  }, [params.type, router]);

  return (
    <main className={styles.page} style={{ paddingBottom: 24 }}>
      <header className={styles.header}>
        <h1 className={styles.headerTitle}>กำลังเปิดหน้าสร้างงาน~</h1>
        <p className={styles.headerSub}>รอแป๊บนึงน้า</p>
      </header>

      {state === 'loading' && (
        <div className={styles.cardList}>
          {[0, 1].map((i) => (
            <div key={i} className={styles.card} style={{ height: 84 }}>
              <div className={styles.skeletonBar} style={{ width: '55%', marginBottom: 10 }} />
              <div className={styles.skeletonBar} style={{ width: '80%' }} />
            </div>
          ))}
        </div>
      )}

      {state === 'no-group' && (
        <div className={styles.errorBox}>
          หน้านี้ต้องเปิดจากในกลุ่ม LINE น้า — กดปุ่มสร้างงานจากการ์ดในกลุ่มที่ต้องการมอบหมายงาน
        </div>
      )}

      {state === 'error' && (
        <div className={styles.errorBox}>เชื่อมต่อ LINE ไม่สำเร็จ ลองปิดแล้วเปิดใหม่อีกทีน้า</div>
      )}
    </main>
  );
}

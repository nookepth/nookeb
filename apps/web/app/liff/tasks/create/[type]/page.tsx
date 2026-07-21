'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../tasks.module.css';
import {
  initLiff,
  reconnectLiff,
  resetLiff,
  resolveGroupId,
  type LiffState,
} from '../../../../../lib/liff';
import { emptyDraft, resolveScope, saveDraft, type TaskDraft } from '../../../../../lib/taskDraft';
import { StateNotice } from '../../components';

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
  const [state, setState] = useState<'loading' | 'no-group' | 'unauth' | 'error'>('loading');

  const applyState = useCallback(
    (liffState: LiffState) => {
      if (!isTaskType(params.type)) return; // effect below already redirected
      // Fail fast on a broken session HERE (this deep-link entry otherwise
      // silently forwards to the members step, which then dead-ends on the
      // "ต้องเชื่อมต่อ LINE" notice with no context).
      if (!liffState.authed) {
        setState(liffState.authError === 'network' ? 'error' : 'unauth');
        return;
      }
      // งานส่วนตัว (?scope=personal from the DM card): no group, and the member
      // step is skipped entirely — a personal task is self-assigned.
      if (resolveScope() === 'personal') {
        saveDraft(emptyDraft(params.type as TaskDraft['type'], 'personal'));
        router.replace(`/liff/tasks/create/${params.type}/detail`);
        return;
      }
      // initLiff() is memoized — its groupId may predate the client-side
      // redirect that put ?groupId= on THIS URL, so re-resolve here (URL query
      // + the sessionStorage belt that survives a login redirect).
      const groupId = liffState.groupId ?? resolveGroupId();
      if (!groupId) {
        setState('no-group');
        return;
      }
      const draft = emptyDraft(params.type as TaskDraft['type']);
      draft.groupId = groupId;
      saveDraft(draft);
      router.replace(`/liff/tasks/create/${params.type}/members`);
    },
    [params.type, router],
  );

  useEffect(() => {
    if (!isTaskType(params.type)) {
      router.replace('/liff/tasks/create');
      return;
    }
    initLiff()
      .then(applyState)
      .catch(() => setState('error'));
  }, [params.type, router, applyState]);

  const retry = () => {
    setState('loading');
    resetLiff()
      .then(applyState)
      .catch(() => setState('error'));
  };

  const reconnect = () => {
    setState('loading');
    reconnectLiff()
      .then(applyState)
      .catch(() => setState('error'));
  };

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

      {state === 'unauth' && (
        <StateNotice
          title="ต้องเชื่อมต่อ LINE ก่อนน้า"
          body="กด 'เชื่อมต่ออีกครั้ง' เพื่อเข้าสู่ระบบด้วย LINE ใหม่น้า ถ้ายังไม่ได้ ลองปิดหน้านี้แล้วเปิดใหม่จากการ์ดในกลุ่มอีกที"
          onRetry={reconnect}
          retryLabel="เชื่อมต่ออีกครั้ง"
        />
      )}
      {state === 'error' && (
        <StateNotice
          title="เชื่อมต่อ LINE ไม่สำเร็จน้า"
          body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      )}
    </main>
  );
}

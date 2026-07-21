'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../tasks.module.css';
import { trackEvent } from '../../../../lib/track';
import {
  initLiff,
  reconnectLiff,
  resetLiff,
  resolveGroupId,
  type LiffState,
} from '../../../../lib/liff';
import {
  emptyDraft,
  resolveScope,
  saveDraft,
  type TaskDraft,
  type TaskScope,
} from '../../../../lib/taskDraft';
import { IconClipboard, IconListChecks, IconRepeat, StateNotice } from '../components';
import { TASK_NOTIFICATIONS_ENABLED } from '@nookeb/shared';

// Don't promise auto-reminders while notification pushes are soft-disabled.
const RECURRING_SUB = TASK_NOTIFICATIONS_ENABLED
  ? 'ตั้งครั้งเดียว เตือนอัตโนมัติทุกรอบ'
  : 'ตั้งครั้งเดียว วนซ้ำให้ทุกรอบ';

const GROUP_TYPES: { type: TaskDraft['type']; icon: ReactNode; title: string; sub: string }[] = [
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
  { type: 'recurring', icon: <IconRepeat />, title: 'งานประจำ', sub: RECURRING_SUB },
];

// งานส่วนตัวไม่มีใครให้มอบหมาย — copy drops every assignee mention.
const PERSONAL_TYPES: typeof GROUP_TYPES = [
  { type: 'single', icon: <IconClipboard />, title: 'งานเดียว', sub: 'งานหนึ่งชิ้น กำหนดส่งเดียว' },
  {
    type: 'multi',
    icon: <IconListChecks />,
    title: 'แยกงานเป็นรายการ',
    sub: 'แต่ละข้อตั้ง deadline ต่างกันได้',
  },
  { type: 'recurring', icon: <IconRepeat />, title: 'งานประจำ', sub: RECURRING_SUB },
];

export default function CreateTaskPage() {
  const router = useRouter();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [scope, setScope] = useState<TaskScope>('group');
  const [state, setState] = useState<'loading' | 'ready' | 'no-group' | 'unauth' | 'error'>(
    'loading',
  );

  const applyState = useCallback((liffState: LiffState) => {
    // Fail fast on a broken session HERE rather than letting the user pick a
    // type and hit a wall of 401s on the next (member) step. A rejected/absent
    // token gets the reconnect notice; a transient failure the generic retry.
    if (!liffState.authed) {
      setState(liffState.authError === 'network' ? 'error' : 'unauth');
      return;
    }
    // งานส่วนตัว (?scope=personal from the DM card): no group is involved at
    // all, so the no-group guard below must not run.
    if (resolveScope() === 'personal') {
      setScope('personal');
      setGroupId(null);
      setState('ready');
      return;
    }
    // initLiff() is memoized — its groupId may predate the client-side
    // redirect that put ?groupId= on THIS URL, so re-resolve here (URL query
    // + the sessionStorage belt that survives a login redirect).
    const resolved = liffState.groupId ?? resolveGroupId();
    if (!resolved) {
      setState('no-group');
      return;
    }
    setGroupId(resolved);
    setState('ready');
  }, []);

  useEffect(() => {
    initLiff()
      .then(applyState)
      .catch(() => setState('error'));
  }, [applyState]);

  // Funnel top: fire once when the create flow is usable (valid session+group),
  // so an abandoned create (start without submit) is measurable.
  const startedRef = useRef(false);
  useEffect(() => {
    if (state === 'ready' && !startedRef.current) {
      startedRef.current = true;
      trackEvent('task_create_start');
    }
  }, [state]);

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

  const pick = (type: TaskDraft['type']) => {
    if (scope === 'group' && !groupId) return;
    const draft = emptyDraft(type, scope);
    draft.groupId = scope === 'personal' ? null : groupId;
    saveDraft(draft);
    // Personal tasks are self-assigned — the member step has nothing to pick.
    router.push(
      scope === 'personal'
        ? `/liff/tasks/create/${type}/detail`
        : `/liff/tasks/create/${type}/members`,
    );
  };

  return (
    <main className={styles.page} style={{ paddingBottom: 24 }}>
      <header className={styles.header}>
        <h1 className={styles.headerTitle}>สร้างงานแบบไหนดี~</h1>
        <p className={styles.headerSub}>
          {scope === 'personal' ? 'เลือกรูปแบบงานส่วนตัวของพี่' : 'เลือกรูปแบบงานที่จะมอบหมายในกลุ่ม'}
        </p>
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

      {state === 'unauth' && (
        <StateNotice
          title="ต้องเชื่อมต่อ LINE ก่อนน้า"
          body="กด 'เชื่อมต่ออีกครั้ง' เพื่อเข้าสู่ระบบด้วย LINE ใหม่น้า ถ้ายังไม่ได้ ลองปิดหน้านี้แล้วเปิดใหม่จากปุ่มในห้องแชทกลุ่มอีกที"
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

      {state === 'ready' && (
        <div className={styles.cardList}>
          {(scope === 'personal' ? PERSONAL_TYPES : GROUP_TYPES).map((t) => (
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

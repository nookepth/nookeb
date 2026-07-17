'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../../tasks.module.css';
import { apiFetch, initLiff, resetLiff, type LiffState } from '../../../../../../lib/liff';
import {
  loadDraft,
  saveDraft,
  type DraftMember,
  type TaskDraft,
} from '../../../../../../lib/taskDraft';
import {
  Avatar,
  IconCheck,
  IconClose,
  IconSearch,
  ListSkeleton,
  MemberRow,
  StateNotice,
} from '../../../components';

/**
 * Assignee picker. The roster needs NO /register step: the API auto-enrolls
 * the opener, syncs the group's members from LINE at fetch time (verified OA),
 * and the webhook adds anyone who chats in the group. Failure states are
 * distinguished (session expired / not in group / empty / network) so the user
 * always gets an explanation + a retry, never a dead-end error line.
 */

type PageState = 'loading' | 'ready' | 'empty' | 'not-registered' | 'unauth' | 'error';

export default function MembersPage({ params }: { params: { type: string } }) {
  const router = useRouter();
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [selected, setSelected] = useState<DraftMember[]>([]);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<PageState>('loading');

  // Map an unestablished session to the right notice: a rejected/absent token
  // is a real "sign in from the group again" case; a transient connect failure
  // gets the generic retry instead of a misleading "session expired".
  const applyAuthError = useCallback((s: LiffState): boolean => {
    if (s.authed) return true;
    setState(s.authError === 'network' ? 'error' : 'unauth');
    return false;
  }, []);

  const fetchMembers = useCallback(async (groupId: string): Promise<void> => {
    setState('loading');
    // Belt-and-braces self-register (capability model). The GET below also
    // auto-enrolls via LINE's membership check, so a failure here is fine.
    await apiFetch(`/api-proxy/groups/${encodeURIComponent(groupId)}/register`, {
      method: 'POST',
    }).catch(() => {});
    const res = await apiFetch(`/api-proxy/groups/${encodeURIComponent(groupId)}/members`).catch(
      () => null,
    );
    if (!res) {
      setState('error');
      return;
    }
    if (res.status === 401) {
      // apiFetch already tried to re-auth once — a lingering 401 means the
      // session genuinely can't be established from here.
      setState('unauth');
      return;
    }
    if (res.status === 403) {
      setState('not-registered');
      return;
    }
    if (!res.ok) {
      setState('error');
      return;
    }
    const body = (await res.json()) as { members: DraftMember[] };
    setMembers(body.members);
    setState(body.members.length === 0 ? 'empty' : 'ready');
  }, []);

  useEffect(() => {
    const stored = loadDraft();
    if (!stored?.groupId) {
      // Draft lost (LIFF reopened cold on this URL) — restart the flow.
      router.replace('/liff/tasks/create');
      return;
    }
    setDraft(stored);
    setSelected(stored.selected);
    initLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchMembers(stored.groupId!);
      })
      .catch(() => setState('error'));
  }, [router, fetchMembers, applyAuthError]);

  // Retry re-establishes the session first (resetLiff), so a transient auth
  // failure recovers instead of dead-ending — the old retry re-ran only the
  // members fetch and could never clear a missing cookie.
  const retry = () => {
    if (!draft?.groupId) return;
    setState('loading');
    resetLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchMembers(draft.groupId!);
      })
      .catch(() => setState('error'));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => (m.displayName ?? '').toLowerCase().includes(q));
  }, [members, search]);

  const isSelected = (m: DraftMember) => selected.some((s) => s.lineUid === m.lineUid);

  const toggle = (m: DraftMember) => {
    setSelected((prev) =>
      prev.some((s) => s.lineUid === m.lineUid)
        ? prev.filter((s) => s.lineUid !== m.lineUid)
        : [...prev, m],
    );
  };

  const allSelected = members.length > 0 && selected.length === members.length;
  const toggleAll = () => setSelected(allSelected ? [] : [...members]);

  const next = () => {
    if (!draft || selected.length === 0) return;
    const updated: TaskDraft = { ...draft, selected };
    saveDraft(updated);
    router.push(`/liff/tasks/create/${params.type}/detail`);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <h1 className={styles.headerTitle}>มอบหมายให้ใครบ้าง</h1>
          <button type="button" className={styles.ghostBtn} onClick={retry}>
            รีเฟรช
          </button>
        </div>
        <p className={styles.headerSub}>แตะชื่อเพื่อเลือก เลือกได้หลายคน</p>
      </header>

      {(state === 'ready' || state === 'loading') && (
        <div className={styles.searchBar}>
          <span className={styles.searchIcon}>
            <IconSearch />
          </span>
          <input
            className={styles.searchInput}
            placeholder="ค้นหาชื่อ..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {state === 'loading' && <ListSkeleton rows={6} />}

      {state === 'empty' && (
        <StateNotice
          title="ยังไม่มีรายชื่อสมาชิกเลยน้า"
          body="ให้เพื่อนๆ ส่งข้อความอะไรก็ได้ในกลุ่ม LINE สักครั้ง หนูเก็บจะจำชื่อไว้ให้เอง แล้วค่อยกดลองใหม่น้า"
          onRetry={retry}
        />
      )}
      {state === 'not-registered' && (
        <StateNotice
          title="ยังไม่เห็นเราในกลุ่มนี้เลยน้า"
          body="ลองส่งข้อความอะไรก็ได้ในกลุ่มสักครั้ง แล้วกดลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      )}
      {state === 'unauth' && (
        <StateNotice
          title="ต้องเชื่อมต่อ LINE ก่อนน้า"
          body="กด 'เชื่อมต่ออีกครั้ง' เพื่อเข้าสู่ระบบด้วย LINE ใหม่น้า ถ้ายังไม่ได้ ลองปิดหน้านี้แล้วเปิดใหม่จากปุ่มในห้องแชทกลุ่มอีกที"
          onRetry={retry}
          retryLabel="เชื่อมต่ออีกครั้ง"
        />
      )}
      {state === 'error' && (
        <StateNotice
          title="โหลดรายชื่อไม่สำเร็จน้า"
          body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      )}

      {state === 'ready' && (
        <div className={styles.memberList}>
          <button
            type="button"
            className={`${styles.memberRow} ${allSelected ? styles.memberRowSelected : ''}`}
            aria-pressed={allSelected}
            onClick={toggleAll}
          >
            <span className={styles.selectAllLabel}>
              เลือกทั้งหมด <span className={styles.selectAllCount}>({members.length} คน)</span>
            </span>
            <span className={`${styles.checkmark} ${allSelected ? styles.checkmarkOn : ''}`}>
              <IconCheck />
            </span>
          </button>
          {filtered.map((m) => (
            <MemberRow key={m.lineUid} member={m} selected={isSelected(m)} onToggle={() => toggle(m)} />
          ))}
          {filtered.length === 0 && (
            <div className={styles.emptyState}>
              <p className={styles.emptyText}>ไม่เจอชื่อนี้เลยน้า ลองพิมพ์คำอื่นดู</p>
            </div>
          )}
        </div>
      )}

      <div className={styles.stickyFooter}>
        <p
          className={`${styles.footerCount} ${selected.length > 0 ? styles.footerCountActive : ''}`}
        >
          {selected.length > 0 ? `เลือกแล้ว ${selected.length} คน` : 'ยังไม่ได้เลือกใครเลย'}
        </p>
        {selected.length > 0 && (
          <div className={styles.selectedStrip}>
            {selected.map((m) => (
              <div key={m.lineUid} className={styles.selectedChip}>
                <Avatar member={m} size={40} />
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => toggle(m)}
                  aria-label={`เอา ${m.displayName ?? 'สมาชิก'} ออก`}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={selected.length === 0}
          onClick={next}
        >
          ต่อไป
        </button>
      </div>
    </main>
  );
}

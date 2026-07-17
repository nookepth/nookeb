'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../../tasks.module.css';
import { initLiff } from '../../../../../../lib/liff';
import {
  loadDraft,
  saveDraft,
  type DraftMember,
  type TaskDraft,
} from '../../../../../../lib/taskDraft';
import { Avatar, EmptyRoster, ListSkeleton, MemberRow } from '../../../components';

type PageState = 'loading' | 'ready' | 'empty' | 'not-registered' | 'error';

export default function MembersPage({ params }: { params: { type: string } }) {
  const router = useRouter();
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [selected, setSelected] = useState<DraftMember[]>([]);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<PageState>('loading');

  const fetchMembers = useCallback(async (groupId: string): Promise<void> => {
    setState('loading');
    // Self-register the opener first so the creator is always on the roster
    // (their teammates register by typing /register in the group).
    await fetch(`/api-proxy/groups/${encodeURIComponent(groupId)}/register`, {
      method: 'POST',
    }).catch(() => {});
    const res = await fetch(`/api-proxy/groups/${encodeURIComponent(groupId)}/members`);
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
      .then(() => fetchMembers(stored.groupId!))
      .catch(() => setState('error'));
  }, [router, fetchMembers]);

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
          <h1 className={styles.headerTitle}>มอบหมายให้ใครบ้าง~?</h1>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => draft?.groupId && void fetchMembers(draft.groupId)}
          >
            รีเฟรช
          </button>
        </div>
        <p className={styles.headerSub}>เลือกได้หลายคน จากสมาชิกที่ลงทะเบียนแล้ว</p>
      </header>

      {state !== 'not-registered' && state !== 'empty' && (
        <div className={styles.searchBar}>
          <span aria-hidden>🔍</span>
          <input
            className={styles.searchInput}
            placeholder="ค้นหาชื่อ..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {state === 'loading' && <ListSkeleton rows={6} />}
      {state === 'empty' && <EmptyRoster />}
      {state === 'not-registered' && <EmptyRoster />}
      {state === 'error' && (
        <div className={styles.errorBox}>โหลดรายชื่อไม่สำเร็จ ลองกดรีเฟรชอีกทีน้า</div>
      )}

      {state === 'ready' && (
        <div className={styles.memberList}>
          <button type="button" className={styles.memberRow} onClick={toggleAll}>
            <div className={`${styles.avatar} ${styles.avatarAll}`}>All</div>
            <span className={styles.memberName}>ทุกคน ({members.length})</span>
            <span className={`${styles.checkmark} ${allSelected ? styles.checkmarkOn : ''}`}>✓</span>
          </button>
          {filtered.map((m) => (
            <MemberRow key={m.lineUid} member={m} selected={isSelected(m)} onToggle={() => toggle(m)} />
          ))}
          {filtered.length === 0 && (
            <div className={styles.emptyState}>
              <p className={styles.emptyText}>ไม่เจอชื่อนี้เลยน้า</p>
            </div>
          )}
        </div>
      )}

      <div className={styles.stickyFooter}>
        {selected.length > 0 && (
          <div className={styles.selectedStrip}>
            {selected.map((m) => (
              <div key={m.lineUid} className={styles.selectedChip}>
                <Avatar member={m} size={36} />
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => toggle(m)}
                  aria-label={`เอา ${m.displayName ?? 'สมาชิก'} ออก`}
                >
                  ×
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
          ต่อไป ({selected.length}) →
        </button>
      </div>
    </main>
  );
}

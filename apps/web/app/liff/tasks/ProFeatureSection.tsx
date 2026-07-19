'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import { apiFetch } from '../../../lib/liff';
import { trackEvent } from '../../../lib/track';
import { ProLockModal } from '../../../components/ProLockModal';
import { IconBell, IconLock, IconMic } from './components';
import styles from './tasks.module.css';

/**
 * "ฟีเจอร์พิเศษ (Pro)" fake-door section for the ระบบตามงาน task pages — shown on
 * the create-detail flow (below the assignees, above submit) and on the task
 * view. Two unbuilt Pro features are surfaced as locked rows; tapping one opens
 * the shared <ProLockModal> and "แจ้งเตือนฉัน" records deduped interest via the
 * authenticated POST /pro-interest (migration 040). This is a demand test — no
 * Pro feature exists and there is no billing.
 *
 * Brand voice: หนู refers to itself, addresses the user as พี่, and ends with
 * น้า; it only ever promises "เร็ว ๆ นี้", never a firm date and never "free".
 */

// Keep in sync with the CHECK in migration 040 and TASK_FEATURE_IDS in the API.
export type TaskProFeatureId = 'task_auto_reminder' | 'task_voice_command';

const FEATURES: { id: TaskProFeatureId; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'task_auto_reminder', label: 'เตือนงานอัตโนมัติ', Icon: IconBell },
  { id: 'task_voice_command', label: 'สั่งงานด้วยเสียง', Icon: IconMic },
];

const isTaskProFeatureId = (v: string): v is TaskProFeatureId =>
  v === 'task_auto_reminder' || v === 'task_voice_command';

export function ProFeatureSection() {
  const [open, setOpen] = useState<TaskProFeatureId | null>(null);
  const [notified, setNotified] = useState<Set<TaskProFeatureId>>(new Set());
  const [busy, setBusy] = useState(false);

  // Restore the "จะแจ้งเตือนน้า" state across reloads from the deduped record.
  useEffect(() => {
    let alive = true;
    void apiFetch('/api-proxy/pro-interest')
      .then((res) => (res.ok ? (res.json() as Promise<{ features?: string[] }>) : null))
      .then((body) => {
        if (!alive || !body?.features) return;
        setNotified(new Set(body.features.filter(isTaskProFeatureId)));
      })
      .catch(() => {
        /* best-effort — the rows just start un-notified */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Open the lock modal for a feature and record the impression (funnel top).
  const openFeature = useCallback((id: TaskProFeatureId) => {
    setOpen(id);
    trackEvent('pro_interest_view', { feature_id: id });
  }, []);

  // Dismiss without notifying counts as a dismiss; closing after a successful
  // "แจ้งเตือนฉัน" does not (the click was already recorded).
  const dismiss = useCallback(
    (id: TaskProFeatureId | null) => {
      if (id && !notified.has(id)) trackEvent('pro_interest_dismiss', { feature_id: id });
      setOpen(null);
    },
    [notified],
  );

  const notify = useCallback(async (id: TaskProFeatureId) => {
    trackEvent('pro_interest_click', { feature_id: id });
    setBusy(true);
    try {
      await apiFetch('/api-proxy/pro-interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: id }),
      }).catch(() => {
        /* a lost demand-test tap is not worth an error — show the happy path */
      });
    } finally {
      setBusy(false);
    }
    // Optimistic: the ✓ shows regardless of the POST result (dedupe is server-side).
    setNotified((prev) => new Set(prev).add(id));
  }, []);

  return (
    <section className={styles.proSection}>
      <p className={styles.proSectionLabel}>ฟีเจอร์พิเศษ (Pro)</p>
      <div className={styles.proRows}>
        {FEATURES.map(({ id, label, Icon }) => (
          <button key={id} type="button" className={styles.proRow} onClick={() => openFeature(id)}>
            <span className={styles.proRowIcon} aria-hidden>
              <Icon size={20} />
            </span>
            <span className={styles.proRowLabel}>{label}</span>
            {notified.has(id) && <span className={styles.proDone}>จะแจ้งเตือนน้า</span>}
            <span className={styles.proBadge}>
              <span className={styles.proLock} aria-hidden>
                <IconLock size={11} />
              </span>
              Pro
            </span>
          </button>
        ))}
      </div>

      <ProLockModal
        open={open !== null}
        accent="var(--brand)"
        title="ฟีเจอร์นี้อยู่ในแผน Pro"
        subtitle="เร็ว ๆ นี้น้า — กดไว้ เดี๋ยวหนูมาบอกพี่เป็นคนแรกเลย"
        ctaLabel="แจ้งเตือนฉัน"
        notified={open !== null && notified.has(open)}
        notifiedLabel="เดี๋ยวหนูรีบมาบอกพี่เลยน้า"
        busy={busy}
        onNotify={() => {
          if (open) void notify(open);
        }}
        onDismiss={() => dismiss(open)}
      />
    </section>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  REMINDER_GROUP_LABEL,
  REMINDER_GROUP_ORDER,
  REMINDER_INTERVAL_OPTIONS,
  type ReminderGroup,
  type ReminderIntervalOption,
} from '@/lib/taskDraft';
import { fireAt, formatWhen, lockHintFor, PLAN_LABEL } from '@/lib/reminderFormat';
import styles from './ReminderPicker.module.css';

/**
 * The reminder option list, in a container that changes shape with the viewport.
 *
 * WHY A SHEET AND NOT A CHIP GRID. The picker used to render every option as an
 * always-visible chip. That reads fine at five options and falls apart at
 * thirteen: on a 360px LIFF webview the grid became five rows of cramped
 * buttons sitting between the deadline field and the description field, so the
 * form's actual shape was lost. Collapsing it to ONE row that states the current
 * selection, and moving the choosing into a sheet, gives the list all the room
 * it needs and gives the form back its rhythm.
 *
 * ONE COMPONENT, TWO PRESENTATIONS, chosen by VIEWPORT rather than by app: at
 * ≤640px it is a bottom sheet (thumb-reachable, the LINE in-app browser's native
 * idiom), above that a centred modal. Keying off the app instead would give the
 * dashboard a desktop modal on a phone, which is the wrong control for the same
 * user. The difference is entirely in CSS — see ReminderPicker.module.css —
 * so the list, the plan cap and the preview are literally the same code on both.
 *
 * SELECTION COMMITS LIVE, and "เสร็จแล้ว" only closes. A local draft committed
 * on confirm would mean the field and the sheet can disagree about what is
 * selected while both are on screen, and it would make a stray backdrop tap
 * silently discard ticks. One owner for the state, no half-committed window.
 *
 * Rendered through a PORTAL so it is never clipped by an ancestor's overflow —
 * on the dashboard this sheet opens from inside CreatePersonalTaskModal, whose
 * .modal is `overflow-y: auto`. React still propagates events through the React
 * tree, so that modal's stopPropagation keeps a click inside this sheet from
 * reaching its overlay's onClose.
 */

export interface ReminderSheetProps {
  open: boolean;
  onClose: () => void;
  /** Ticked lead times, in minutes before the deadline. */
  value: number[];
  onChange: (next: number[]) => void;
  maxSelectable: number;
  plan?: string | null;
  deadline?: string | null;
  title: string;
}

export default function ReminderSheet({
  open,
  onClose,
  value,
  onChange,
  maxSelectable,
  plan,
  deadline,
  title,
}: ReminderSheetProps) {
  const [mounted, setMounted] = useState(false);
  const [lockHint, setLockHint] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Portals need a DOM target, which does not exist during SSR. Both callers are
  // client components, but the dashboard page is still server-rendered first.
  useEffect(() => setMounted(true), []);

  // Esc closes, and the page behind stops scrolling while the sheet is up —
  // otherwise a scroll gesture that overshoots the list drags the form instead.
  // JS-pinned rather than a CSS `body:has(...)` rule, matching FilePreviewModal
  // (a `:has` rule fires for every overlay in the app, including ones that want
  // the page to keep scrolling).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    // Focus the panel so Esc and the screen reader both land somewhere sensible.
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // A fresh open should not still be showing the upgrade line from last time.
  useEffect(() => {
    if (open) setLockHint(null);
  }, [open]);

  const atLimit = value.length >= maxSelectable;
  const planLabel = plan ? (PLAN_LABEL[plan] ?? plan) : null;

  /**
   * Fire times for EVERY row, not just the ticked ones — the point of the sheet
   * is that you can see "1 วัน" would land on 5 ส.ค. 18:00 BEFORE committing to
   * it. Recomputed per open/deadline change; thirteen Date constructions is
   * nothing, and caching it would only risk showing a stale "เลยเวลาแล้ว".
   */
  const whenByMinutes = useMemo(() => {
    const map = new Map<number, { when: Date; past: boolean }>();
    const deadlineMs = deadline ? new Date(deadline).getTime() : NaN;
    if (!Number.isFinite(deadlineMs)) return map;
    const now = Date.now();
    for (const opt of REMINDER_INTERVAL_OPTIONS) {
      const at = fireAt(deadline!, opt.minutes);
      map.set(opt.minutes, { when: at, past: at.getTime() <= now });
    }
    return map;
  }, [deadline, open]);

  const grouped = useMemo(() => {
    const byGroup = new Map<ReminderGroup, ReminderIntervalOption[]>();
    for (const opt of REMINDER_INTERVAL_OPTIONS) {
      const list = byGroup.get(opt.group) ?? [];
      list.push(opt);
      byGroup.set(opt.group, list);
    }
    return REMINDER_GROUP_ORDER.map((g) => ({ group: g, options: byGroup.get(g) ?? [] })).filter(
      (s) => s.options.length > 0,
    );
  }, []);

  const toggle = (opt: ReminderIntervalOption) => {
    const on = value.includes(opt.minutes);
    if (on) {
      setLockHint(null);
      onChange(value.filter((m) => m !== opt.minutes));
      return;
    }
    // At the cap a row stays TAPPABLE and answers with the reason. This control
    // lives mostly in the LINE in-app browser, where a hover tooltip has no
    // trigger, and an inert button that explains nothing is the worst of the
    // available options. (Behaviour carried over verbatim from the chip grid.)
    if (atLimit) {
      setLockHint(lockHintFor({ plan, maxSelectable, selectedCount: value.length }));
      return;
    }
    setLockHint(null);
    onChange([...value, opt.minutes]);
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div className={styles.sheetOverlay} onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className={styles.sheetPanel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.sheetGrabber} aria-hidden />

        <div className={styles.sheetHead}>
          <div>
            <h3 className={styles.sheetTitle}>{title}</h3>
            <p className={styles.sheetSub}>
              {value.length}/{maxSelectable} เลือกแล้ว
              {planLabel ? <span className={styles.planTag}>{planLabel}</span> : null}
            </p>
          </div>
          <button
            type="button"
            className={styles.sheetClose}
            onClick={onClose}
            aria-label="ปิด"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {lockHint && (
          <p className={styles.lockHint} role="status">
            {lockHint}
          </p>
        )}

        <div className={styles.sheetList} role="group" aria-label={title}>
          {grouped.map(({ group, options }) => (
            <section key={group} className={styles.sheetGroup}>
              <h4 className={styles.sheetGroupLabel}>{REMINDER_GROUP_LABEL[group]}</h4>
              {options.map((opt) => {
                const on = value.includes(opt.minutes);
                const locked = !on && atLimit;
                const fire = whenByMinutes.get(opt.minutes);
                return (
                  <button
                    key={opt.minutes}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={locked}
                    aria-label={`${opt.spoken}${fire ? ` — ${formatWhen(fire.when)}` : ''}`}
                    className={[
                      styles.row,
                      on ? styles.rowOn : '',
                      locked ? styles.rowLocked : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => toggle(opt)}
                  >
                    <span className={styles.rowBox} aria-hidden>
                      {on && (
                        <svg viewBox="0 0 16 16" width="12" height="12">
                          <path
                            d="M3 8.5l3.2 3.2L13 5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                      {locked && (
                        <svg viewBox="0 0 16 16" width="10" height="10">
                          <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" fill="currentColor" />
                          <path
                            d="M5.5 7V5a2.5 2.5 0 015 0v2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </span>

                    <span className={styles.rowLabel}>{opt.label}</span>

                    {/* The live preview, per row. Without a usable deadline
                        (งานประจำ has none yet) there is no date to name, and the
                        row label already carries the lead time — so nothing is
                        printed rather than a guessed one. */}
                    {fire && (
                      <span
                        className={[styles.rowWhen, fire.past ? styles.rowWhenPast : '']
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {formatWhen(fire.when)}
                        {fire.past && <span className={styles.rowPastTag}>เลยเวลาแล้ว</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        <div className={styles.sheetFoot}>
          <button type="button" className={styles.sheetDone} onClick={onClose}>
            เสร็จแล้ว
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

'use client';

import { useMemo, useState } from 'react';
import { maxRemindersForPlan } from '@/lib/taskDraft';
import { buildPreview, formatWhen, PLAN_LABEL, summarize } from '@/lib/reminderFormat';
import ReminderSheet from './ReminderSheet';
import styles from './ReminderPicker.module.css';

/**
 * §4b reminder lead-time picker — the ONE control shared by the LIFF create flow
 * (/liff/tasks/create/[type]/detail) and the dashboard's สร้างงานส่วนตัว modal.
 *
 * WHY IT REPLACED A NUMBER STEPPER. The original field asked "จำนวนการแจ้งเตือน
 * (ครั้ง)" and explained what a number meant in a caption underneath, so the
 * control could not be read at a glance: "2" tells you nothing. Here the lead
 * time IS the control — you tick "1 วัน" because you want to be reminded a day
 * before — and the preview names the real date and time each tick will fire at.
 *
 * WHY IT IS NOW A FIELD + SHEET, NOT A CHIP GRID. The chip build showed all five
 * options at once, which stopped working when migration 055 took the list to
 * thirteen: on a 360px LIFF webview that is five rows of cramped buttons wedged
 * into the middle of the form. So the control collapses to one row that STATES
 * the current selection ("3 ช่วง · 1 ว., 3 ชม., เลย 1 ชม.") and opens a
 * scrollable, grouped list on tap. The interaction is borrowed from the iOS
 * Calendar alert field; the multi-select, the plan counter and the per-row date
 * preview are ours, because a task reminder is a set, not a single choice.
 *
 * The full preview list stays OUTSIDE the sheet, under the field: it is the
 * answer to "what did I just agree to", and it must be legible while the rest of
 * the form is being filled in, not only while the sheet is open.
 *
 * Shared rather than duplicated on purpose: the two forms had drifted into two
 * copies of the same stepper, and a plan limit rendered two different ways is a
 * support ticket waiting to happen.
 *
 * The API remains the enforcer. `maxSelectable` here only decides what looks
 * tickable; POST /tasks re-validates every selection against the caller's real
 * plan and answers 403 REMINDER_INTERVAL_LIMIT, which both callers surface.
 */

export interface ReminderPickerProps {
  /**
   * Ticked lead times, in MINUTES before the deadline (-60 = one hour after).
   * Was HOURS before migration 055 — loadDraft normalises an old draft, and the
   * API normalises an old row; nothing here needs to know about that.
   */
  value: number[];
  onChange: (next: number[]) => void;
  /**
   * The viewer's plan, straight from the profile. Undefined/null (profile fetch
   * failed) falls back to the ceiling — see maxRemindersForPlan.
   */
  plan?: string | null;
  /**
   * The deadline currently in the form (datetime-local or ISO). Drives the "หนู
   * จะเตือน …" preview; without it the picker still works and simply describes
   * the lead times instead of naming dates.
   */
  deadline?: string | null;
  disabled?: boolean;
  /**
   * Extra line under the picker — used by the LIFF flow to say that automatic
   * reminders are currently switched off but the selection is still stored.
   */
  notice?: string | null;
  /** Rendered as the section's <label> and as the sheet's title. */
  label?: string;
}

export default function ReminderPicker({
  value,
  onChange,
  plan,
  deadline,
  disabled = false,
  notice = null,
  label = 'เตือนก่อนถึงกำหนด',
}: ReminderPickerProps) {
  const maxSelectable = maxRemindersForPlan(plan);
  const planLabel = plan ? (PLAN_LABEL[plan] ?? plan) : null;
  const [open, setOpen] = useState(false);

  const preview = useMemo(() => buildPreview(value, deadline), [value, deadline]);
  const summary = summarize(value);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.counter} aria-live="polite">
          {value.length}/{maxSelectable}
          {planLabel ? <span className={styles.planTag}>{planLabel}</span> : null}
        </span>
      </div>

      {/* The collapsed field. A button, not a div with a handler: it has to be
          reachable by keyboard on the dashboard and announce its own state. */}
      <button
        type="button"
        className={styles.field}
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} — ${summary || 'ยังไม่ได้เลือก'}`}
      >
        <span className={styles.fieldBody}>
          <span className={summary ? styles.fieldValue : styles.fieldPlaceholder}>
            {summary || 'ยังไม่ได้เลือก — หนูจะไม่เตือนน้า'}
          </span>
        </span>
        <svg
          className={styles.fieldChevron}
          viewBox="0 0 16 16"
          width="15"
          height="15"
          aria-hidden
        >
          <path
            d="M6 3.5L10.5 8L6 12.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* What the user just chose, in words and real dates, so nothing has to be
          inferred from a number. A shot whose moment has already passed is
          flagged rather than hidden — the scheduler silently skips it, and a
          creator who ticked "3 วัน" for a deadline two days out must not be left
          believing a reminder is coming. */}
      {preview.length > 0 && (
        <ul className={styles.preview}>
          {preview.map(({ opt, when, past }) => (
            <li key={opt.minutes} className={past ? styles.previewPast : undefined}>
              <span className={styles.dot} aria-hidden />
              <span className={styles.previewWhen}>{when ? formatWhen(when) : opt.spoken}</span>
              {when && <span className={styles.previewLead}>({opt.spoken})</span>}
              {past && <span className={styles.previewFlag}>เลยเวลาแล้ว หนูจะข้ามรอบนี้</span>}
            </li>
          ))}
        </ul>
      )}

      {notice && <p className={styles.notice}>{notice}</p>}

      <ReminderSheet
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        onChange={onChange}
        maxSelectable={maxSelectable}
        plan={plan}
        deadline={deadline}
        title={label}
      />
    </div>
  );
}

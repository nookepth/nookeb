'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { getPlans, type PlanSummaryDto } from '@/lib/api';
import {
  daysUntilReset,
  getCapacityMessage,
  getQuotaMessage,
  quotaUpgradeLines,
} from '@/lib/quota-errors';
import styles from './UpgradeModal.module.css';

/**
 * The ONE plan-gate / quota card the dashboard shows.
 *
 * Extracted from the Export Excel gate (dashboard/tasks/ExportUpgradeModal.tsx),
 * which was the only place that got this right: it explained the gate, listed
 * what upgrading buys, and offered a real CTA. Everywhere else answered a 403 or
 * a 429 with a line of red text — sometimes the raw machine code. One frame for
 * all of them means a user meets the same card whichever door they walked into.
 *
 * Deliberately NOT ProLockModal: that one is a FAKE DOOR (its CTA records demand
 * for a feature that does not exist yet). Everything routed through here is
 * built and purchasable, so the CTA is a real link to /dashboard/plans.
 *
 * Brand rule: no emoji — every glyph is inline SVG.
 */

/* ---------------------------------------------------------------------------
   Glyphs
   --------------------------------------------------------------------------- */

/** Default plan-gate icon: the padlocked sheet from the export modal. */
export function LockedSheetGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <path
        d="M11 6.5h16.5L37 16v25.5H11z"
        fill="#fff"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M27 6.5V16h10" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path
        d="M16.5 22.5h15M16.5 28h15M16.5 33.5h7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.45"
      />
      <circle cx="34" cy="34" r="10.5" fill="currentColor" />
      <rect x="29.6" y="33.4" width="8.8" height="6.4" rx="1.6" fill="#fff" />
      <path
        d="M31.6 33.4v-1.7a2.4 2.4 0 0 1 4.8 0v1.7"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Quota icon: a calendar with a refresh arc. Deliberately NOT a padlock — a
 * full monthly quota is not a locked feature, it comes back on the 1st, and a
 * padlock would tell the user the opposite.
 */
export function QuotaResetGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect
        x="7"
        y="10"
        width="34"
        height="31"
        rx="4"
        fill="#fff"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path d="M7 18.5h34" stroke="currentColor" strokeWidth="2.4" />
      <path d="M16 6.5V13M32 6.5V13" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path
        d="M30.5 30.5a6.5 6.5 0 1 1-1.9-4.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M29.2 21.4v4.9h-4.9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   The modal
   --------------------------------------------------------------------------- */

export interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  /** Defaults to the padlocked sheet (plan) or the calendar (quota). */
  icon?: ReactNode;
  /** Pill above the title, e.g. "ต้องใช้แพลน หนูเก็บแปลงร่าง ขึ้นไป". */
  badgeText?: string;
  title: string;
  subtitle?: string;
  /** Checklist of what upgrading actually buys. */
  features?: string[];
  /** Extra fact under the subtitle, e.g. "รีเซตอีก 9 วัน". */
  note?: string;
  ctaLabel?: string;
  ctaHref?: string;
  dismissLabel?: string;
  /**
   * 'plan' = the tier can't reach this feature (brand red, padlock).
   * 'quota' = the month's allowance is spent (amber, calendar) — waiting works.
   */
  variant?: 'plan' | 'quota';
}

export function UpgradeModal({
  open,
  onClose,
  icon,
  badgeText,
  title,
  subtitle,
  features,
  note,
  ctaLabel = 'ดูแพลนทั้งหมด',
  ctaHref = '/dashboard/plans',
  dismissLabel = 'ไว้ก่อนน้า',
  variant = 'plan',
}: UpgradeModalProps) {
  // Escape closes it too — the backdrop is not reachable from a keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="upgrade-modal-title"
      onClick={onClose}
    >
      {/* stop the backdrop's dismiss from firing on clicks inside the panel */}
      <div
        className={`${styles.modal} ${variant === 'quota' ? styles.quota : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.icon}>
          {icon ?? (variant === 'quota' ? <QuotaResetGlyph /> : <LockedSheetGlyph />)}
        </div>

        {badgeText && <span className={styles.tag}>{badgeText}</span>}
        <h2 id="upgrade-modal-title" className={styles.title}>
          {title}
        </h2>
        {subtitle && <p className={styles.text}>{subtitle}</p>}
        {note && <span className={styles.note}>{note}</span>}

        {features && features.length > 0 && (
          <ul className={styles.perks}>
            {features.map((perk) => (
              <li key={perk} className={styles.perk}>
                <span className={styles.perkIcon}>
                  <CheckGlyph />
                </span>
                {perk}
              </li>
            ))}
          </ul>
        )}

        <div className={styles.actions}>
          <a className={styles.primary} href={ctaHref}>
            {ctaLabel}
          </a>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default UpgradeModal;

/* ---------------------------------------------------------------------------
   Quota / capacity variants
   --------------------------------------------------------------------------- */

/**
 * The public price list, fetched once the card is actually on screen.
 *
 * GET /plans needs no session and is the only honest source for "what you'd
 * get" — the limits live in apps/api/src/config/plans.ts and nothing in the web
 * app may hard-code one. Best-effort: a failure drops the checklist and keeps
 * the card, because the reason the user is looking at it is not the checklist.
 */
function usePlanList(enabled: boolean): PlanSummaryDto[] | null {
  const [plans, setPlans] = useState<PlanSummaryDto[] | null>(null);
  useEffect(() => {
    if (!enabled || plans) return;
    let cancelled = false;
    void getPlans()
      .then((res) => {
        if (!cancelled) setPlans(res.plans);
      })
      .catch(() => {
        /* checklist is decoration */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, plans]);
  return plans;
}

export interface QuotaExceededModalProps {
  open: boolean;
  onClose: () => void;
  /** `user_quotas.feature` key, e.g. 'gift_boxes' — names the limit in the copy. */
  feature?: string;
  /** The server's reset instant (429 body / GET /plans/me/quotas). */
  resetAt?: string | null;
  /** Override the derived copy when a caller knows better. */
  title?: string;
  subtitle?: string;
  /** Override the derived checklist (skips the /plans fetch). */
  features?: string[];
}

/**
 * "โควต้าเดือนนี้เต็มแล้วน้า" — the 429 half of the pair.
 *
 * Fetches GET /plans itself (public, no session) so the "what you'd get"
 * numbers come from config/plans.ts rather than from a literal in a component.
 * The fetch is best-effort: a failure drops the checklist and keeps the card,
 * because the reset date is the part the user actually needs.
 */
export function QuotaExceededModal({
  open,
  onClose,
  feature,
  resetAt,
  title,
  subtitle,
  features,
}: QuotaExceededModalProps) {
  const plans = usePlanList(open && !features);

  const derived = getQuotaMessage(feature);
  const days = daysUntilReset(resetAt);
  const lines = features ?? (feature ? quotaUpgradeLines(feature, plans) : []);

  return (
    <UpgradeModal
      open={open}
      onClose={onClose}
      variant="quota"
      title={title ?? derived.title}
      subtitle={subtitle ?? 'รีเซตใหม่วันที่ 1 ของเดือนหน้า หรืออัปเกรดเพื่อใช้เพิ่มน้า'}
      note={`รีเซตอีก ${days} วัน`}
      features={lines}
    />
  );
}

export interface CapacityFullModalProps {
  open: boolean;
  onClose: () => void;
  /** Capacity feature key — 'vault_files' | 'group_boosts'. */
  feature: string;
  /** The plan's ceiling, straight from the 403 body. */
  limit?: number;
  title?: string;
  subtitle?: string;
}

/**
 * "ห้องนิรภัยเต็มแล้วน้า" — a CEILING on live rows, not a monthly allowance.
 *
 * Deliberately NOT the quota variant: waiting for the 1st does nothing here, so
 * the card must not carry a reset date, and it keeps the padlock rather than the
 * calendar. Deleting an item frees a slot immediately — the copy says so before
 * it mentions upgrading, because that is the free fix.
 */
export function CapacityFullModal({
  open,
  onClose,
  feature,
  limit,
  title,
  subtitle,
}: CapacityFullModalProps) {
  const plans = usePlanList(open);
  const derived = getCapacityMessage(feature, limit);

  return (
    <UpgradeModal
      open={open}
      onClose={onClose}
      title={title ?? derived.title}
      subtitle={subtitle ?? derived.subtitle}
      features={quotaUpgradeLines(feature, plans)}
    />
  );
}

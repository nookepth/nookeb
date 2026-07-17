import type { LegacyBoxOccasionId } from '@nookeb/shared';

/**
 * Line icons for the create flow's occasion cards + the locked Pro entries.
 *
 * SVG, never emoji — the same rule the reveal page's stickers follow. They
 * inherit `currentColor` so a selected card tints its icon with the theme accent
 * for free. They live here rather than in packages/shared because that package
 * is JSX-free (the API imports it).
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function BirthdayIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M4 20h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6Z" />
      <path d="M4 16h16" />
      <path d="M8 12V9m4 3V9m4 3V9" />
      <path d="M8 6.5c0-1 1-1.7 1-2.5.6.8 1 1.5 1 2.5a1 1 0 0 1-2 0Zm4 0c0-1 1-1.7 1-2.5.6.8 1 1.5 1 2.5a1 1 0 0 1-2 0Zm4 0c0-1 1-1.7 1-2.5.6.8 1 1.5 1 2.5a1 1 0 0 1-2 0Z" />
    </svg>
  );
}

function AnniversaryIcon() {
  return (
    <svg {...base} aria-hidden>
      <circle cx="9" cy="14" r="5.5" />
      <circle cx="15" cy="14" r="5.5" />
      <path d="M7.2 5.4 9 3l1.8 2.4M13.2 5.4 15 3l1.8 2.4" />
    </svg>
  );
}

function SurpriseIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9Z" />
      <path d="M3 7.5h18V11H3V7.5ZM12 7.5V21" />
      <path d="M12 7.5S10.5 3 8 3a2.2 2.2 0 0 0 0 4.5h4Zm0 0S13.5 3 16 3a2.2 2.2 0 0 1 0 4.5h-4Z" />
    </svg>
  );
}

function ApologyIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M12 20.5s-7.5-4.7-7.5-9.8A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 3.1c0 5.1-7.5 9.8-7.5 9.8Z" />
      <path d="m9.2 12.4 5.6 2.2M14.8 12.4l-5.6 2.2" />
    </svg>
  );
}

function LongingIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M3 11.5 21 4l-7.5 17-2.4-7.1L3 11.5Z" />
      <path d="m11.1 13.9 4.3-4.3" />
    </svg>
  );
}

function FamilyIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M3.5 10.6 12 4l8.5 6.6" />
      <path d="M5.5 9.6V20h13V9.6" />
      <path d="M12 17.4s-3-1.9-3-3.9a1.7 1.7 0 0 1 3-1.1 1.7 1.7 0 0 1 3 1.1c0 2-3 3.9-3 3.9Z" />
    </svg>
  );
}

function SpecialIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M12 3.5 14.4 9l5.6.6-4.2 3.9 1.2 5.6L12 16.3 7 19.1l1.2-5.6L4 9.6 9.6 9 12 3.5Z" />
    </svg>
  );
}

export const OCCASION_ICONS: Record<LegacyBoxOccasionId, () => JSX.Element> = {
  birthday: BirthdayIcon,
  anniversary: AnniversaryIcon,
  surprise: SurpriseIcon,
  apology: ApologyIcon,
  longing: LongingIcon,
  family: FamilyIcon,
  special: SpecialIcon,
};

export function CheckBadgeIcon() {
  return (
    <svg {...base} strokeWidth={2.4} aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Locked-feature marker for the Pro rows — replaces the 🔒 emoji. */
export function LockIcon() {
  return (
    <svg {...base} aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
      <circle cx="12" cy="15.2" r="1.1" />
    </svg>
  );
}

export function AudioIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M9 17.5V5.8l10-2v11.4" />
      <circle cx="6.6" cy="18" r="2.6" />
      <circle cx="16.6" cy="15.2" r="2.6" />
    </svg>
  );
}

export function VideoIcon() {
  return (
    <svg {...base} aria-hidden>
      <rect x="3" y="6" width="12.5" height="12" rx="2.4" />
      <path d="m15.5 12 5.5-3.4v6.8L15.5 12Z" />
    </svg>
  );
}

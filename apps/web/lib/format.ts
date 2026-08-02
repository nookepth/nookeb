export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ---- Thai calendar dates ---------------------------------------------------

   `calendar: 'buddhist'` is written out rather than left to the locale's
   default. th-TH resolves to the Buddhist era on every engine we ship to today,
   but that is a locale-data default, not a guarantee — and a date that silently
   renders 2026 instead of 2569 next to a countdown the server enforces is
   exactly the kind of disagreement this feature cannot afford.

   The formatters are built once at module scope: `new Intl.DateTimeFormat` is
   expensive enough that constructing one per render of a list is measurable. */

const THAI_DATE = new Intl.DateTimeFormat('th-TH', {
  calendar: 'buddhist',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', {
  calendar: 'buddhist',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * "17 ส.ค. 2569" from an ISO instant. Empty string for null/unparseable input,
 * so a caller can render it inline without guarding — a missing date shows
 * nothing rather than "Invalid Date".
 */
export function formatThaiDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : THAI_DATE.format(d);
}

/** "17 ส.ค. 2569 14:30". Same null/NaN contract as formatThaiDate. */
export function formatThaiDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : THAI_DATE_TIME.format(d);
}

/**
 * "บันทึกลงปฏิทิน" — the ONE implementation, shared by the dashboard task detail
 * page, the LIFF task detail page and the LIFF create flow.
 *
 * We open Google Calendar's event-template URL rather than downloading the
 * `.ics` that GET /tasks/:id/ics still serves. The download loses in exactly the
 * environments this button lives in:
 *   - the LINE in-app browser cannot open a `text/calendar` attachment at all,
 *     so the download silently did nothing there;
 *   - on mobile Safari/Chrome a downloaded file needs a second manual "open
 *     with Calendar" step most users never take.
 * The template URL opens the user's real calendar in one tap everywhere. The
 * ICS endpoint is untouched — it is still the right thing for a direct link,
 * and it is what carries per-item deadlines and alarms.
 *
 * Opening strategy, in order of preference:
 *   1. real LIFF client → `liff.openWindow({ external: true })`, which hands off
 *      to the device browser where Google Calendar behaves normally. The SDK is
 *      pulled with a DYNAMIC import so the dashboard bundle does not carry it.
 *   2. LINE in-app browser WITHOUT the SDK in-client (a task link opened as a
 *      plain URL) → `window.open` is blocked / opens a tab that closes
 *      instantly, so navigate the current tab instead.
 *   3. everywhere else → new tab, falling back to a top-level navigation when
 *      the popup blocker eats it.
 */

/** UTC basic-format stamp Google Calendar expects, e.g. 20260803T110000Z. */
function toGoogleStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`
  );
}

/**
 * Google Calendar template URL for a task deadline. The event is one hour long
 * ending at nothing in particular — a zero-length event renders as a hairline
 * in month view and is easy to miss, which defeats the point of saving it.
 *
 * A null/unparseable deadline yields the bare calendar URL rather than an event
 * with an "Invalid Date" range; callers hide the button in that case anyway.
 */
export function buildGoogleCalendarUrl(
  title: string,
  deadlineISO: string | null,
  description = '',
): string {
  if (!deadlineISO) return 'https://calendar.google.com';
  const start = new Date(deadlineISO);
  if (Number.isNaN(start.getTime())) return 'https://calendar.google.com';
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const params = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(title || 'งาน')}`,
    `dates=${toGoogleStamp(start)}/${toGoogleStamp(end)}`,
  ];
  if (description) params.push(`details=${encodeURIComponent(description)}`);
  return `https://calendar.google.com/calendar/render?${params.join('&')}`;
}

/** Open `url` the way the current environment actually allows (see file header). */
async function openExternal(url: string): Promise<void> {
  // 1) Real LIFF client. The import is dynamic AND guarded: on the dashboard the
  //    SDK is not part of the bundle graph until this button is pressed, and on
  //    a plain browser `isInClient()` is simply false.
  try {
    const { default: liff } = await import('@line/liff');
    if (liff.isInClient()) {
      liff.openWindow({ url, external: true });
      return;
    }
  } catch {
    // SDK absent or not initialised — fall through to the UA checks.
  }

  // 2) LINE in-app browser without an initialised SDK.
  if (typeof navigator !== 'undefined' && /\bLine\//i.test(navigator.userAgent)) {
    window.location.href = url;
    return;
  }

  // 3) Ordinary browser.
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) window.location.href = url;
}

/**
 * Put a task's deadline into the user's calendar.
 *
 * `taskId` is kept in the signature for call-site compatibility (it used to
 * address the ICS endpoint) and is deliberately unused.
 */
export async function saveTaskToCalendar(
  taskId: string,
  title: string,
  deadlineISO: string,
  description = '',
): Promise<void> {
  void taskId;
  await openExternal(buildGoogleCalendarUrl(title, deadlineISO, description));
}

/**
 * Client-side product analytics — the ONE utility every client-triggered event
 * goes through (modal impressions, page views, demand-test taps). It POSTs to
 * the authenticated POST /api/events/track, which validates the name against a
 * server-side whitelist and writes usage_events; the browser never touches the
 * table directly. Fire-and-forget: it never throws and never blocks the UI, so
 * a lost analytics ping can't degrade the app (same posture as the server's
 * logEvent()).
 *
 * Works from both the dashboard and the LIFF task pages — the same same-origin
 * /api-proxy session cookie authenticates it either way.
 */

// Keep in sync with CLIENT_TRACKABLE_EVENTS in apps/api/src/services/events.service.ts.
export type ClientEventName =
  | 'pro_interest_view'
  | 'pro_interest_click'
  | 'pro_interest_dismiss'
  | 'task_create_start'
  | 'task_view'
  | 'task_repeat_view'
  | 'task_ics_download';

type Scalar = number | string | boolean;

const SESSION_KEY = 'nookeb_session_id';

/** A per-tab-session UUID correlating one browser session's events. */
function sessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // private mode — events just go without a session dimension
    return undefined;
  }
}

/** 'liff' for the in-LINE task pages, else 'web'. Server may override/ignore. */
function entryChannel(): string {
  if (typeof window === 'undefined') return 'web';
  return window.location.pathname.startsWith('/liff') ? 'liff' : 'web';
}

/**
 * Record a client event. Fire-and-forget — call it as `trackEvent('task_view')`
 * with no await. The payload is trimmed to privacy-safe scalars server-side, so
 * pass only structured values (ids, counts, flags), never free text / PII.
 */
export function trackEvent(eventName: ClientEventName, payload?: Record<string, Scalar>): void {
  if (typeof window === 'undefined') return;
  const sid = sessionId();
  try {
    void fetch('/api-proxy/api/events/track', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventName,
        ...(payload ? { payload } : {}),
        ...(sid ? { sessionId: sid } : {}),
        entryChannel: entryChannel(),
      }),
      // don't hold the page/unload on analytics
      keepalive: true,
    }).catch(() => {
      /* best-effort — a dropped event is never surfaced */
    });
  } catch {
    /* ignore — analytics must never break the UI */
  }
}

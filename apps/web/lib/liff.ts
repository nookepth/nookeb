import liff from '@line/liff';

/**
 * LIFF bootstrap for ระบบตามงาน pages (/liff/tasks/*). One init per page load,
 * memoized — LIFF sometimes hard-reloads on navigation, which is why the task
 * draft lives in sessionStorage (lib/taskDraft.ts), not React state.
 *
 * Session: the LIFF id token is exchanged at POST /auth/liff for the same
 * HttpOnly session cookie the dashboard uses, so every task API call goes
 * through the same-origin /api-proxy exactly like the rest of the web app.
 *
 * Robustness (why this file is not a one-liner): establishing the session is
 * the ONLY thing standing between the user and a wall of 401s, so it must never
 * fail silently. Three real failure modes are handled explicitly instead of
 * being swallowed (the old code only special-cased a 401 from /auth/liff and
 * marched on regardless, so every one of these surfaced later as a misleading
 * "เซสชันหมดอายุ" on a protected route):
 *   1. liff.getIDToken() returns null (the LIFF login has no `openid` scope, or
 *      the cached token was dropped) → one loop-guarded liff.login() to force a
 *      fresh consent/token; if it still comes back null, report it.
 *   2. /auth/liff rejects the token (401 — expired id token / aud mismatch) →
 *      one loop-guarded re-login for a fresh token.
 *   3. /auth/liff is transiently unavailable (429/5xx/network) → a short retry,
 *      then report a connect error the page can offer a real retry for.
 * The result carries `authed`, so pages branch on it BEFORE calling a protected
 * route, and `apiFetch()` re-authenticates once on any stray 401.
 *
 * Dev fallback: with NEXT_PUBLIC_LIFF_ID unset (local dev outside LINE), the
 * page runs LIFF-less — groupId comes from ?groupId=… and the session must
 * already exist (log in via the dashboard first).
 */

export type AuthError = 'no-id-token' | 'verify-failed' | 'network';

export interface LiffState {
  groupId: string | null;
  profile: { userId: string; displayName: string; pictureUrl?: string } | null;
  inClient: boolean;
  /**
   * true once an app session cookie is guaranteed established (or LIFF-less dev
   * mode, which trusts an existing dashboard cookie). When false, protected API
   * calls WILL 401 — pages must show the connect/auth notice keyed off
   * `authError`, never proceed to a protected fetch.
   */
  authed: boolean;
  /** Why the session couldn't be established (null when authed). */
  authError: AuthError | null;
}

let ready: Promise<LiffState> | null = null;

export function initLiff(): Promise<LiffState> {
  if (!ready) ready = doInit();
  return ready;
}

/**
 * Drop the memoized init and run it again. Used by retry buttons and by
 * apiFetch() on a 401 so a transient auth failure can actually recover (the old
 * retry re-ran only the data fetch, so a missing session was a permanent
 * dead-end). May navigate away (re-login) and never resolve — that's fine, the
 * page parks until LINE returns it.
 */
export function resetLiff(): Promise<LiffState> {
  ready = null;
  return initLiff();
}

/**
 * Explicit user-initiated reconnect (the "เชื่อมต่ออีกครั้ง" button). Unlike
 * resetLiff(), this CLEARS the one-shot login budget so a genuine fresh
 * liff.login() can fire — otherwise the retry re-runs doInit with the budget
 * already spent, tryRelogin() no-ops, and the user is stuck looping on the same
 * "ต้องเชื่อมต่อ LINE" notice forever. The budget re-arms after this single
 * forced attempt, so at most ONE extra redirect happens per tap (never an
 * infinite redirect loop). apiFetch's silent 401 recovery deliberately does NOT
 * clear the budget — only a real user tap does.
 */
export function reconnectLiff(): Promise<LiffState> {
  clearLoginAttempts();
  ready = null;
  return initLiff();
}

// groupId belt-and-braces across the login redirect. A LINE Login channel LIFF
// carries the group id in ?groupId= (folded into ?liff.state= at the endpoint
// root). The OAuth round trip of liff.login() has been observed to drop the
// query portion of liff.state on some LINE client versions, which would strand
// the member page with no group. So the moment we ever see a groupId we mirror
// it into sessionStorage (scoped to this LIFF tab, cleared on close) and read it
// back as the last-resort fallback.
const GROUP_ID_KEY = 'nookeb:liff:groupId';

function storedGroupId(): string | null {
  try {
    return sessionStorage.getItem(GROUP_ID_KEY);
  } catch {
    return null;
  }
}
function persistGroupId(id: string | null): void {
  if (!id) return;
  try {
    sessionStorage.setItem(GROUP_ID_KEY, id);
  } catch {
    /* private mode — the URL/liff.state path still carries it */
  }
}

/**
 * ?groupId= read at the CURRENT URL. Exported because initLiff() is memoized:
 * its stored groupId can predate a client-side redirect that added the query
 * (the endpoint-root fallback), so pages re-read this at consume time.
 */
export function queryGroupId(): string | null {
  return new URLSearchParams(window.location.search).get('groupId');
}

/**
 * Full groupId resolution for pages: live URL query → sessionStorage belt (a
 * value that survived a prior login redirect). Persists whatever it finds so a
 * later redirect can recover it. Pages should prefer this over queryGroupId()
 * as the fallback next to liffState.groupId.
 */
export function resolveGroupId(): string | null {
  const id = queryGroupId() ?? storedGroupId();
  persistGroupId(id);
  return id;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One forced re-login per LIFF webview session. Persisted in sessionStorage so
// it survives the login redirect (which reloads the page). Without the cap a
// genuinely missing `openid` scope would redirect forever, because re-login can
// never add a scope the LIFF app doesn't grant.
const LOGIN_ATTEMPT_KEY = 'nookeb:liff:loginAttempts';
const MAX_LOGIN_ATTEMPTS = 1;

function loginAttempts(): number {
  try {
    return Number(sessionStorage.getItem(LOGIN_ATTEMPT_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}
function bumpLoginAttempts(): void {
  try {
    sessionStorage.setItem(LOGIN_ATTEMPT_KEY, String(loginAttempts() + 1));
  } catch {
    /* private mode — the in-memory memo still prevents a tight loop this load */
  }
}
function clearLoginAttempts(): void {
  try {
    sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
  } catch {
    /* ignore */
  }
}

/** Re-login once (if the budget allows) and park; else return null to report. */
function tryRelogin(): Promise<LiffState> | null {
  if (loginAttempts() >= MAX_LOGIN_ATTEMPTS) return null;
  bumpLoginAttempts();
  // Mirror the group id into sessionStorage BEFORE the OAuth redirect, so it
  // survives even if LINE drops the query from liff.state on the round trip.
  persistGroupId(queryGroupId() ?? storedGroupId());
  liff.login({ redirectUri: window.location.href });
  // login() navigates away — park forever so callers never proceed half-ready.
  return new Promise<LiffState>(() => {});
}

/** POST the id token → session cookie, with one retry for transient failures. */
async function exchangeIdToken(idToken: string): Promise<'ok' | 'unauthorized' | 'error'> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    let res: Response;
    try {
      res = await fetch('/api-proxy/auth/liff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        credentials: 'same-origin',
      });
    } catch {
      if (attempt === 0) {
        await delay(600);
        continue;
      }
      return 'error';
    }
    if (res.ok) return 'ok';
    // 401 = the token itself was rejected (expired / wrong audience). Never
    // retry with the same token — the caller re-logins for a fresh one.
    if (res.status === 401) return 'unauthorized';
    // 429 (rate-limit) / 5xx = transient; one delayed retry, then give up.
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await delay(800);
      continue;
    }
    return 'error';
  }
  return 'error';
}

// Messaging-API chat ids: groups C + 32 hex, rooms R + 32 hex. A LINE MINI App
// LIFF's getContext() returns PSEUDO chat ids (UUID format) that the Messaging
// API does not know — treating one as the tenant key silently forks the group
// into a ghost roster containing only the caller (the mobile "one member" bug),
// and tasks created under it can never be announced. So a ctx id is usable only
// when it matches the real id shape.
const LINE_CHAT_ID = /^[CR][0-9a-f]{32}$/;

async function readContext(): Promise<Pick<LiffState, 'groupId' | 'profile' | 'inClient'>> {
  // Chat context is NOT reliable: LINE Desktop, the login round trips, and
  // forwarded/pinned links open the LIFF with type 'external'/'none' (no
  // groupId), and a MINI App channel reports pseudo UUID ids (filtered above).
  // The สร้างงาน card therefore carries the group id in ?groupId= (a capability,
  // same trust model as share links; the API still verifies membership) — that
  // query is the source of truth, with ctx/sessionStorage as fallbacks only.
  const ctx = liff.getContext();
  const rawCtxId =
    ctx?.type === 'group'
      ? (ctx.groupId ?? null)
      : ctx?.type === 'room'
        ? ((ctx as { roomId?: string }).roomId ?? null)
        : null;
  const ctxGroupId = rawCtxId && LINE_CHAT_ID.test(rawCtxId) ? rawCtxId : null;
  // URL query (the card's capability — always the webhook's real id) → real
  // chat context → sessionStorage belt. Persist the winner for the next redirect.
  const groupId = queryGroupId() ?? ctxGroupId ?? storedGroupId();
  persistGroupId(groupId);

  let profile: LiffState['profile'] = null;
  try {
    profile = await liff.getProfile();
  } catch {
    // profile scope missing — pages fall back to server-side data only
  }
  return { groupId, profile, inClient: liff.isInClient() };
}

async function doInit(): Promise<LiffState> {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;

  // LIFF-less dev mode: no LIFF id → no id-token exchange is possible. Trust an
  // existing dashboard cookie (the documented dev workflow: log in first).
  if (!liffId) {
    return { groupId: queryGroupId(), profile: null, inClient: false, authed: true, authError: null };
  }

  // MINI App note: liff.init() takes ONLY { liffId } — no withLoginOnExternalBrowser
  // (LINE MINI App does not support the external-browser login flow, and passing
  // it makes init reject). The SDK (@line/liff >= 2.22) handles both the
  // miniapp.line.me and liff.line.me entry domains from this single call.
  try {
    await liff.init({ liffId });
  } catch (err) {
    // Never swallow: a failed init is the most common MINI App migration
    // symptom (wrong/stale LIFF id → the LINE-native "เกิดข้อผิดพลาดระบบ").
    // Log the id in use so the value can be confirmed against the console.
    console.error(`[liff] init failed — NEXT_PUBLIC_LIFF_ID is: "${liffId}"`, err);
    return { groupId: queryGroupId(), profile: null, inClient: false, authed: false, authError: 'network' };
  }

  if (!liff.isLoggedIn()) {
    const parked = tryRelogin();
    if (parked) return parked;
    // Login budget spent and still not logged in — surface it, don't 401 later.
    return { ...(await readContext()), authed: false, authError: 'no-id-token' };
  }

  const idToken = liff.getIDToken();
  if (!idToken) {
    // No id token despite being logged in → the LIFF login lacks `openid`, or
    // the token was dropped. One forced re-login may refresh it; if not, report.
    const parked = tryRelogin();
    if (parked) return parked;
    return { ...(await readContext()), authed: false, authError: 'no-id-token' };
  }

  const result = await exchangeIdToken(idToken);
  if (result === 'unauthorized') {
    // 401 from /auth/liff after a fresh token = the API verified this token
    // against the WRONG channel id (aud mismatch — the classic MINI App
    // migration bug: LINE_LIFF_CHANNEL_ID / LINE_LIFF_ID must match the MINI
    // App channel, not the LINE Login channel).
    console.error(
      `[liff] /auth/liff rejected the id token (401). LIFF id "${liffId}" — verify the API's LINE_LIFF_CHANNEL_ID matches this MINI App channel.`,
    );
    const parked = tryRelogin();
    if (parked) return parked;
    return { ...(await readContext()), authed: false, authError: 'verify-failed' };
  }
  if (result === 'error') {
    console.error('[liff] /auth/liff unreachable or 5xx while exchanging the id token');
    return { ...(await readContext()), authed: false, authError: 'network' };
  }

  // Session established — clear the re-login budget for a clean next open.
  clearLoginAttempts();
  return { ...(await readContext()), authed: true, authError: null };
}

/**
 * Same-origin fetch to the task API that self-heals a stray 401: if the session
 * cookie is missing/expired at call time, it re-runs auth ONCE and retries. This
 * makes every page resilient to the cookie not being present on the first try
 * (hard reload between steps, a just-issued cookie, etc.) regardless of which
 * page established the session. On a genuine auth failure the re-auth resolves
 * `authed:false` and the original 401 is returned for the page to render.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const opts: RequestInit = { credentials: 'same-origin', ...init };
  const res = await fetch(input, opts);
  if (res.status !== 401) return res;

  const state = await resetLiff();
  if (!state.authed) return res; // couldn't recover — let the caller show the notice
  return fetch(input, opts);
}

/** Close the LIFF window (no-op outside the LINE client). */
export function closeLiff(): void {
  try {
    if (liff.isInClient()) liff.closeWindow();
  } catch {
    // outside LINE — nothing to close
  }
}

/**
 * "บันทึกลงปฏิทิน" — put a task's deadline into the user's calendar. The server
 * `/tasks/:id/ics` endpoint downloads fine on desktop but does NOTHING in the
 * LINE in-app browser (no file handler for a .ics attachment), so this picks a
 * path that actually works on mobile:
 *   - in the LINE client → open Google Calendar's event template externally
 *   - else if the Web Share sheet exists → share the .ics data URI
 *   - else (desktop) → download the .ics file
 */
export async function saveTaskToCalendar(
  title: string,
  deadlineISO: string,
  description = '',
): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
      d.getUTCHours(),
    )}${pad(d.getUTCMinutes())}00Z`;
  const start = new Date(deadlineISO);
  const end = new Date(start.getTime() + 3600000);

  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:${title}\r\nDTSTART:${fmt(start)}\r\nDTEND:${fmt(end)}\r\nDESCRIPTION:${description}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const icsUri = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);

  // LINE in-app browser → open Google Calendar (it can't handle .ics downloads)
  try {
    if (liff.isInClient()) {
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
        title,
      )}&dates=${fmt(start)}/${fmt(end)}&details=${encodeURIComponent(description)}`;
      liff.openWindow({ url: gcal, external: true });
      return;
    }
  } catch {
    // SDK not ready / outside LINE — fall through to share or download
  }

  // Mobile share sheet
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, url: icsUri });
      return;
    } catch {
      // user cancelled or share unsupported for this payload — fall through
    }
  }

  // Fallback: download .ics
  Object.assign(document.createElement('a'), { href: icsUri, download: `${title}.ics` }).click();
}

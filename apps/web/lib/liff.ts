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
 * ?groupId= read at the CURRENT URL. Exported because initLiff() is memoized:
 * its stored groupId can predate a client-side redirect that added the query
 * (the endpoint-root fallback), so pages re-read this at consume time.
 */
export function queryGroupId(): string | null {
  return new URLSearchParams(window.location.search).get('groupId');
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

async function readContext(): Promise<Pick<LiffState, 'groupId' | 'profile' | 'inClient'>> {
  // Chat context is authoritative but NOT reliable: LINE Desktop, the login
  // round trips, and forwarded/pinned links all open the LIFF with type
  // 'external'/'none' — no groupId — even when the tap happened inside the
  // group. The สร้างงาน card therefore carries the group id in ?groupId= (a
  // capability, same trust model as share links; the API still verifies
  // membership), so ALWAYS fall back to the query when context has no chat.
  const ctx = liff.getContext();
  const ctxGroupId =
    ctx?.type === 'group'
      ? (ctx.groupId ?? null)
      : ctx?.type === 'room'
        ? ((ctx as { roomId?: string }).roomId ?? null)
        : null;
  const groupId = ctxGroupId ?? queryGroupId();

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

  try {
    await liff.init({ liffId });
  } catch {
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
    const parked = tryRelogin();
    if (parked) return parked;
    return { ...(await readContext()), authed: false, authError: 'verify-failed' };
  }
  if (result === 'error') {
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

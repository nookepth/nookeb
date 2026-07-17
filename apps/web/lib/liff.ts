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
 * Dev fallback: with NEXT_PUBLIC_LIFF_ID unset (local dev outside LINE), the
 * page runs LIFF-less — groupId comes from ?groupId=… and the session must
 * already exist (log in via the dashboard first).
 */

export interface LiffState {
  groupId: string | null;
  profile: { userId: string; displayName: string; pictureUrl?: string } | null;
  inClient: boolean;
}

let ready: Promise<LiffState> | null = null;

export function initLiff(): Promise<LiffState> {
  if (!ready) ready = doInit();
  return ready;
}

function queryGroupId(): string | null {
  return new URLSearchParams(window.location.search).get('groupId');
}

async function doInit(): Promise<LiffState> {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) {
    return { groupId: queryGroupId(), profile: null, inClient: false };
  }

  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href });
    // login() navigates away — park forever so callers never proceed half-ready.
    return new Promise<LiffState>(() => {});
  }

  const idToken = liff.getIDToken();
  if (idToken) {
    const res = await fetch('/api-proxy/auth/liff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    // Expired id token (LIFF tab left open past ~1h) — re-login refreshes it.
    if (res.status === 401) {
      liff.login({ redirectUri: window.location.href });
      return new Promise<LiffState>(() => {});
    }
  }

  const ctx = liff.getContext();
  const groupId =
    ctx?.type === 'group'
      ? (ctx.groupId ?? null)
      : ctx?.type === 'room'
        ? ((ctx as { roomId?: string }).roomId ?? null)
        : queryGroupId();

  let profile: LiffState['profile'] = null;
  try {
    profile = await liff.getProfile();
  } catch {
    // profile scope missing — pages fall back to server-side data only
  }
  return { groupId, profile, inClient: liff.isInClient() };
}

/** Close the LIFF window (no-op outside the LINE client). */
export function closeLiff(): void {
  try {
    if (liff.isInClient()) liff.closeWindow();
  } catch {
    // outside LINE — nothing to close
  }
}

export const LINE_LOGIN_CHANNEL_ID = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID ?? '';

const STATE_KEY = 'line_login_state';

// FIX: 1 - Safari ITP / LINE in-app browser can drop sessionStorage across the
// OAuth redirect; mirror the CSRF state in a short-lived SameSite=Lax cookie
// (Lax cookies survive the top-level redirect back from access.line.me).
function setStateCookie(state: string): void {
  document.cookie = `${STATE_KEY}=${state}; path=/; max-age=600; SameSite=Lax`;
}

function readStateCookie(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${STATE_KEY}=([^;]*)`));
  return m && m[1] !== undefined ? decodeURIComponent(m[1]) : null;
}

function clearStateCookie(): void {
  document.cookie = `${STATE_KEY}=; path=/; max-age=0; SameSite=Lax`;
}

export function lineLoginRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

/** Build the LINE Login authorize URL and navigate to it. */
export function startLineLogin(): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  setStateCookie(state); // FIX: 1 - cookie fallback for Safari/LINE in-app browser
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINE_LOGIN_CHANNEL_ID,
    redirect_uri: lineLoginRedirectUri(),
    state,
    scope: 'profile openid',
  });
  window.location.href = `https://access.line.me/oauth2/v2.1/authorize?${params}`;
}

export function validateLineLoginState(state: string | null): boolean {
  // FIX: 1 - accept the cookie fallback when Safari has cleared sessionStorage
  const saved = sessionStorage.getItem(STATE_KEY) ?? readStateCookie();
  sessionStorage.removeItem(STATE_KEY);
  clearStateCookie();
  return state !== null && state === saved;
}

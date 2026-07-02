export const LINE_LOGIN_CHANNEL_ID = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID ?? '';

export function lineLoginRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

/** Build the LINE Login authorize URL and navigate to it. */
export function startLineLogin(): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem('line_login_state', state);
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
  const saved = sessionStorage.getItem('line_login_state');
  sessionStorage.removeItem('line_login_state');
  return state !== null && state === saved;
}

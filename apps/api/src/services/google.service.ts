import { config } from '../config';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

// drive.file = access only to files this app creates (least privilege)
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID!,
    redirect_uri: config.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    return (JSON.parse(json) as { email?: string }).email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(
  code: string,
): Promise<{ refreshToken: string | null; accessToken: string; email: string | null }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID!,
      client_secret: config.GOOGLE_CLIENT_SECRET!,
      redirect_uri: config.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = (await res.json()) as TokenResponse;
  return {
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
    email: emailFromIdToken(tokens.id_token),
  };
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.GOOGLE_CLIENT_ID!,
      client_secret: config.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as TokenResponse).access_token;
}

/** Upload a file to the user's Drive (multipart: metadata + media). Returns the Drive link. */
export async function uploadToDrive(
  accessToken: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<{ id: string; link: string }> {
  const boundary = `nookeb${Date.now()}`;
  const metadata = JSON.stringify({ name });
  const preamble =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;

  const payload = Buffer.concat([Buffer.from(preamble, 'utf-8'), body, Buffer.from(epilogue, 'utf-8')]);

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: payload,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const file = (await res.json()) as { id: string };
  return { id: file.id, link: `https://drive.google.com/file/d/${file.id}/view` };
}

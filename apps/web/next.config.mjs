/**
 * API proxy target for the /api-proxy/* rewrite below. Server-side env var
 * (NOT NEXT_PUBLIC_*): the browser only ever sees the relative /api-proxy
 * path, which makes every API call same-origin — required so the HttpOnly
 * session cookie (SameSite=Lax) flows in Safari and the LINE in-app browser,
 * where a cross-site cookie to the Railway API domain would be blocked.
 * Set it in Vercel to the deployed API origin (no trailing slash).
 */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';

/**
 * Content-Security-Policy. Built from a directive map for readability.
 *
 * Notes on why each relaxation exists (do NOT tighten without checking the app
 * still renders):
 * - script-src 'unsafe-inline': the landing page ships two inline <script>s
 *   (the FAQ JSON-LD and the reveal-failsafe timer in app/page.tsx) and Next.js
 *   injects its own inline hydration bootstrap. A nonce-based strict CSP would
 *   need per-request middleware — tracked as a follow-up; this is the safe
 *   first step that adds frame/clickjacking + Referrer protection today.
 * - style-src 'unsafe-inline': Next.js + next/font emit inline <style>, and the
 *   <noscript> reveal fallback is an inline style block.
 * - img-src https: — dashboard/share/diary render presigned R2 URLs and LINE
 *   profile pictures (profile.line-scdn.net); both are https on hosts we don't
 *   want to hardcode. data:/blob: cover favicons and any object URLs.
 * - object-src / frame-src allow https: because the public share page previews
 *   PDFs via <object data={presigned R2 url}>; 'none' would break that preview.
 * - connect-src 'self': the browser only ever calls the same-origin /api-proxy.
 * - frame-ancestors 'none' (mirrored by X-Frame-Options: DENY) blocks
 *   clickjacking of the dashboard.
 */
const csp = Object.entries({
  'default-src': ["'self'"],
  // 'unsafe-eval' is DEV-ONLY: next dev serves webpack eval-source-map chunks,
  // which this CSP otherwise blocks — scripts load but never execute, so every
  // page renders its SSR shell and silently never hydrates. Production builds
  // don't use eval and don't get the relaxation.
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    ...(process.env.NODE_ENV === 'development' ? ["'unsafe-eval'"] : []),
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  // media-src must exist in its own right: <audio>/<video> fall back to
  // default-src ('self'), which blocks BOTH of the legacy-box voice sources —
  // the recorder's blob: preview URL and the reveal page's presigned R2 https
  // URL. Omitting it is why the player showed "ไม่สามารถโหลดเสียงได้" while the
  // photos beside it (img-src https:) loaded fine.
  'media-src': ["'self'", 'blob:', 'https:'],
  'font-src': ["'self'", 'data:'],
  // api.line.me: the LIFF SDK (@line/liff, bundled via npm — no CDN script) on
  // /liff/tasks/* calls LINE's REST endpoints directly from the page (init,
  // profile). Everything else stays same-origin via /api-proxy.
  'connect-src': ["'self'", 'https://api.line.me'],
  'object-src': ["'self'", 'https:'],
  'frame-src': ["'self'", 'https:'],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
})
  .map(([directive, values]) => `${directive} ${values.join(' ')}`)
  .join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // microphone=(self): the legacy-box voice recorder needs getUserMedia on our
  // own origin. `microphone=()` disables it for the whole origin, so the browser
  // rejects with NotAllowedError WITHOUT ever prompting — the recorder then
  // renders its permission error on the first tap, looking like a denial the
  // user never made. Keep camera/geolocation fully off; nothing uses them.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@nookeb/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    return [
      {
        source: '/api-proxy/:path*',
        destination: `${API_PROXY_TARGET}/:path*`,
      },
    ];
  },
};

export default nextConfig;

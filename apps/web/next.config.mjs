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
 * Security headers WITHOUT the Content-Security-Policy.
 *
 * FIX 12 moved the CSP to apps/web/middleware.ts, because it now carries a
 * per-request `'nonce-…'` in script-src and 'unsafe-inline' is gone. A static
 * header here cannot express that, and — more importantly — shipping BOTH a
 * static and a middleware CSP does not "merge": the browser enforces every
 * policy it receives, so the old permissive header would not loosen anything
 * but the old one's *absence* of a nonce would blacklist the nonced scripts
 * the new one allows. Two CSP headers = the intersection = a broken app.
 * Do not re-add a Content-Security-Policy entry to this list.
 *
 * The headers below stay here on purpose: they carry no per-request value, and
 * next.config.mjs applies them to '/:path*' — including the static-asset paths
 * the middleware matcher deliberately skips. See middleware.ts for the CSP
 * itself and the reasoning behind each directive.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Vercel already injects HSTS on *.vercel.app, but won't on a future custom
  // domain — set it explicitly so TLS is pinned wherever the app is served.
  // (Browsers ignore HSTS over plain http, so local dev is unaffected.)
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
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
  // pdfjs-dist (the MOBILE file-preview PDF renderer) optionally `require`s the
  // Node 'canvas' package for server-side rendering, which we never do — we
  // render to a real <canvas> in the browser. Without this alias webpack fails
  // the build with "Module not found: Can't resolve 'canvas'". Stubbing it to
  // false is the documented browser-only setup and affects nothing else.
  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async redirects() {
    return [
      // The "สร้างงาน" Flex card links to liff.line.me/{id}/create/{type}. When
      // that path resolves against the site root instead of the /liff/tasks
      // LIFF endpoint (endpoint set to the bare origin, or the URL shared
      // outside LINE), it 404s here — forward it into the real create flow.
      // Query params (?groupId=…, liff.state) are preserved automatically.
      {
        source: '/create/:type(single|multi|recurring)',
        destination: '/liff/tasks/create/:type',
        permanent: false,
      },
    ];
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

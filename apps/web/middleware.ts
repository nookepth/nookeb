import { NextResponse, type NextRequest } from 'next/server';

/**
 * FIX 12 — nonce-based Content-Security-Policy.
 *
 * Why this file exists at all: script-src used to carry 'unsafe-inline', which
 * makes the whole script-src allowlist decorative — any injected <script> runs.
 * It could not simply be dropped, because the app legitimately ships inline
 * scripts and a nonce is the only way to keep them working:
 *
 *   1. app/page.tsx — the FAQ JSON-LD block and the reveal-failsafe timer
 *      (both `dangerouslySetInnerHTML`). These are ours and take the nonce
 *      explicitly; see the `headers().get('x-nonce')` reads in that file.
 *   2. Next.js's own hydration bootstrap (`self.__next_f.push(...)`), which it
 *      injects on every route. Next 14 nonces those AUTOMATICALLY, but only if
 *      it can find the nonce — which is why the CSP below is written onto the
 *      REQUEST headers as well as the response. Without the request-header
 *      copy, Next emits un-nonced bootstrap scripts, the browser blocks them,
 *      and every page renders its SSR shell and silently never hydrates
 *      (exactly the failure the old 'unsafe-eval' comment describes).
 *
 * Two things that are deliberately NOT here:
 *
 * - 'strict-dynamic'. It would switch the browser to nonce-propagation and
 *   make host allowlists inert — which would kill https://static.line-scdn.net,
 *   the CDN the bundled @line/liff SDK lazily pulls its edge extensions from on
 *   /liff/tasks/*. Those are src'd scripts, not inline, so a plain host entry
 *   is the right tool and 'strict-dynamic' would be a regression.
 * - style-src 'unsafe-inline' removal. next/font and Next itself emit inline
 *   <style>, and the landing page's <noscript> reveal fallback is an inline
 *   style block. Inline styles are a far weaker vector than inline scripts;
 *   this stays as an accepted relaxation.
 *
 * COST, stated plainly: a per-request nonce cannot be baked into a static
 * page, so every route matched below is now dynamically rendered. The landing
 * page (`/`) was previously static. Its metadata, JSON-LD and SEO markup are
 * unchanged — crawlers still get fully-rendered HTML — but it is served from
 * the function, not the static cache.
 *
 * The remaining security headers (X-Frame-Options, HSTS, Referrer-Policy,
 * Permissions-Policy, nosniff) stay in next.config.mjs: they carry no
 * per-request value, and leaving them there keeps them on the asset paths this
 * middleware deliberately skips.
 */

/**
 * 16 random bytes, base64. Web Crypto rather than `crypto.randomBytes` —
 * middleware runs on the Edge runtime, where node:crypto is unavailable.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const isDev = process.env.NODE_ENV === 'development';

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'unsafe-eval' is DEV-ONLY: next dev serves webpack eval-source-map
    // chunks, which this CSP otherwise blocks. Production builds don't eval.
    // static.line-scdn.net: the bundled @line/liff SDK lazily fetches its edge
    // extension scripts (liff/edge/2/sdk.js, l2m-extensions) from this CDN at
    // runtime on /liff/tasks/*. Without it the SDK logs "[LIFF Init] failed to
    // load legacy extensions" and runs degraded.
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      'https://static.line-scdn.net',
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    // dashboard/share/diary render presigned R2 URLs and LINE profile pictures
    // (profile.line-scdn.net); both https on hosts we don't want to hardcode.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    // media-src must exist in its own right: <audio>/<video> fall back to
    // default-src ('self'), which blocks BOTH legacy-box voice sources — the
    // recorder's blob: preview URL and the reveal page's presigned R2 URL.
    'media-src': ["'self'", 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    // api.line.me + liff.line.me: the LIFF SDK calls LINE's REST endpoints
    // directly from the page. access.line.me is a top-level NAVIGATION, not a
    // fetch, so it needs no entry. Everything else is same-origin /api-proxy —
    // including the mobile pdf.js viewer, which reads /api/file-pdf/:id rather
    // than fetching R2 cross-origin (that would need an R2 CORS setting that
    // does not live in this repo).
    'connect-src': ["'self'", 'https://api.line.me', 'https://liff.line.me'],
    // the public share page previews PDFs via <object data={presigned R2 url}>;
    // 'none' would break that preview.
    'object-src': ["'self'", 'https:'],
    'frame-src': ["'self'", 'https:'],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // mirrored by X-Frame-Options: DENY in next.config.mjs
    'frame-ancestors': ["'none'"],
  };

  const csp = Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');

  // Next reads BOTH of these off the request to nonce its own inline scripts,
  // and app/page.tsx reads x-nonce via headers(). Setting only the response
  // header is the classic way to get a silently un-hydrated app.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except the ones that can neither host a script nor benefit
     * from a nonce:
     *   _next/static  — hashed build assets
     *   _next/image   — the image optimizer
     *   favicon.ico / icon / apple-icon — metadata icon routes
     *   public files with an extension (logo.png, pdf.worker.min.mjs, …)
     * Skipping them also keeps every request from paying for a nonce it would
     * throw away. The static security headers in next.config.mjs still apply
     * to these paths.
     *
     * The `missing` clause skips Next's own prefetch/RSC requests: those fetch
     * a flight payload, not a document, so a fresh nonce there would not match
     * the nonce already live in the page that prefetched it.
     */
    {
      source:
        '/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|.*\\.[\\w]+$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

/**
 * API proxy target for the /api-proxy/* rewrite below. Server-side env var
 * (NOT NEXT_PUBLIC_*): the browser only ever sees the relative /api-proxy
 * path, which makes every API call same-origin — required so the HttpOnly
 * session cookie (SameSite=Lax) flows in Safari and the LINE in-app browser,
 * where a cross-site cookie to the Railway API domain would be blocked.
 * Set it in Vercel to the deployed API origin (no trailing slash).
 */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@nookeb/shared'],
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

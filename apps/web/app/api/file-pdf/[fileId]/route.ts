import { type NextRequest, NextResponse } from 'next/server';

/**
 * Same-origin PDF byte stream for the MOBILE file-preview viewer.
 *
 * Why this exists: on iOS Safari / the LINE in-app browser (WKWebView) a native
 * <iframe src={pdf}> renders a PDF as a single, non-scrollable page-1 snapshot,
 * so FilePreviewModal renders PDFs with pdf.js there instead — which needs the
 * raw bytes. The bytes live in R2 behind a CROSS-ORIGIN presigned URL; fetching
 * that from the browser needs R2 bucket CORS (infra not in this repo) and a CSP
 * connect-src entry. Two earlier attempts did exactly that and got reverted:
 * without the CORS config the fetch fails silently and the viewer falls back to
 * "open in a new tab" — still broken on-device.
 *
 * This route removes that dependency: the browser fetches SAME-ORIGIN
 * (/api/file-pdf/:id, covered by CSP 'self'), and the Vercel server does the
 * cross-origin work — authorizing via the caller's session cookie against the
 * API, then streaming the presigned R2 object back. Server-to-server fetch has
 * no CORS gate, so no bucket config is required. It is PDF-only and requires the
 * same auth as any file read; it is not a general open proxy.
 *
 * Node runtime (not edge): it streams an upstream Response body, and keeps the
 * cookie-forwarding + streaming behaviour identical across local dev and Vercel.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same default/target as the /api-proxy rewrite in next.config.mjs.
const API_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } },
): Promise<Response> {
  const { fileId } = params;
  if (!fileId || !/^[a-zA-Z0-9-]+$/.test(fileId)) {
    return NextResponse.json({ error: 'bad file id' }, { status: 400 });
  }

  // Forward the caller's session cookie so the API enforces the same access
  // control it does for a normal file read. No cookie → the API 401s and we
  // pass that through.
  const cookie = req.headers.get('cookie') ?? '';

  let meta: { url?: string | null; mimeType?: string };
  try {
    const metaRes = await fetch(`${API_TARGET}/files/${encodeURIComponent(fileId)}`, {
      headers: { cookie },
      cache: 'no-store',
    });
    if (!metaRes.ok) {
      return NextResponse.json({ error: 'not authorized' }, { status: metaRes.status });
    }
    meta = await metaRes.json();
  } catch {
    return NextResponse.json({ error: 'upstream unavailable' }, { status: 502 });
  }

  if (meta.mimeType !== 'application/pdf') {
    return NextResponse.json({ error: 'not a pdf' }, { status: 415 });
  }
  if (!meta.url) {
    return NextResponse.json({ error: 'file not ready' }, { status: 404 });
  }

  // Server-side (no CORS) fetch of the presigned R2 object, streamed back to the
  // browser same-origin. The url comes from OUR trusted API, never user input.
  const upstream = await fetch(meta.url, { cache: 'no-store' });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
  }

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline',
    // The presigned URL already expires; never let a shared cache hold the bytes.
    'Cache-Control': 'private, no-store',
  });
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);

  return new Response(upstream.body, { status: 200, headers });
}

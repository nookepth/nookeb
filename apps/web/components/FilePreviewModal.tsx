'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FileDto } from '@nookeb/shared';
import { getFile, startDownload } from '@/lib/api';
// FIX: download - the preview image must stay long-pressable on iOS (no onContextMenu preventDefault, no pointer-events:none, no -webkit-touch-callout:none anywhere on .preview-media)

function canInline(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/')
  );
}

// Cap the render DPR so a many-page PDF on a 3x phone screen doesn't blow up
// canvas memory (each page still renders crisp at 2x).
const MAX_RENDER_DPR = 2;

/**
 * Multi-page PDF viewer — MOBILE ONLY.
 *
 * On iOS Safari and the LINE in-app browser (WKWebView), a native
 * <iframe src={pdf}> renders a PDF as a single, static, non-scrollable snapshot
 * of page 1 — the reported bug. pdf.js renders every page to its own <canvas>
 * with JS, so all pages are visible, fit-to-width, with vertical scroll inside
 * the modal body. Desktop keeps the native iframe (works correctly there) — this
 * component is only mounted on mobile (see the render branch below).
 *
 * The PDF bytes come from a cross-origin R2 presigned URL, so the fetch below
 * requires CORS on the R2 bucket (GET/HEAD for the web origin — already
 * configured). Fetching the whole file as an ArrayBuffer (rather than letting
 * pdf.js do ranged requests) keeps that CORS requirement minimal.
 */
function PdfViewer({ url }: { url: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [current, setCurrent] = useState(1);
  const [status, setStatus] = useState<'loading' | 'rendering' | 'ready' | 'error'>('loading');

  // 1. Load the document. Dynamic import keeps pdf.js (which touches DOMMatrix
  //    etc. at module init) out of the server render of this client component.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setNumPages(0);
    setCurrent(1);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // Worker served as a same-origin static asset from public/ (copied there
        // by the predev/prebuild hook). Same-origin => allowed by CSP script-src
        // 'self'; and it sidesteps the Next/Terser failure that minifying the
        // webpack-emitted .mjs worker triggers. See scripts/copy-pdf-worker.mjs.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const data = await res.arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjs.getDocument({ data }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        setStatus('rendering');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      void pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [url]);

  // 2. Render EVERY page, sequentially — a render queue: page N only starts
  //    after N-1's render promise resolves, which avoids memory spikes on mobile.
  useEffect(() => {
    if (status !== 'rendering') return;
    const pdf = pdfRef.current;
    const scroller = scrollRef.current;
    if (!pdf || !scroller) return;
    let cancelled = false;
    (async () => {
      const canvases = Array.from(
        scroller.querySelectorAll<HTMLCanvasElement>('canvas[data-canvas]'),
      );
      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return;
        const canvas = canvases[i - 1];
        if (!canvas) continue;
        const page = await pdf.getPage(i);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        // Fit to the page wrapper's content width; height follows from aspect ratio.
        const cssWidth = canvas.parentElement?.clientWidth || scroller.clientWidth || 320;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        // Backing-store resolution in device pixels; CSS width:100% scales it to fit.
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        page.cleanup();
      }
      if (!cancelled) setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [status, numPages]);

  // 3. Page indicator: update "หน้า X / Y" as each page crosses 50% visibility.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || numPages === 0) return;
    const pages = Array.from(scroller.querySelectorAll<HTMLElement>('[data-page]'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (n) setCurrent(n);
          }
        }
      },
      { root: scroller, threshold: 0.5 },
    );
    pages.forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [numPages]);

  if (status === 'error') {
    return (
      <div className="preview-fallback">
        <span className="preview-hint">แสดงตัวอย่าง PDF ในหน้านี้ไม่ได้</span>
        <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
          เปิดไฟล์ในแท็บใหม่
        </a>
      </div>
    );
  }

  return (
    <div className="pdf-viewer-mobile" ref={scrollRef}>
      <div className="pdf-indicator" aria-live="polite">
        {numPages > 0 ? `หน้า ${current} / ${numPages}` : 'กำลังโหลด...'}
      </div>
      {Array.from({ length: numPages }, (_, i) => (
        <div className="pdf-page" data-page={i + 1} key={i}>
          <canvas data-canvas className="pdf-canvas" />
        </div>
      ))}
      {status !== 'ready' && numPages > 0 && (
        <div className="pdf-rendering-hint">กำลังเรนเดอร์หน้า...</div>
      )}
    </div>
  );
}

export interface FilePreviewModalProps {
  /** Files to preview, in display order. One file = plain preview, more = gallery with prev/next. */
  files: FileDto[];
  onClose: () => void;
}

export function FilePreviewModal({ files, onClose }: FilePreviewModalProps) {
  const [index, setIndex] = useState(0);
  // FIX: 2 - iOS Safari needs a long-press to save images (no programmatic download)
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  // FIX: pdf - the native <iframe> PDF viewer works on desktop but renders only a
  // static, non-scrollable page 1 in iOS Safari / the LINE in-app browser
  // (WKWebView). Detect mobile at render time and route PDFs to the pdf.js
  // canvas viewer there while keeping the iframe on desktop. typeof-window guard
  // keeps this SSR-safe (falls back to desktop iframe on the server).
  const isMobile =
    typeof window !== 'undefined' && (window.innerWidth < 768 || 'ontouchstart' in window);
  // fileId → presigned url (null = fetch failed / file not ready → download fallback)
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const file = files[index];

  // Lock background scroll while the modal is open. Pin <body> at the current
  // offset (iOS-safe — plain overflow:hidden still rubber-band-scrolls the page
  // behind the modal) and restore it on close, matching ShareModal's pattern.
  // NOTE: JS owns this pin — do NOT add a CSS body:has(.modal-overlay) rule; it
  // would fire without the saved offset and collapse the page (see globals.css).
  useEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    return () => {
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  useEffect(() => {
    if (!file || file.id in urls || !canInline(file.mimeType)) return;
    let cancelled = false;
    getFile(file.id)
      .then((f) => {
        if (!cancelled) setUrls((prev) => ({ ...prev, [file.id]: f.url }));
      })
      .catch(() => {
        if (!cancelled) setUrls((prev) => ({ ...prev, [file.id]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [file, urls]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(files.length - 1, i + 1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files.length, onClose]);

  if (!file) return null;

  const url = urls[file.id];
  const inline = canInline(file.mimeType);
  const loading = inline && !(file.id in urls);
  const isPdf = file.mimeType === 'application/pdf';
  // Mobile-only pdf.js path; desktop PDFs stay on the native iframe.
  const usePdfViewer = isPdf && isMobile;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <span className="preview-name">{file.name}</span>
          {files.length > 1 && (
            <span className="preview-counter">
              {index + 1} / {files.length}
            </span>
          )}
          <button className="icon-btn preview-close" aria-label="ปิด" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={`preview-body${usePdfViewer && url ? ' preview-body-pdf' : ''}`}>
          {loading ? (
            <span className="preview-hint">กำลังโหลด...</span>
          ) : inline && url && file.mimeType.startsWith('image/') ? (
            // FIX: download - iOS: drop the navigator.share button (it silently fails in LINE after an await); show the image + a persistent long-press hint instead
            <div className="preview-image-wrap">
              <img className="preview-media" src={url} alt={file.name} />
              {isIOS && (
                // FIX: download - sticky hint pinned to the bottom of the scroll container so it's never cut off below the viewport
                <div
                  style={{
                    position: 'sticky',
                    bottom: 0,
                    width: '100%',
                    backgroundColor: '#f9fafb',
                    borderTop: '1px solid #e5e7eb',
                    padding: '10px 16px',
                    textAlign: 'center',
                    fontSize: '14px',
                    color: '#6b7280',
                    zIndex: 10,
                  }}
                >
                  กดค้างที่รูปภาพ แล้วเลือก บันทึกรูปภาพ เพื่อบันทึกลงเครื่อง
                </div>
              )}
            </div>
          ) : inline && url && usePdfViewer ? (
            // FIX: pdf - MOBILE ONLY: render all pages via pdf.js. The native
            // <iframe> below shows only page 1 (non-scrollable) on iOS / the LINE
            // in-app browser. Desktop still uses the iframe (the next branch).
            <PdfViewer key={file.id} url={url} />
          ) : inline && url ? (
            // PDFs and text files render in a native browser viewer via <iframe>.
            // On desktop this gives the built-in PDF UI (page thumbnails + zoom).
            <iframe className="preview-frame" src={url} title={file.name} />
          ) : (
            <div className="preview-fallback">
              <span className="preview-hint">ดูไฟล์ชนิดนี้ในหน้านี้ไม่ได้</span>
              <button className="btn" onClick={() => void startDownload(file.id)}>
                ดาวน์โหลดไฟล์
              </button>
            </div>
          )}
        </div>

        {files.length > 1 && (
          <div className="preview-nav">
            <button
              className="btn secondary"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              ก่อนหน้า
            </button>
            <button
              className="btn secondary"
              disabled={index === files.length - 1}
              onClick={() => setIndex((i) => Math.min(files.length - 1, i + 1))}
            >
              ถัดไป
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { PDFDocument } from 'pdf-lib';

/**
 * ระบบรวมไฟล์ PDF (migration 044) — pure PDF concatenation helpers.
 *
 * Deliberately env-free and dependency-light (pdf-lib only, no binaries — no
 * ghostscript/poppler): everything here is unit-testable and safe to call from
 * both the API (validation at accept time) and the worker (the actual merge).
 *
 * Distinct from `buildScanPdf` in scan-enhance.service, which builds a PDF *from
 * images*. This one copies pages out of existing PDFs.
 */

/** Max source PDFs in one merge — a soft sanity bound, not a business rule. */
export const MAX_MERGE_SOURCES = 50;

/** Why a source PDF was rejected. Copy for each lives in the caller. */
export type PdfRejectReason = 'not_pdf' | 'encrypted' | 'corrupt' | 'empty';

export class PdfSourceError extends Error {
  constructor(
    readonly reason: PdfRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'PdfSourceError';
  }
}

/** `%PDF-` magic bytes. Checked on the BYTES, never on the client's filename. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** `\x89PNG\r\n\x1a\n` magic bytes — distinguishes PNG from JPEG for embedding. */
export function looksLikePng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n';
}

// A4 in PDF points (210×297 mm at 72 dpi) — matches buildScanPdf so an image
// merged into a รวมไฟล์ session looks the same as one from รวมรูป.
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

/**
 * Load one source PDF, converting every failure mode into a typed
 * {@link PdfSourceError} so a damaged/encrypted upload produces a clear message
 * instead of an unhandled throw that BullMQ would retry three times.
 *
 * `ignoreEncryption` is deliberately NOT set: pdf-lib would then "load" an
 * encrypted document whose page content streams are still ciphertext, and the
 * merged PDF would come out silently blank. Better to reject it by name.
 */
export async function loadSourcePdf(buf: Buffer): Promise<PDFDocument> {
  if (!looksLikePdf(buf)) {
    throw new PdfSourceError('not_pdf', 'buffer does not start with %PDF-');
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // pdf-lib throws EncryptedPDFError for password-protected documents.
    const encrypted = /encrypt/i.test(msg) || /password/i.test(msg);
    throw new PdfSourceError(encrypted ? 'encrypted' : 'corrupt', msg);
  }
  if (doc.getPageCount() === 0) {
    throw new PdfSourceError('empty', 'PDF has no pages');
  }
  return doc;
}

/**
 * Concatenate source PDFs (in the given order) into one document. Page size and
 * orientation are preserved per source page — unlike the image merge, nothing is
 * re-laid-out onto A4.
 *
 * Throws {@link PdfSourceError} for a bad source (caller decides whether that's
 * user error or a retryable fault) and plain Errors for anything else.
 */
export async function mergePdfs(sources: Buffer[]): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error('mergePdfs: no source PDFs');

  const out = await PDFDocument.create();
  for (const src of sources) {
    const doc = await loadSourcePdf(src);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}

/**
 * Merge a MIXED, order-preserving list of sources into one PDF: each source is
 * either a whole PDF (its pages copied in, keeping their own size/orientation)
 * or a raster image (JPEG/PNG — embedded fitted+centered on an A4 page). Powers
 * the unified "หนูเก็บรวมไฟล์" flow, which accepts both images and PDFs.
 *
 * PDF sources go through {@link loadSourcePdf} (typed rejection); image sources
 * are embedded with pdf-lib's embedJpg/embedPng (still pdf-lib only — no sharp,
 * so this stays pure/unit-testable). No OCR layer: source PDFs carry their own,
 * and image pages are image-only (same as รวมรูป with OCR off).
 */
export async function mergeMixedToPdf(sources: Buffer[]): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error('mergeMixedToPdf: no sources');

  const out = await PDFDocument.create();
  for (const src of sources) {
    if (looksLikePdf(src)) {
      const doc = await loadSourcePdf(src);
      const pages = await out.copyPages(doc, doc.getPageIndices());
      for (const page of pages) out.addPage(page);
      continue;
    }
    // Raster image → one A4 page, aspect-fitted and centered.
    const img = looksLikePng(src) ? await out.embedPng(src) : await out.embedJpg(src);
    const scale = Math.min(A4_WIDTH_PT / img.width, A4_HEIGHT_PT / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = out.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    page.drawImage(img, { x: (A4_WIDTH_PT - w) / 2, y: (A4_HEIGHT_PT - h) / 2, width: w, height: h });
  }
  return out.save();
}

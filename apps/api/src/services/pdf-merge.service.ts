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

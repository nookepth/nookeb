import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { PdfSourceError, loadSourcePdf, looksLikePdf, mergePdfs } from './pdf-merge.service';

/** A minimal valid PDF with `pageCount` pages of the given size. */
async function makePdf(pageCount: number, size: [number, number] = [595, 842]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage(size);
  return Buffer.from(await doc.save());
}

test('looksLikePdf: magic bytes, not the filename', async () => {
  assert.equal(looksLikePdf(await makePdf(1)), true);
  assert.equal(looksLikePdf(Buffer.from('not a pdf at all')), false);
  assert.equal(looksLikePdf(Buffer.from('%PDF')), false); // too short — needs the dash
  assert.equal(looksLikePdf(Buffer.alloc(0)), false);
});

test('loadSourcePdf: rejects non-PDF bytes as not_pdf', async () => {
  await assert.rejects(
    () => loadSourcePdf(Buffer.from('\x89PNG\r\n\x1a\n pretending to be a doc.pdf')),
    (err: unknown) => err instanceof PdfSourceError && err.reason === 'not_pdf',
  );
});

test('loadSourcePdf: rejects truncated/corrupt PDF without throwing raw', async () => {
  const truncated = (await makePdf(2)).subarray(0, 40); // header survives, body doesn't
  await assert.rejects(
    () => loadSourcePdf(truncated),
    (err: unknown) => err instanceof PdfSourceError && err.reason === 'corrupt',
  );
});

// The 'empty' guard is defensive: pdf-lib's own save() of a page-less document
// round-trips as a 1-page PDF, so a zero-page file can only arrive from an
// externally crafted document. Pin the round-trip behaviour so a pdf-lib upgrade
// that starts emitting genuinely page-less output is caught here.
test('loadSourcePdf: a pdf-lib empty document round-trips as one page', async () => {
  const doc = await PDFDocument.create();
  const loaded = await loadSourcePdf(Buffer.from(await doc.save()));
  assert.equal(loaded.getPageCount(), 1);
});

test('mergePdfs: concatenates page counts in the given order', async () => {
  const merged = await mergePdfs([await makePdf(2), await makePdf(1), await makePdf(3)]);
  const out = await PDFDocument.load(merged);
  assert.equal(out.getPageCount(), 6);
});

test('mergePdfs: preserves each source page size (no A4 re-layout)', async () => {
  const a4: [number, number] = [595, 842];
  const wide: [number, number] = [1000, 400];
  const merged = await mergePdfs([await makePdf(1, a4), await makePdf(1, wide)]);
  const out = await PDFDocument.load(merged);
  const sizes = out.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  assert.deepEqual(sizes, [a4, wide]);
});

test('mergePdfs: a single source round-trips', async () => {
  const merged = await mergePdfs([await makePdf(4)]);
  assert.equal((await PDFDocument.load(merged)).getPageCount(), 4);
});

test('mergePdfs: surfaces a bad source as PdfSourceError, not a raw throw', async () => {
  const good = await makePdf(1);
  await assert.rejects(
    () => mergePdfs([good, Buffer.from('garbage')]),
    (err: unknown) => err instanceof PdfSourceError && err.reason === 'not_pdf',
  );
});

test('mergePdfs: empty input is a programming error, not a PdfSourceError', async () => {
  await assert.rejects(
    () => mergePdfs([]),
    (err: unknown) => err instanceof Error && !(err instanceof PdfSourceError),
  );
});

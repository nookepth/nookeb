import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  processScanPage,
  plainNormalize,
  MSG_EDGE_FAILED,
  MSG_TOO_DARK,
} from './scan-enhance.service';

// Synthetic fixtures rendered with sharp from SVG — no binary test assets.

/** A document photo taken straight-on: white page on a dark desk, fake text lines. */
function straightOnSvg(): Buffer {
  const lines = Array.from(
    { length: 12 },
    (_, i) => `<rect x="250" y="${180 + i * 45}" width="${680 - (i % 3) * 120}" height="16" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#4a4038"/>
      <rect x="150" y="100" width="900" height="700" fill="#fdfdfb"/>
      ${lines}
    </svg>`,
  );
}

/** The same page photographed at an angle: a perspective-skewed quadrilateral. */
function angledSvg(): Buffer {
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#453c33"/>
      <polygon points="320,140 1000,220 900,780 210,680" fill="#fcfcfa"/>
      <polygon points="420,260 860,300 830,420 400,370" fill="#101010"/>
      <polygon points="410,430 880,470 860,540 400,500" fill="#101010"/>
    </svg>`,
  );
}

/** Uniform dark frame — fails the brightness gate (mean < 30). */
function darkSvg(): Buffer {
  return Buffer.from(
    `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="600" fill="#0a0a0a"/>
    </svg>`,
  );
}

/** A plain desk: mild gradient, no document edges at all. */
function noDocumentSvg(): Buffer {
  return Buffer.from(
    `<svg width="1000" height="750" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8a7a68"/><stop offset="1" stop-color="#7a6c5c"/>
      </linearGradient></defs>
      <rect width="1000" height="750" fill="url(#g)"/>
    </svg>`,
  );
}

const toJpeg = (svg: Buffer): Promise<Buffer> => sharp(svg).jpeg({ quality: 90 }).toBuffer();

test('Test 1 — straight-on photo: corners detected, clean BW output, valid image', async () => {
  const result = await processScanPage(await toJpeg(straightOnSvg()), 'bw', 'test=straight');
  assert.equal(result.edgeDetection, 'detected');
  assert.ok(!result.warnings.includes(MSG_EDGE_FAILED));

  const meta = await sharp(result.jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  // Warp output ≈ the page rect (900×700), not the full 1200×900 frame
  assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 900 / 700) < 0.15);

  // BW mode: output is (near-)bimodal — dominated by black + white extremes
  const { data, info } = await sharp(result.jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  let extremes = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const v = data[i]!;
    if (v < 32 || v > 224) extremes++;
  }
  assert.ok(extremes / (info.width * info.height) > 0.9, 'BW output should be mostly pure black/white');
});

test('Test 2 — angled photo: perspective corrected to a flat rectangle', async () => {
  const result = await processScanPage(await toJpeg(angledSvg()), 'color', 'test=angled');
  assert.equal(result.edgeDetection, 'detected');
  const meta = await sharp(result.jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  // The warped output must be the quad's bounds, meaningfully smaller than the frame
  assert.ok((meta.width ?? 0) < 1200 && (meta.height ?? 0) < 900);
  assert.ok((meta.width ?? 0) > 400 && (meta.height ?? 0) > 300);
});

test('Test 3 — low-light photo: brightness gate warns, page still produced', async () => {
  const result = await processScanPage(await toJpeg(darkSvg()), 'bw', 'test=dark');
  assert.ok(result.warnings.includes(MSG_TOO_DARK), 'expected the too-dark warning');
  const meta = await sharp(result.jpeg).metadata();
  assert.equal(meta.format, 'jpeg'); // never dropped
});

test('Test 4 — no document: fallback to full image bounds, no throw', async () => {
  const input = await toJpeg(noDocumentSvg());
  const result = await processScanPage(input, 'color', 'test=nodoc');
  assert.equal(result.edgeDetection, 'fallback');
  assert.ok(result.warnings.includes(MSG_EDGE_FAILED), 'expected the edge-detection warning');
  const meta = await sharp(result.jpeg).metadata();
  // Full-bounds fallback keeps the frame's aspect ratio
  assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 1000 / 750) < 0.05);
});

test('plainNormalize matches the pre-feature contract (flag-off path)', async () => {
  const out = await plainNormalize(await toJpeg(straightOnSvg()));
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1200); // bounded at 1600, no enlargement
});

// Test 5 (retry safety, BL-8 mirror) lives in the finalize_scan handler, which
// short-circuits on scan_sessions.result_file_id before any rebuild — that path
// needs a DB and is covered by the existing idempotency design (see
// upload.worker.ts processFinalizeScan + scan.service setSessionResultFile).
// Here we cover the service-level invariant instead: reprocessing the same
// input is deterministic-safe (no state, same shape of result).
test('Test 5 — reprocessing the same page is safe (stateless, no throw)', async () => {
  const input = await toJpeg(angledSvg());
  const a = await processScanPage(input, 'bw', 'test=retry-a');
  const b = await processScanPage(input, 'bw', 'test=retry-b');
  assert.equal(a.edgeDetection, b.edgeDetection);
  const [ma, mb] = [await sharp(a.jpeg).metadata(), await sharp(b.jpeg).metadata()];
  assert.equal(ma.width, mb.width);
  assert.equal(ma.height, mb.height);
});

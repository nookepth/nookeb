import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processScanPage, plainNormalize, buildScanPdf, MSG_TOO_DARK } from './scan-enhance.service';
import { extractText, terminateOcr } from './ocr.service';

/**
 * The retired "ไม่สามารถตรวจจับขอบเอกสารได้…" copy. Asserted on by SUBSTRING
 * rather than by importing a constant, precisely because the constant is gone:
 * this pins "no edge-detection complaint ever reaches the user", which a
 * re-added constant under any new name would still have to satisfy.
 */
const EDGE_COMPLAINT = 'ตรวจจับขอบเอกสาร';
const hasEdgeComplaint = (warnings: string[]): boolean =>
  warnings.some((w) => w.includes(EDGE_COMPLAINT));

// The tesseract singleton (Test 8) holds worker threads open — terminate it so
// the test process can exit.
test.after(async () => {
  await terminateOcr();
});

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
  assert.ok(!hasEdgeComplaint(result.warnings));
  // A correct first-pass crop needs no re-crop and leaves a clean border
  assert.equal(result.refinePasses, 0);
  assert.ok(result.borderDirty < 0.22, `expected a clean border, got ${result.borderDirty}`);

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

test('Test 4 — no document: fallback to full image bounds, no throw, NO user warning', async () => {
  const input = await toJpeg(noDocumentSvg());
  const result = await processScanPage(input, 'color', 'test=nodoc');
  assert.equal(result.edgeDetection, 'fallback');
  // ISSUE 1: detection failure must never produce a user-facing message
  assert.ok(!hasEdgeComplaint(result.warnings), 'edge-detection failure must not warn the user');
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

// --- Feature upgrade: improved detection (aspect gate + adaptive pass) + OCR PDF ---

/** A degenerate sliver: bright, big enough area, but paper-unlike aspect (~6:1). */
function sliverSvg(): Buffer {
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#453c33"/>
      <rect x="0" y="350" width="1200" height="200" fill="#fcfcfa"/>
    </svg>`,
  );
}

/** Low-contrast: near-white page on a light desk — too weak for Canny 75/200. */
function lowContrastSvg(): Buffer {
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#beb8ae"/>
      <rect x="180" y="120" width="840" height="660" fill="#ccc6bb"/>
    </svg>`,
  );
}

test('Test 6 — paper-unlike sliver quad is rejected (aspect-ratio gate → fallback)', async () => {
  const result = await processScanPage(await toJpeg(sliverSvg()), 'color', 'test=sliver');
  assert.equal(result.edgeDetection, 'fallback');
  assert.ok(!hasEdgeComplaint(result.warnings));
  const meta = await sharp(result.jpeg).metadata();
  // Fallback keeps the full frame, not the sliver
  assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 1200 / 900) < 0.05);
});

test('Test 7 — low-contrast page: adaptive-threshold second pass detects it', async () => {
  const result = await processScanPage(await toJpeg(lowContrastSvg()), 'color', 'test=lowcontrast');
  assert.equal(result.edgeDetection, 'detected');
  const meta = await sharp(result.jpeg).metadata();
  // Warp output ≈ the page rect (840×660), meaningfully smaller than the frame
  assert.ok((meta.width ?? 0) < 1200 && (meta.height ?? 0) < 900);
  assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 840 / 660) < 0.2);
});

// --- ISSUE 2 / ISSUE 3: tight crops on cluttered backgrounds ----------------

/** Mean luma of a small box, as a fraction of the frame. Used to ask "is this
 *  corner paper, or is it still the desk?" */
async function cornerLuma(
  jpeg: Buffer,
  corner: 'tl' | 'tr' | 'bl' | 'br',
  box = 0.06,
): Promise<number> {
  const { data, info } = await sharp(jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  const bw = Math.max(1, Math.round(info.width * box));
  const bh = Math.max(1, Math.round(info.height * box));
  const x0 = corner === 'tl' || corner === 'bl' ? 0 : info.width - bw;
  const y0 = corner === 'tl' || corner === 'tr' ? 0 : info.height - bh;
  let sum = 0;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) sum += data[y * info.width + x]!;
  return sum / (bw * bh);
}

/**
 * A page on a WOOD-GRAIN table — the real failing case (see the reported scan).
 * The grain gives Canny edges across the entire frame; dilated, they close into
 * one frame-sized contour that used to win on area, warp ≈ identity, and ship
 * the whole table inside the "scan". MAX_QUAD_AREA_RATIO rejects it so the
 * search falls through to the page.
 */
function woodTableSvg(): Buffer {
  const grain = Array.from(
    { length: 45 },
    (_, i) => `<rect x="0" y="${i * 20}" width="1200" height="9" fill="#5e3417"/>`,
  ).join('');
  const lines = Array.from(
    { length: 12 },
    (_, i) => `<rect x="230" y="${200 + i * 48}" width="${700 - (i % 3) * 130}" height="15" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#7a4a22"/>
      ${grain}
      <rect x="140" y="110" width="900" height="690" fill="#fdfdfb"/>
      ${lines}
    </svg>`,
  );
}

/**
 * Page on a dark-green placemat on a desk: the placemat is the LARGEST quad, so
 * the first pass legitimately crops to it. Only the post-crop border check can
 * notice that the result is still not the document.
 */
function placematSvg(): Buffer {
  const lines = Array.from(
    { length: 9 },
    (_, i) => `<rect x="290" y="${260 + i * 52}" width="${540 - (i % 3) * 90}" height="14" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#d2cec6"/>
      <rect x="100" y="70" width="1000" height="760" fill="#2e6b4f"/>
      <rect x="250" y="180" width="700" height="540" fill="#fdfdfb"/>
      ${lines}
    </svg>`,
  );
}

/** A whole sheet photographed at an angle, not filling the frame (Issue 3). */
function rotatedPageSvg(): Buffer {
  const lines = Array.from(
    { length: 10 },
    (_, i) => `<rect x="280" y="${230 + i * 46}" width="${620 - (i % 3) * 110}" height="14" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#3a332c"/>
      <g transform="rotate(8 600 450)">
        <rect x="220" y="170" width="760" height="560" fill="#fdfdfb"/>
        ${lines}
      </g>
    </svg>`,
  );
}

/** A portrait page lying on its side: landscape frame, text lines running
 *  VERTICALLY. Should be turned upright. */
function sidewaysPageSvg(): Buffer {
  const lines = Array.from(
    { length: 12 },
    (_, i) => `<rect x="${240 + i * 52}" width="15" y="180" height="${520 - (i % 3) * 90}" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#3a332c"/>
      <rect x="180" y="140" width="860" height="620" fill="#fdfdfb"/>
      ${lines}
    </svg>`,
  );
}

/** Control for the above: a GENUINELY landscape document. Must not be turned. */
function landscapeDocSvg(): Buffer {
  const lines = Array.from(
    { length: 9 },
    (_, i) => `<rect x="240" y="${200 + i * 56}" width="${740 - (i % 3) * 120}" height="15" fill="#151515"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="900" fill="#3a332c"/>
      <rect x="180" y="140" width="860" height="620" fill="#fdfdfb"/>
      ${lines}
    </svg>`,
  );
}

test('Test 14 — wood-grain table: the frame-sized contour loses, the page wins', async () => {
  const result = await processScanPage(await toJpeg(woodTableSvg()), 'color', 'test=wood');
  assert.equal(result.edgeDetection, 'detected');
  const meta = await sharp(result.jpeg).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  // The page is 900x690 of a 1200x900 frame. Before MAX_QUAD_AREA_RATIO the
  // grain's frame-sized contour won and the output kept the 1200x900 aspect.
  assert.ok(w < 1150 && h < 870, `expected a real crop, got ${w}x${h}`);
  assert.ok(
    Math.abs(w / h - 900 / 690) < 0.2,
    `expected the page's aspect (${(900 / 690).toFixed(2)}), got ${(w / h).toFixed(2)}`,
  );
  // ...and no table left in the corners
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    assert.ok(
      (await cornerLuma(result.jpeg, corner)) > 190,
      `${corner} corner still shows the table`,
    );
  }
  assert.ok(result.borderDirty < 0.22, `expected a clean border, got ${result.borderDirty}`);
});

test('Test 15 — placemat: a loose first crop is re-cropped to the document', async () => {
  const result = await processScanPage(await toJpeg(placematSvg()), 'color', 'test=placemat');
  assert.equal(result.edgeDetection, 'detected');
  // The placemat (1000x760) is the largest quad, so pass 1 crops to it; only
  // the border check can see that the result is not yet the document.
  assert.ok(result.refinePasses >= 1, 'expected at least one post-crop refinement');
  assert.ok(result.refinePasses <= 2, 'refinement must stay inside its budget');
  assert.ok(result.borderDirty < 0.22, `expected the re-crop to clean the border, got ${result.borderDirty}`);
  const meta = await sharp(result.jpeg).metadata();
  assert.ok(
    Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 700 / 540) < 0.2,
    `expected the page's aspect, got ${((meta.width ?? 0) / (meta.height ?? 1)).toFixed(2)}`,
  );
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    assert.ok((await cornerLuma(result.jpeg, corner)) > 190, `${corner} corner still shows the placemat`);
  }
});

test('Test 16 — sheet photographed at an angle: deskewed by the warp (Issue 3)', async () => {
  const result = await processScanPage(await toJpeg(rotatedPageSvg()), 'color', 'test=rotated');
  assert.equal(result.edgeDetection, 'detected');
  const meta = await sharp(result.jpeg).metadata();
  assert.ok(
    Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 760 / 560) < 0.2,
    `expected the page's aspect, got ${((meta.width ?? 0) / (meta.height ?? 1)).toFixed(2)}`,
  );
  // A page left tilted inside an axis-aligned crop keeps DESK in its corners.
  // Paper in all four corners is what proves the rotation was taken out.
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    assert.ok(
      (await cornerLuma(result.jpeg, corner)) > 190,
      `${corner} corner still shows the desk — page not straightened`,
    );
  }
});

test('Test 17 — sideways page: vertical text lines trigger the quarter turn', async () => {
  const result = await processScanPage(await toJpeg(sidewaysPageSvg()), 'color', 'test=sideways');
  assert.equal(result.quarterTurn, true, 'expected the sideways page to be turned upright');
  const meta = await sharp(result.jpeg).metadata();
  assert.ok((meta.height ?? 0) > (meta.width ?? 0), 'expected a portrait result after the turn');
});

test('Test 18 — a genuinely landscape document is NOT turned', async () => {
  const result = await processScanPage(await toJpeg(landscapeDocSvg()), 'color', 'test=landscape');
  assert.equal(result.quarterTurn, false, 'a landscape document must be left alone');
  const meta = await sharp(result.jpeg).metadata();
  assert.ok((meta.width ?? 0) > (meta.height ?? 0), 'expected the landscape result to stay landscape');
});

test('Test 19 — refinement is capped and terminates (no runaway re-cropping)', async () => {
  // Every fixture in this file, including the ones designed to be ambiguous,
  // must settle inside the budget. This is the loop guard, asserted directly.
  for (const [name, svg] of [
    ['wood', woodTableSvg()],
    ['placemat', placematSvg()],
    ['rotated', rotatedPageSvg()],
    ['nodoc', noDocumentSvg()],
    ['sliver', sliverSvg()],
  ] as const) {
    const result = await processScanPage(await toJpeg(svg), 'bw', `test=cap-${name}`);
    assert.ok(
      result.refinePasses >= 0 && result.refinePasses <= 2,
      `${name}: refinePasses out of budget (${result.refinePasses})`,
    );
  }
});

/**
 * The page from straightOnSvg with a strong diagonal shadow across the paper —
 * the classic real-phone-photo condition. The old global threshold(165) turned
 * the shadowed part of the WHITE paper solid black.
 */
function shadowedDocSvg(): Buffer {
  const lines = Array.from(
    { length: 14 },
    (_, i) => `<rect x="260" y="${190 + i * 42}" width="${660 - (i % 3) * 110}" height="14" fill="#1c1c1c"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="shadow" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity="0"/>
        <stop offset="0.55" stop-color="#000000" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.6"/>
      </linearGradient></defs>
      <rect width="1200" height="900" fill="#4a4038"/>
      <rect x="150" y="100" width="900" height="700" fill="#fdfdfb"/>
      ${lines}
      <rect width="1200" height="900" fill="url(#shadow)"/>
    </svg>`,
  );
}

/** Faint thermal-receipt print: light-gray ink the old threshold(165) ERASED. */
function faintReceiptSvg(): Buffer {
  const lines = Array.from(
    { length: 16 },
    (_, i) => `<rect x="120" y="${80 + i * 40}" width="${420 - (i % 4) * 60}" height="12" fill="#b4b4b0"/>`,
  ).join('');
  return Buffer.from(
    `<svg width="700" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="700" height="800" fill="#3a352f"/>
      <rect x="60" y="30" width="580" height="740" fill="#f4f2ec"/>
      ${lines}
    </svg>`,
  );
}

test('Test 11 — shadowed photo (bw): paper stays white, shadow removed, text kept', async () => {
  const result = await processScanPage(await toJpeg(shadowedDocSvg()), 'bw', 'test=shadow-bw');
  const { data, info } = await sharp(result.jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let black = 0;
  let white = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i]!;
    if (v < 32) black++;
    else if (v > 224) white++;
  }
  // Before the flat-field fix the shadowed half of the page was solid black
  // (black ≈ 40–55%). Now black is text only and the paper is white.
  assert.ok(black / n < 0.2, `expected only text to be dark, got ${((100 * black) / n).toFixed(1)}% black`);
  assert.ok(white / n > 0.6, `expected white paper to dominate, got ${((100 * white) / n).toFixed(1)}% white`);
  assert.ok(black / n > 0.02, 'expected the text itself to survive as dark pixels');

  // The deepest-shadow region (bottom-right quadrant) must be clean white
  // paper + text — not a black blob.
  let brBlack = 0;
  let brCount = 0;
  for (let y = Math.floor(info.height * 0.55); y < info.height * 0.95; y++) {
    for (let x = Math.floor(info.width * 0.55); x < info.width * 0.95; x++) {
      brCount++;
      if (data[y * info.width + x]! < 32) brBlack++;
    }
  }
  assert.ok(
    brBlack / brCount < 0.25,
    `shadowed corner should be mostly white paper, got ${((100 * brBlack) / brCount).toFixed(1)}% black`,
  );
});

test('Test 12 — shadowed photo (color): shadow removed without blackening', async () => {
  const result = await processScanPage(await toJpeg(shadowedDocSvg()), 'color', 'test=shadow-color');
  const { data, info } = await sharp(result.jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let black = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i]!;
    if (v < 32) black++;
    else if (v > 200) bright++;
  }
  assert.ok(black / n < 0.2, `expected only text to be dark, got ${((100 * black) / n).toFixed(1)}% black`);
  assert.ok(bright / n > 0.6, `expected bright paper to dominate, got ${((100 * bright) / n).toFixed(1)}% bright`);
});

test('Test 13 — faint thermal-receipt ink survives bw mode (old threshold erased it)', async () => {
  const result = await processScanPage(await toJpeg(faintReceiptSvg()), 'bw', 'test=faint-bw');
  const { data, info } = await sharp(result.jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let inkish = 0; // meaningfully darker than paper
  let white = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i]!;
    if (v < 200) inkish++;
    if (v > 224) white++;
  }
  // The 16 text lines cover a few % of the page; threshold(165) left <0.5%.
  assert.ok(inkish / n > 0.02, `expected faint text to remain visible, got ${((100 * inkish) / n).toFixed(2)}%`);
  assert.ok(white / n > 0.5, `expected white paper, got ${((100 * white) / n).toFixed(1)}% white`);
});

test('Test 8 — OCR extracts Thai text (tesseract, tha+eng)', async () => {
  // Rendered fixture: large printed Thai on white. Skip (not fail) if the host
  // has no Thai font for SVG rendering — then the fixture would be blank/tofu.
  const svg = Buffer.from(
    `<svg width="1000" height="400" xmlns="http://www.w3.org/2000/svg">
      <rect width="1000" height="400" fill="#ffffff"/>
      <text x="60" y="180" font-family="Leelawadee UI, Tahoma, Noto Sans Thai, sans-serif"
            font-size="96" fill="#000000">สวัสดีประเทศไทย</text>
      <text x="60" y="320" font-family="Arial, sans-serif" font-size="72" fill="#000000">HELLO 123</text>
    </svg>`,
  );
  const png = await sharp(svg).png().toBuffer();
  const stats = await sharp(png).grayscale().stats();
  if ((stats.channels[0]?.mean ?? 255) > 254) {
    console.warn('Test 8 skipped: SVG text did not render (no Thai font on this host)');
    return;
  }
  const text = await extractText(png, 'tha+eng');
  assert.ok(text.length > 0, 'expected non-empty OCR text');
  assert.ok(/[฀-๿]/.test(text), `expected at least one Thai character, got: ${text}`);
});

test('Test 9 — OCR failure does not fail the PDF (image-only fallback)', async () => {
  const page = await toJpeg(straightOnSvg());
  const pdfBytes = await buildScanPdf([page, page], {
    ocrEnabled: true,
    logTag: 'test=ocr-throws',
    ocr: async () => {
      throw new Error('boom: simulated OCR crash');
    },
  });
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), 2);
});

test('Test 9b — a hanging OCR call cannot stall the PDF (per-page timeout → image-only)', async () => {
  const page = await toJpeg(straightOnSvg());
  // OCR that never resolves — before the timeout fix this hung buildScanPdf (and
  // thus the whole finalize_scan job) forever. Now it degrades to image-only.
  const start = Date.now();
  const pdfBytes = await buildScanPdf([page, page], {
    ocrEnabled: true,
    ocrTimeoutMs: 150,
    logTag: 'test=ocr-hang',
    ocr: () => new Promise<never>(() => {}), // never settles
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `expected the build to give up on OCR quickly, took ${elapsed}ms`);
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), 2);
  // No OCR words landed, so no font was embedded (image-only pages).
  const raw = Buffer.from(await pdf.save({ useObjectStreams: false })).toString('latin1');
  assert.ok(!raw.includes('/Helvetica'), 'timed-out OCR must not embed a text layer');
});

test('Test 10 — PDF is searchable: OCR words produce an embedded text layer', async () => {
  const page = await toJpeg(straightOnSvg());
  const pdfBytes = await buildScanPdf([page], {
    ocrEnabled: true,
    logTag: 'test=text-layer',
    ocr: async () => ({
      text: 'HELLO WORLD',
      words: [
        { text: 'HELLO', bbox: { x0: 100, y0: 100, x1: 320, y1: 150 } },
        { text: 'WORLD', bbox: { x0: 340, y0: 100, x1: 560, y1: 150 } },
      ],
    }),
  });
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), 1);
  // A text layer requires an embedded font; the image-only PDF has none.
  // (Re-save without object streams so resource dicts are plaintext-visible.)
  // (pdf-lib always writes an empty /Font resource dict, so assert on the
  // actually-embedded base font instead.)
  const raw = Buffer.from(await pdf.save({ useObjectStreams: false })).toString('latin1');
  assert.ok(raw.includes('/Helvetica'), 'expected an embedded font (text layer) in the PDF');
  // Control: same build without OCR embeds no font
  const plainDoc = await PDFDocument.load(await buildScanPdf([page]));
  const plainRaw = Buffer.from(await plainDoc.save({ useObjectStreams: false })).toString('latin1');
  assert.ok(!plainRaw.includes('/Helvetica'));
});

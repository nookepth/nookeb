import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp, { type Sharp } from 'sharp';
import { PDFDocument, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { ScanMode } from '@nookeb/shared';
import { extractTextDetailed, type OcrPageResult } from './ocr.service';

/**
 * CamScanner-style scan-page pipeline (worker-only — see upload.worker.ts):
 *   Stage 1  edge/contour detection  (OpenCV: Canny → findContours → approxPolyDP)
 *   Stage 2  perspective transform   (OpenCV: getPerspectiveTransform → warpPerspective)
 *   Stage 3  color enhancement       (sharp: 'bw' threshold or 'color' normalize/sharpen)
 *
 * OpenCV is the WASM build (@techstark/opencv-js) — no native compile, so it
 * installs cleanly on Railway nixpacks and the Alpine Dockerfile. Its scope is
 * kept minimal (detection + warp + blur metric); all encoding/enhancement is sharp.
 *
 * processScanPage NEVER throws: any stage failure degrades to the plain
 * normalized image (the pre-feature behavior), and detection failure falls back
 * to full image bounds. Everything runs on in-memory buffers — no temp files.
 */

// The module is a thenable that resolves to the initialized cv namespace once
// the WASM runtime is up. Loaded lazily (same pattern as getTesseract) so the
// ~10 MB WASM is only instantiated in worker processes that actually scan.
import cvModule from '@techstark/opencv-js';
type CV = typeof cvModule;

let cvPromise: Promise<CV> | null = null;
function getOpenCV(): Promise<CV> {
  if (!cvPromise) {
    cvPromise = Promise.resolve(cvModule as unknown as PromiseLike<CV>).then(() => cvModule);
  }
  return cvPromise;
}

// Quality gates (thresholds fixed by spec)
const MIN_BRIGHTNESS = 30; // mean gray level below this → "too dark"
const MIN_BLUR_VARIANCE = 100; // Laplacian variance below this → "too blurry"
// A detected quad must cover at least this fraction of the frame to be trusted
// (tiny quads are usually text blocks or noise, not the page outline).
const MIN_QUAD_AREA_RATIO = 0.2;
// Paper-likeness gate: the warped width/height ratio of an accepted quad.
// Loose bounds on purpose — A4 is 0.71/1.41 but long receipts are legitimate;
// this only rejects degenerate slivers (e.g. a lone text line or table rule).
const MIN_QUAD_ASPECT = 0.2;
const MAX_QUAD_ASPECT = 5;
const PAGE_WIDTH = 1600; // normalized page width (matches the previous behavior)
const JPEG_QUALITY = 85;

// User-facing Thai copy (pushed by the worker, defined here next to the checks)
export const MSG_EDGE_FAILED =
  'ไม่สามารถตรวจจับขอบเอกสารได้ กรุณาถ่ายภาพใหม่โดยให้เห็นขอบกระดาษทั้ง 4 ด้านชัดเจน';
export const MSG_TOO_DARK = 'ภาพมืดเกินไป กรุณาถ่ายในที่ที่มีแสงสว่างเพียงพอ';
export const MSG_TOO_BLURRY = 'ภาพไม่ชัด กรุณาถ่ายใหม่และถือกล้องให้นิ่ง';
export const MSG_PDF_FAILED = 'เกิดข้อผิดพลาดในการสร้าง PDF กรุณาลองใหม่อีกครั้ง';

export interface EnhanceResult {
  jpeg: Buffer;
  /** Which Stage-1 path ran: quad found, full-bounds fallback, or pipeline skipped. */
  edgeDetection: 'detected' | 'fallback' | 'skipped';
  /** User-facing Thai warnings (quality gates / detection failure). Never fatal. */
  warnings: string[];
}

interface Point {
  x: number;
  y: number;
}

/** Order 4 corners TL, TR, BR, BL (sum/diff heuristic — standard 4-point warp prep). */
function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0]!, byDiff[0]!, bySum[3]!, byDiff[3]!]; // TL, TR, BR, BL
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Paper-likeness check: the quad's warped width/height ratio must be sane. */
function quadAspectOk(pts: Point[]): boolean {
  const [tl, tr, br, bl] = orderCorners(pts);
  const width = Math.max(dist(tl, tr), dist(bl, br));
  const height = Math.max(1, Math.max(dist(tl, bl), dist(tr, br)));
  const ratio = width / height;
  return ratio >= MIN_QUAD_ASPECT && ratio <= MAX_QUAD_ASPECT;
}

/**
 * Largest convex 4-point contour in a binary (edge/threshold) image that
 * passes the area + aspect gates. Shared by both detection passes.
 */
function bestQuadFromBinary(cv: CV, binary: InstanceType<CV['Mat']>, minArea: number): Point[] | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best: Point[] | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const area = cv.contourArea(contour);
        if (area < minArea || area <= bestArea) continue;
        cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts: Point[] = [];
          for (let r = 0; r < 4; r++) {
            pts.push({ x: approx.data32S[r * 2]!, y: approx.data32S[r * 2 + 1]! });
          }
          if (!quadAspectOk(pts)) continue;
          best = pts;
          bestArea = area;
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    return best;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Stage 1: find the document's 4-corner outline. Two passes:
 *   1. Canny → dilate (strong page/background contrast — the common case)
 *   2. adaptive threshold (negative C highlights local edge bands) — catches
 *      low-contrast pages Canny misses, e.g. white paper on a light desk
 * Returns null when neither pass yields a convincing quad (caller falls back
 * to full image bounds).
 */
function detectDocumentQuad(
  cv: CV,
  rgba: InstanceType<CV['Mat']>,
): { corners: Point[]; pass: 'canny' | 'adaptive' } | null {
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const minArea = rgba.cols * rgba.rows * MIN_QUAD_AREA_RATIO;
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    try {
      // Pass 1: Canny + dilate (close small gaps so the outline survives approxPolyDP)
      cv.Canny(gray, binary, 75, 200);
      cv.dilate(binary, binary, kernel);
      const canny = bestQuadFromBinary(cv, binary, minArea);
      if (canny) return { corners: canny, pass: 'canny' };

      // Pass 2: adaptive threshold. C < 0 marks pixels brighter than their local
      // mean — on a low-contrast photo that traces the page boundary as a band.
      cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, -2);
      cv.dilate(binary, binary, kernel);
      const adaptive = bestQuadFromBinary(cv, binary, minArea);
      if (adaptive) return { corners: adaptive, pass: 'adaptive' };
      return null;
    } finally {
      kernel.delete();
    }
  } finally {
    gray.delete();
    binary.delete();
  }
}

/** Stage 2: warp the quad to a flat upright rectangle. Returns a new RGBA Mat. */
function warpToQuad(
  cv: CV,
  rgba: InstanceType<CV['Mat']>,
  corners: Point[],
): { mat: InstanceType<CV['Mat']>; width: number; height: number } {
  const [tl, tr, br, bl] = orderCorners(corners);
  const width = Math.max(2, Math.round(Math.max(dist(tl, tr), dist(bl, br))));
  const height = Math.max(2, Math.round(Math.max(dist(tl, bl), dist(tr, br))));

  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const M = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(rgba, out, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  } catch (err) {
    out.delete();
    throw err;
  } finally {
    src.delete();
    dst.delete();
    M.delete();
  }
  return { mat: out, width, height };
}

/** Mean brightness + Laplacian variance (focus measure) of the frame. */
function assessQuality(cv: CV, rgba: InstanceType<CV['Mat']>): { brightness: number; blurVariance: number } {
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const brightness = cv.mean(gray)[0] ?? 0;
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    const sd = stddev.data64F[0] ?? 0;
    return { brightness, blurVariance: sd * sd };
  } finally {
    gray.delete();
    lap.delete();
    mean.delete();
    stddev.delete();
  }
}

/**
 * Stage 3, mode 'bw': grayscale → normalize (CLAHE-equivalent contrast stretch)
 * → sharpen → global threshold. Approximates adaptive thresholding with sharp
 * (per spec: OpenCV scope stays minimal).
 */
function enhanceBw(pipeline: Sharp): Sharp {
  return pipeline.grayscale().normalise({ lower: 2, upper: 98 }).sharpen({ sigma: 1 }).threshold(165);
}

/**
 * Stage 3, mode 'color': contrast normalize + sharpen + gray-world white balance
 * (channel gains toward equal means), for documents with color/images.
 */
async function enhanceColor(pipeline: Sharp): Promise<Sharp> {
  const stats = await pipeline.clone().stats();
  const [r, g, b] = stats.channels;
  const grayMean = ((r?.mean ?? 128) + (g?.mean ?? 128) + (b?.mean ?? 128)) / 3;
  const gain = (mean: number | undefined): number =>
    Math.min(1.4, Math.max(0.7, grayMean / Math.max(1, mean ?? grayMean)));
  return pipeline
    .linear([gain(r?.mean), gain(g?.mean), gain(b?.mean)], [0, 0, 0])
    .normalise({ lower: 1, upper: 99 })
    .sharpen({ sigma: 0.8 });
}

/** The pre-feature behavior: EXIF-rotate + bound width + JPEG. Used as the safety net. */
export async function plainNormalize(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: PAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * Run the full stage 1–3 pipeline on one scan page. Any pipeline failure
 * degrades to plainNormalize(input) — a decodable image is always stored. Only
 * an input sharp itself can't decode still throws (correct: the job retries and
 * re-downloads from the LINE CDN). `logTag` prefixes the observability lines.
 */
export async function processScanPage(
  input: Buffer,
  mode: ScanMode,
  logTag = '',
): Promise<EnhanceResult> {
  const warnings: string[] = [];
  try {
    const cv = await getOpenCV();

    // Decode once: EXIF-rotated, bounded, RGBA raw pixels for OpenCV
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: PAGE_WIDTH, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgba = cv.matFromImageData({
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    } as Parameters<CV['matFromImageData']>[0]);

    let edgeDetection: EnhanceResult['edgeDetection'] = 'fallback';
    let outRaw: { data: Buffer; width: number; height: number };
    try {
      // Quality gates — warn (never reject); the page is still stored either way
      const quality = assessQuality(cv, rgba);
      if (quality.brightness < MIN_BRIGHTNESS) warnings.push(MSG_TOO_DARK);
      if (quality.blurVariance < MIN_BLUR_VARIANCE) warnings.push(MSG_TOO_BLURRY);

      // Stage 1 + 2: quad detection → warp; fallback = full image bounds
      const detection = detectDocumentQuad(cv, rgba);
      if (detection) {
        const warped = warpToQuad(cv, rgba, detection.corners);
        try {
          outRaw = {
            data: Buffer.from(warped.mat.data),
            width: warped.width,
            height: warped.height,
          };
          edgeDetection = 'detected';
        } finally {
          warped.mat.delete();
        }
        console.log(`[scan-enhance] edge detection: detected (pass=${detection.pass}) ${logTag}`);
      } else {
        outRaw = { data: Buffer.from(rgba.data), width: info.width, height: info.height };
        warnings.push(MSG_EDGE_FAILED);
        console.log(`[scan-enhance] edge detection: fallback used ${logTag}`);
      }
    } finally {
      rgba.delete();
    }

    // Stage 3: enhancement (sharp only)
    let pipeline = sharp(outRaw.data, {
      raw: { width: outRaw.width, height: outRaw.height, channels: 4 },
    });
    pipeline = mode === 'bw' ? enhanceBw(pipeline) : await enhanceColor(pipeline);
    const jpeg = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();

    return { jpeg, edgeDetection, warnings };
  } catch (err) {
    // Whole-pipeline safety net: keep the page with the pre-feature normalize
    console.error(`[scan-enhance] pipeline failed — storing plain image ${logTag}:`, err);
    return { jpeg: await plainNormalize(input), edgeDetection: 'skipped', warnings };
  }
}

// ---------------------------------------------------------------------------
// PDF assembly (extracted from the finalize_scan handler; worker calls this)
// ---------------------------------------------------------------------------

// A4 in PDF points (210×297 mm at 72 dpi)
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

/**
 * Thai-capable TTF for the invisible OCR text layer (pdf-lib StandardFonts are
 * WinAnsi-only and cannot encode Thai). Pre-seeded into apps/api/assets/fonts/
 * by scripts/download-tessdata.js; lazily downloaded on first use if missing.
 * Returns null (and logs once) when unavailable — non-ASCII words are then
 * skipped, never failing the PDF.
 */
const THAI_FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansThai-Regular.ttf');
const THAI_FONT_URL =
  'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf';

let thaiFontPromise: Promise<Buffer | null> | null = null;
function getThaiFontBytes(): Promise<Buffer | null> {
  if (!thaiFontPromise) {
    thaiFontPromise = (async () => {
      try {
        return await fs.readFile(THAI_FONT_PATH);
      } catch {
        /* not on disk — try downloading */
      }
      try {
        const res = await fetch(THAI_FONT_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        // Best-effort cache for the next process start
        await fs
          .mkdir(path.dirname(THAI_FONT_PATH), { recursive: true })
          .then(() => fs.writeFile(THAI_FONT_PATH, bytes))
          .catch(() => undefined);
        return bytes;
      } catch (err) {
        console.error('[scan-enhance] Thai OCR font unavailable — Thai text layer disabled:', err);
        return null;
      }
    })();
  }
  return thaiFontPromise;
}

const isAscii = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);

export type OcrFn = (jpeg: Buffer) => Promise<OcrPageResult>;

/**
 * Hard ceiling on how long a single page's OCR may take before it's abandoned
 * (→ image-only page). Without this a stuck OCR call (tesseract stall on a huge
 * page, WASM hang) would make `await ocrResults[i]` below never resolve, so
 * buildScanPdf never returns → the finalize_scan job hangs forever with no card
 * and no error. OCR is strictly best-effort, so a timeout just degrades the page.
 */
const OCR_PAGE_TIMEOUT_MS = 45_000;

/**
 * Resolve `p`, but never take longer than `ms` — on timeout resolve to
 * `fallback` (and run `onTimeout`) instead of leaving the caller hanging.
 * Rejections are swallowed to `fallback` too (callers here treat OCR as
 * best-effort). The timer is always cleared so it can't keep the process alive.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface BuildScanPdfOptions {
  /** Embed an invisible searchable text layer per page (SCAN_OCR_ENABLED). */
  ocrEnabled?: boolean;
  logTag?: string;
  /** Injectable OCR engine (tests); defaults to ocr.service extractTextDetailed. */
  ocr?: OcrFn;
  /** Per-page OCR timeout override (tests). Defaults to {@link OCR_PAGE_TIMEOUT_MS}. */
  ocrTimeoutMs?: number;
}

/**
 * Merge enhanced page JPEGs into one A4 PDF: each image fitted to the page
 * with aspect ratio preserved, centered. With ocrEnabled, each page also gets
 * an invisible (opacity 0) text layer positioned from the OCR word bounding
 * boxes, making the PDF searchable. OCR runs for all pages in parallel and is
 * strictly best-effort — any OCR/font/encoding failure degrades to an
 * image-only page; only an unreadable page image itself throws (the worker's
 * retry/last-attempt handling deals with that).
 */
export async function buildScanPdf(pages: Buffer[], opts: BuildScanPdfOptions = {}): Promise<Uint8Array> {
  const { ocrEnabled = false, logTag = '', ocr = extractTextDetailed, ocrTimeoutMs = OCR_PAGE_TIMEOUT_MS } = opts;

  // Kick off OCR for every page up front (parallel with PDF/image embedding).
  // Each page's OCR failure OR timeout collapses to an empty result — never
  // fatal, and (crucially) can never leave `await ocrResults[i]` hanging, which
  // would hang the whole finalize_scan job with no card and no error.
  const ocrResults: Promise<OcrPageResult>[] = pages.map((jpeg, i) =>
    ocrEnabled
      ? withTimeout(
          ocr(jpeg).catch((err): OcrPageResult => {
            console.error(`[scan-enhance] OCR failed — image-only page ${logTag}:`, err);
            return { text: '', words: [] };
          }),
          ocrTimeoutMs,
          { text: '', words: [] },
          () => console.warn(`[scan-enhance] OCR timed out (>${ocrTimeoutMs}ms) — image-only page ${i + 1} ${logTag}`),
        )
      : Promise.resolve({ text: '', words: [] }),
  );

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  // Fonts are embedded lazily, only when a page actually has OCR words
  let helvetica: PDFFont | null = null;
  let thaiFont: PDFFont | null | undefined; // undefined = not attempted yet

  for (let i = 0; i < pages.length; i++) {
    const started = Date.now();
    const img = await pdf.embedJpg(pages[i]!);
    const scale = Math.min(A4_WIDTH_PT / img.width, A4_HEIGHT_PT / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const offX = (A4_WIDTH_PT - w) / 2;
    const offY = (A4_HEIGHT_PT - h) / 2;
    const pdfPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    pdfPage.drawImage(img, { x: offX, y: offY, width: w, height: h });

    const { words } = await ocrResults[i]!;
    if (words.length > 0) {
      try {
        if (!helvetica) helvetica = await pdf.embedFont('Helvetica');
        if (thaiFont === undefined && words.some((word) => !isAscii(word.text))) {
          const bytes = await getThaiFontBytes();
          thaiFont = bytes ? await pdf.embedFont(bytes, { subset: true }) : null;
        }
        for (const word of words) {
          const font = isAscii(word.text) ? helvetica : thaiFont;
          if (!font) continue; // Thai font unavailable — skip non-ASCII words
          // Map image pixels → PDF points; PDF y-axis grows upward
          const size = Math.max(2, Math.min(72, (word.bbox.y1 - word.bbox.y0) * scale));
          try {
            pdfPage.drawText(word.text, {
              x: offX + word.bbox.x0 * scale,
              y: offY + (img.height - word.bbox.y1) * scale,
              size,
              font,
              opacity: 0,
            });
          } catch {
            /* unencodable glyphs in this word — skip it */
          }
        }
      } catch (err) {
        console.error(`[scan-enhance] text layer failed on page ${i + 1} ${logTag}:`, err);
      }
    }

    const elapsed = Date.now() - started;
    if (elapsed > 15_000) {
      console.warn(`[scan-enhance] page ${i + 1} took ${elapsed}ms (>15s) ${logTag}`);
    }
  }

  return pdf.save();
}

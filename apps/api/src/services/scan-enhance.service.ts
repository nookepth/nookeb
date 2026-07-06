import sharp, { type Sharp } from 'sharp';
import type { ScanMode } from '@nookeb/shared';

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

/**
 * Stage 1: find the document's 4-corner outline. Returns null when no
 * convincing quad exists (caller falls back to full image bounds).
 */
function detectDocumentQuad(cv: CV, rgba: InstanceType<CV['Mat']>): Point[] | null {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 75, 200);
    // Close small gaps in the page outline so it survives approxPolyDP
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const minArea = rgba.cols * rgba.rows * MIN_QUAD_AREA_RATIO;

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
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
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
      const corners = detectDocumentQuad(cv, rgba);
      if (corners) {
        const warped = warpToQuad(cv, rgba, corners);
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
        console.log(`[scan-enhance] edge detection: detected ${logTag}`);
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

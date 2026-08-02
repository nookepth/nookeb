import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import sharp, { type Sharp } from 'sharp';
import { PDFDocument, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { ScanMode } from '@nookeb/shared';
import { extractTextDetailed, type OcrPageResult } from './ocr.service';

/**
 * CamScanner-style scan-page pipeline (worker-only — see upload.worker.ts):
 *   Stage 1  edge/contour detection  (OpenCV: Canny → findContours → approxPolyDP,
 *                                     then adaptive threshold, then minAreaRect)
 *   Stage 2  perspective transform   (OpenCV: getPerspectiveTransform → warpPerspective)
 *   Stage 2b post-crop validation    (border-cleanliness check → capped re-crop)
 *   Stage 2c auto-orientation        (sideways page → quarter turn)
 *   Stage 3  illumination flattening (flat-field divide + tone curve, JS + sharp)
 *
 * OpenCV is the WASM build (@techstark/opencv-js) — no native compile, so it
 * installs cleanly on Railway nixpacks and the Alpine Dockerfile. Its scope is
 * kept minimal (detection + warp + blur metric); all encoding/enhancement is
 * plain JS over raw buffers plus sharp.
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
// ...and at most this much. On a cluttered or textured surface the dilated Canny
// edges close into ONE frame-sized contour that passes every other gate, warps
// ≈ identity, and ships the whole desk inside the "scan". Rejecting it lets the
// search fall through to the next-largest contour — usually the page itself.
const MAX_QUAD_AREA_RATIO = 0.985;
// Paper-likeness gate: the warped width/height ratio of an accepted quad.
// Loose bounds on purpose — A4 is 0.71/1.41 but long receipts are legitimate;
// this only rejects degenerate slivers (e.g. a lone text line or table rule).
const MIN_QUAD_ASPECT = 0.2;
const MAX_QUAD_ASPECT = 5;
const PAGE_WIDTH = 1600; // normalized page width (matches the previous behavior)
const JPEG_QUALITY = 85;

// --- Stage 2b: post-crop validation -----------------------------------------
// A crop is only "final" if its own outer border already looks like the page's
// background. When it doesn't, the first pass left desk/table/other paper in
// frame, and detection is re-run ON THE CROP to tighten it.
/** Outer ring of the crop that is sampled, as a fraction of its short side. */
const BORDER_RING_RATIO = 0.06;
/** Ring samples unlike the page background, beyond which the crop is "dirty". */
const BORDER_DIRTY_RATIO = 0.22;
/** How far a ring sample's luma / chroma may stray from the page's own median. */
const BORDER_LUMA_TOLERANCE = 48;
const BORDER_CHROMA_TOLERANCE = 42;
/** A re-crop must pull in at least this much of a side to be worth the re-warp. */
const REFINE_MIN_INSET_RATIO = 0.025;
/**
 * Area ceiling for detection DURING refinement — deliberately tighter than
 * MAX_QUAD_AREA_RATIO. A crop's own outline is still an edge in the cropped
 * image, and being the largest quad present it wins the search and masks the
 * page nested inside it. Since a refinement is by definition looking for
 * something smaller, excluding near-frame candidates outright is what lets the
 * page win. Kept consistent with REFINE_MIN_INSET_RATIO: insetting one side by
 * 2.5% costs ~2.5% of the area, so anything above 0.975 could not qualify.
 */
const REFINE_MAX_AREA_RATIO = 0.97;
/** ...and must keep at least this much of the frame (never collapse onto text). */
const REFINE_MIN_AREA_RATIO = 0.35;
/** Hard cap on re-crops: bounded compute, and no way to loop forever. */
const MAX_REFINE_PASSES = 2;

// --- Stage 1 pass 3: rotated-rectangle fit ----------------------------------
/** Below this global gray spread there is no page/background split to find. */
const MIN_RECT_STDDEV = 25;
/** The blob must FILL its own minAreaRect this much (a page does; a shadow doesn't). */
const MIN_RECT_FILL = 0.75;
/** CLOSE kernel that welds text and table rules back into one page blob. */
const RECT_CLOSE_KERNEL = 25;

// --- Stage 2c: auto-orientation ---------------------------------------------
/** Only a clearly landscape result is a candidate for a quarter turn. */
const ORIENT_LANDSCAPE_RATIO = 1.05;
/** Column-wise ink variation must beat row-wise by this much to mean "sideways". */
const ORIENT_PROFILE_RATIO = 1.6;
/** Sanity band on the ink fraction — outside it the profile signal is noise. */
const ORIENT_MIN_INK = 0.005;
const ORIENT_MAX_INK = 0.4;
/**
 * Degrees passed to sharp for the quarter turn (270 = counter-clockwise).
 *
 * The 90° DIRECTION cannot be recovered from the ink profile alone — that needs
 * Tesseract OSD, which would be a new pinned build asset (osd.traineddata is
 * NOT among the files scripts/download-tessdata.js fetches). CCW is the pinned
 * choice; flip this constant if real samples say otherwise. A 180° flip is out
 * of scope for the same reason and is deliberately never attempted.
 */
const ORIENT_ROTATE_DEGREES = 270;

// User-facing Thai copy (pushed by the worker, defined here next to the checks)
//
// There is deliberately NO "edges not detected" message. Detection failure is
// not a user error worth interrupting them for: the page is stored either way,
// the notice arrived DETACHED from the photo (add_scan_page carries no reply
// token, so it deferred via pending-notify onto whatever the user said next),
// and the fallback below already produces a usable brightness/contrast-corrected
// page. The failure is still logged server-side — see processScanPage.
export const MSG_TOO_DARK = 'ภาพมืดเกินไป กรุณาถ่ายในที่ที่มีแสงสว่างเพียงพอ';
export const MSG_TOO_BLURRY = 'ภาพไม่ชัด กรุณาถ่ายใหม่และถือกล้องให้นิ่ง';
export const MSG_PDF_FAILED = 'เกิดข้อผิดพลาดในการสร้าง PDF กรุณาลองใหม่อีกครั้ง';

export interface EnhanceResult {
  jpeg: Buffer;
  /** Which Stage-1 path ran: quad found, full-bounds fallback, or pipeline skipped. */
  edgeDetection: 'detected' | 'fallback' | 'skipped';
  /** User-facing Thai warnings (quality gates only). Never fatal. */
  warnings: string[];
  /** Stage-2b re-crops actually applied (0…MAX_REFINE_PASSES). Observability. */
  refinePasses: number;
  /** Stage-2b verdict on the FINAL crop's border. > BORDER_DIRTY_RATIO = still loose. */
  borderDirty: number;
  /** Whether Stage 2c turned a sideways page upright. */
  quarterTurn: boolean;
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

/** Shoelace area of a polygon — the area of the shape that ACTUALLY gets warped
 *  (cv.contourArea measures the raw contour, which approxPolyDP then simplifies). */
function polygonArea(pts: Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

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
 * passes the area + aspect gates. Shared by both contour detection passes.
 *
 * `maxArea` is what stops a frame-sized contour from being mistaken for the
 * page: rejecting it does not end the search, it lets the loop keep going and
 * settle on the next-largest quad.
 *
 * RETR_LIST, not RETR_EXTERNAL. External-only returns just the OUTERMOST
 * contours, so anything the clutter encloses is invisible: a wood grain or a
 * placemat whose edges close into a frame-spanning ring hides the page nested
 * inside it, and rejecting that ring by area then leaves nothing to fall back
 * to. Listing every contour is what lets the search reach the page. The area
 * and aspect gates already do the filtering that nesting used to do for free.
 */
function bestQuadFromBinary(
  cv: CV,
  binary: InstanceType<CV['Mat']>,
  minArea: number,
  maxArea: number,
): Point[] | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
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
          // Gate on the SIMPLIFIED quad, not the raw contour — that polygon is
          // what warpToQuad will use, and it is what must not be the frame.
          const quadArea = polygonArea(pts);
          if (quadArea < minArea || quadArea > maxArea) continue;
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

/** cv.minAreaRect's return shape (kept local — the WASM typings vary by build). */
interface RotatedRectLike {
  center: { x: number; y: number };
  size: { width: number; height: number };
  angle: number;
}

/** The 4 corners of a rotated rectangle. Computed by hand rather than via
 *  cv.RotatedRect.points, whose availability differs across opencv.js builds. */
function rotatedRectPoints(rect: RotatedRectLike): Point[] {
  const rad = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = rect.size.width / 2;
  const hh = rect.size.height / 2;
  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const).map(([x, y]) => ({
    x: rect.center.x + x * cos - y * sin,
    y: rect.center.y + x * sin + y * cos,
  }));
}

/**
 * Detection pass 3: fit the page as a ROTATED RECTANGLE instead of a 4-corner
 * contour. Otsu splits bright paper from a darker surface, a large CLOSE welds
 * the text holes shut, and minAreaRect fits the result — which works when the
 * page's corners are rounded, blown out, shadowed or cropped by the frame, i.e.
 * exactly the photos approxPolyDP refuses to reduce to four points.
 *
 * The fit carries the page's ROTATION, so handing it to warpToQuad deskews and
 * crops in one operation — no separate rotate step, same pipeline (Issue 3).
 *
 * Gated hard, because Otsu always returns *something*: a flat surface with no
 * page on it splits into two meaningless halves. `MIN_RECT_STDDEV` requires a
 * real bimodal split to exist at all, and `MIN_RECT_FILL` requires the blob to
 * actually be rectangular rather than merely bounded by one.
 */
function detectPageRotatedRect(
  cv: CV,
  gray: InstanceType<CV['Mat']>,
  minArea: number,
  maxArea: number,
): Point[] | null {
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  try {
    cv.meanStdDev(gray, mean, stddev);
    if ((stddev.data64F[0] ?? 0) < MIN_RECT_STDDEV) return null;
  } finally {
    mean.delete();
    stddev.delete();
  }

  const binary = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(RECT_CLOSE_KERNEL, RECT_CLOSE_KERNEL),
  );
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best: Point[] | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        if (area < minArea || area <= bestArea) continue;
        const pts = rotatedRectPoints(cv.minAreaRect(contour) as unknown as RotatedRectLike);
        const rectArea = polygonArea(pts);
        if (rectArea < minArea || rectArea > maxArea) continue;
        if (area / rectArea < MIN_RECT_FILL) continue; // bounded, but not rectangular
        if (!quadAspectOk(pts)) continue;
        best = pts;
        bestArea = area;
      } finally {
        contour.delete();
      }
    }
    return best;
  } finally {
    binary.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

type DetectionPass = 'canny' | 'adaptive' | 'rect';

/**
 * Stage 1: find the document's outline. Three passes, cheapest first, each
 * behind the same area + aspect gates:
 *   1. Canny → dilate (strong page/background contrast — the common case)
 *   2. adaptive threshold (negative C highlights local edge bands) — catches
 *      low-contrast pages Canny misses, e.g. white paper on a light desk
 *   3. Otsu + CLOSE + minAreaRect — a rotated-rectangle fit for pages whose
 *      corners never survive approxPolyDP (rounded, shadowed, blown out, or
 *      running off the frame). Carries rotation, so it deskews via the warp.
 * Returns null when no pass yields a convincing quad (caller falls back to
 * full image bounds).
 */
function detectDocumentQuad(
  cv: CV,
  rgba: InstanceType<CV['Mat']>,
  maxAreaRatio = MAX_QUAD_AREA_RATIO,
): { corners: Point[]; pass: DetectionPass } | null {
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const frameArea = rgba.cols * rgba.rows;
    const minArea = frameArea * MIN_QUAD_AREA_RATIO;
    const maxArea = frameArea * maxAreaRatio;
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    try {
      // Pass 1: Canny + dilate (close small gaps so the outline survives approxPolyDP)
      cv.Canny(gray, binary, 75, 200);
      cv.dilate(binary, binary, kernel);
      const canny = bestQuadFromBinary(cv, binary, minArea, maxArea);
      if (canny) return { corners: canny, pass: 'canny' };

      // Pass 2: adaptive threshold. C < 0 marks pixels brighter than their local
      // mean — on a low-contrast photo that traces the page boundary as a band.
      cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, -2);
      cv.dilate(binary, binary, kernel);
      const adaptive = bestQuadFromBinary(cv, binary, minArea, maxArea);
      if (adaptive) return { corners: adaptive, pass: 'adaptive' };

      // Pass 3: rotated-rectangle fit (see detectPageRotatedRect).
      const rect = detectPageRotatedRect(cv, gray, minArea, maxArea);
      if (rect) return { corners: rect, pass: 'rect' };
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

// ---------------------------------------------------------------------------
// Stage 2b: post-crop validation
//
// A first-pass crop is not automatically the final output. If the quad was even
// slightly loose — or the frame-sized contour won before MAX_QUAD_AREA_RATIO
// existed — the result still carries table, desk or a neighbouring sheet around
// the page, which is what the enhancement stage then happily "corrects".
//
// The test is the crop's OWN outer ring: on a correct crop that ring is the
// page's background (whatever colour the paper is), so it is compared against
// the page's median rather than against an absolute idea of "white". Anything
// meaningfully darker/lighter, or meaningfully more colourful, is not paper.
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx]!;
}

const median = (values: number[]): number => percentile(values, 0.5);

/**
 * The page's own background level, taken as a HIGH PERCENTILE of the interior
 * rather than its median.
 *
 * Median assumes ink is a minority of the page, which is false often enough to
 * matter — a scanned form with large filled blocks, a dark photo pasted on the
 * page, a table with solid header rows. When it flips, "paper" is measured as
 * black and the check then declares the genuinely-white border dirty, i.e. it
 * would re-crop a crop that was already correct. The brightest large-area
 * component of a document is the paper, so a percentile is the stable estimate.
 */
const PAPER_LUMA_PERCENTILE = 0.8;
/** Chroma is averaged over samples that ARE paper, so coloured stock reads right. */
const PAPER_CHROMA_BAND = 30;

/**
 * Fraction of the crop's outer ring that does not look like the page's own
 * background. 0 = clean crop; > BORDER_DIRTY_RATIO = background still in frame.
 *
 * Sampled on a stride so the cost is ~constant (≈25k reads) regardless of page
 * size. Text bleeding into the ring is fine: it is a minority of ring samples.
 */
function borderDirtyRatio(mat: InstanceType<CV['Mat']>): number {
  const w = mat.cols;
  const h = mat.rows;
  const ring = Math.max(2, Math.round(Math.min(w, h) * BORDER_RING_RATIO));
  if (w <= ring * 4 || h <= ring * 4) return 0; // too small to judge — treat as clean

  const data = mat.data;
  const step = Math.max(1, Math.round(Math.min(w, h) / 160));
  const luma = (x: number, y: number): number => {
    const p = (y * w + x) * 4;
    return 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  };
  const chroma = (x: number, y: number): number => {
    const p = (y * w + x) * 4;
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    return Math.max(r, g, b) - Math.min(r, g, b);
  };

  // The page's own background, measured on the central 60% — see
  // PAPER_LUMA_PERCENTILE for why this is a percentile and not a median.
  const coreLuma: number[] = [];
  const coreChroma: number[] = [];
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += step) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x += step) {
      coreLuma.push(luma(x, y));
      coreChroma.push(chroma(x, y));
    }
  }
  const paperLuma = percentile(coreLuma, PAPER_LUMA_PERCENTILE);
  const paperSamples = coreChroma.filter(
    (_, i) => Math.abs(coreLuma[i]! - paperLuma) <= PAPER_CHROMA_BAND,
  );
  const paperChroma = median(paperSamples.length > 0 ? paperSamples : coreChroma);

  let dirty = 0;
  let total = 0;
  const sample = (x: number, y: number): void => {
    total++;
    if (
      Math.abs(luma(x, y) - paperLuma) > BORDER_LUMA_TOLERANCE ||
      Math.abs(chroma(x, y) - paperChroma) > BORDER_CHROMA_TOLERANCE
    ) {
      dirty++;
    }
  };
  for (let y = 0; y < h; y += step) {
    const horizontalBand = y < ring || y >= h - ring;
    for (let x = 0; x < w; x += step) {
      if (horizontalBand || x < ring || x >= w - ring) sample(x, y);
    }
  }
  return total === 0 ? 0 : dirty / total;
}

/**
 * Is a quad found INSIDE an existing crop worth re-warping to? It must pull in
 * at least one side by REFINE_MIN_INSET_RATIO (otherwise it is the same crop
 * and the loop would spin), and keep most of the frame (otherwise detection has
 * locked onto a text block or a table inside the page, not the page).
 */
function quadIsWorthRefining(pts: Point[], w: number, h: number): boolean {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const insetX = w * REFINE_MIN_INSET_RATIO;
  const insetY = h * REFINE_MIN_INSET_RATIO;
  const tightens =
    Math.min(...xs) > insetX ||
    Math.min(...ys) > insetY ||
    w - Math.max(...xs) > insetX ||
    h - Math.max(...ys) > insetY;
  return tightens && polygonArea(pts) >= w * h * REFINE_MIN_AREA_RATIO;
}

/**
 * Stage 2c: is this landscape crop actually a portrait page lying on its side?
 *
 * Text lines make the ink profile spiky along the axis PERPENDICULAR to them:
 * upright text alternates line/gap down the rows, sideways text does the same
 * across the columns. Comparing the two coefficients of variation therefore
 * says which way the lines run, without any OCR.
 *
 * Only a clearly landscape result is considered — a landscape document is a
 * legitimate thing to scan, so this never rotates a portrait result. See
 * ORIENT_ROTATE_DEGREES on why the direction is a pinned choice.
 */
function needsQuarterTurn(mat: InstanceType<CV['Mat']>): boolean {
  const w = mat.cols;
  const h = mat.rows;
  if (w < h * ORIENT_LANDSCAPE_RATIO) return false;

  const data = mat.data;
  const step = Math.max(1, Math.round(Math.min(w, h) / 200));
  const lumaAt = (x: number, y: number): number => {
    const p = (y * w + x) * 4;
    return 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  };

  const all: number[] = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) all.push(lumaAt(x, y));
  // Same percentile-not-median reasoning as borderDirtyRatio: ink is measured
  // relative to the paper, and the paper is the bright component.
  const inkCutoff = percentile(all, PAPER_LUMA_PERCENTILE) - BORDER_LUMA_TOLERANCE;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x < w; x += step) xs.push(x);
  for (let y = 0; y < h; y += step) ys.push(y);

  const rows = ys.map((y) => xs.reduce((n, x) => n + (lumaAt(x, y) < inkCutoff ? 1 : 0), 0));
  const cols = xs.map((x) => ys.reduce((n, y) => n + (lumaAt(x, y) < inkCutoff ? 1 : 0), 0));
  const total = xs.length * ys.length;
  const inkFraction = total === 0 ? 0 : rows.reduce((a, b) => a + b, 0) / total;
  if (inkFraction < ORIENT_MIN_INK || inkFraction > ORIENT_MAX_INK) return false;

  // Coefficient of variation: spread normalised by level, so the two axes stay
  // comparable even though they have different sample counts.
  const cv_ = (values: number[]): number => {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean <= 0) return 0;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  };
  const rowCv = cv_(rows);
  const colCv = cv_(cols);
  return rowCv > 0 && colCv / rowCv > ORIENT_PROFILE_RATIO;
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

// ---------------------------------------------------------------------------
// Stage 3: illumination flattening (flat-field correction)
//
// Model: photo = reflectance × illumination. The illumination (paper shade,
// lighting gradients, shadows) is low-frequency, so it's estimated on a small
// grayscale map with a morphological CLOSE (max-then-min erases dark ink,
// leaving just paper + lighting) plus blur, then the photo is DIVIDED by it:
// paper normalizes to white everywhere — shadows cancel out — while ink keeps
// its local contrast. A tone LUT then sets the white/black points per mode.
//
// This replaced a global threshold(165), which did the opposite on real phone
// photos: shadowed paper below the cutoff flipped to solid black and faint ink
// above it (thermal receipts) was erased to blank white.
// ---------------------------------------------------------------------------

// Illumination is low-frequency — estimate it on a small map (fast, and the
// downscale itself already suppresses text strokes).
const BG_MAP_WIDTH = 256;
// CLOSE radius on the map: erases dark features up to ~2r map-px wide
// (≈ 60 px at full resolution — text, lines, small logos).
const BG_CLOSE_RADIUS = 5;
// Two box-blur passes ≈ Gaussian; smooths the closing's plateaus.
const BG_BLUR_RADIUS = 3;

interface ToneProfile {
  /** Cap on the divide gain (255/background). Limits how hard large dark
   *  regions (photos on the page) get pushed toward white. */
  maxGain: number;
  /** Output channels: 1 = grayscale document look, 3 = color kept. */
  channels: 1 | 3;
  lut: Uint8Array;
}

/** Levels-style tone curve: [black..white] → [0..255] with gamma on top. */
function buildToneLut(black: number, white: number, gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const t = Math.min(1, Math.max(0, (i - black) / (white - black)));
    lut[i] = Math.round(255 * Math.pow(t, gamma));
  }
  return lut;
}

const TONE: Record<ScanMode, ToneProfile> = {
  // Aggressive cleanup: crisp white paper, dark ink, grayscale output.
  bw: { maxGain: 4, channels: 1, lut: buildToneLut(30, 236, 1.5) },
  // Conservative: shadows removed but colors (stamps, highlights, photos)
  // survive — low gain cap and a near-linear curve.
  color: { maxGain: 2.2, channels: 3, lut: buildToneLut(10, 242, 1.1) },
};

/** Separable running max/min filter (radius r) over a small gray map. */
function rankFilter(src: Uint8Array, w: number, h: number, r: number, isMax: boolean): Uint8Array {
  const pick = isMax ? Math.max : Math.min;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x]!;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[row + k]!);
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]!;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]!);
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Two-pass box blur (radius r) over a small gray map. */
function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        s += src[y * w + k]!;
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        s += tmp[k * w + x]!;
        n++;
      }
      out[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}

/** Small grayscale illumination map of a full-res RGBA page (close + blur). */
async function estimateIllumination(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<{ map: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .grayscale()
    .resize({ width: Math.min(BG_MAP_WIDTH, width) })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // grayscale() keeps the alpha band on raw output — take channel 0
  const ch = info.channels;
  const w = info.width;
  const h = info.height;
  let map: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) map[i] = data[i * ch]!;
  map = rankFilter(map, w, h, BG_CLOSE_RADIUS, true); // dilate: dark ink vanishes
  map = rankFilter(map, w, h, BG_CLOSE_RADIUS, false); // erode: restore extents
  map = boxBlur(map, w, h, BG_BLUR_RADIUS);
  map = boxBlur(map, w, h, BG_BLUR_RADIUS);
  return { map, w, h };
}

/**
 * Divide the page by its illumination map (bilinearly upsampled) and apply the
 * mode's tone curve. Returns raw pixels ready for sharp: 1 channel for 'bw',
 * 3 for 'color'.
 */
async function flattenIllumination(
  page: { data: Buffer; width: number; height: number },
  mode: ScanMode,
): Promise<{ data: Buffer; channels: 1 | 3 }> {
  const { data: rgba, width, height } = page;
  const { map, w: bw, h: bh } = await estimateIllumination(rgba, width, height);
  const { maxGain, lut, channels } = TONE[mode];
  const out = Buffer.alloc(width * height * channels);
  const sx = bw / width;
  const sy = bh / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(bh - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, bh - 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(bw - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, bw - 1);
      const wx = fx - x0;
      const bg =
        map[y0 * bw + x0]! * (1 - wx) * (1 - wy) +
        map[y0 * bw + x1]! * wx * (1 - wy) +
        map[y1 * bw + x0]! * (1 - wx) * wy +
        map[y1 * bw + x1]! * wx * wy;
      const gain = Math.min(maxGain, 255 / Math.max(1, bg));
      const p = (y * width + x) * 4;
      if (channels === 1) {
        const g = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
        out[y * width + x] = lut[Math.min(255, Math.round(g * gain))]!;
      } else {
        const q = (y * width + x) * 3;
        out[q] = lut[Math.min(255, Math.round(rgba[p]! * gain))]!;
        out[q + 1] = lut[Math.min(255, Math.round(rgba[p + 1]! * gain))]!;
        out[q + 2] = lut[Math.min(255, Math.round(rgba[p + 2]! * gain))]!;
      }
    }
  }
  return { data: out, channels };
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
    let refinePasses = 0;
    let borderDirty = 0;
    let quarterTurn = false;
    let outRaw: { data: Buffer; width: number; height: number };
    try {
      // Quality gates — warn (never reject); the page is still stored either way
      const quality = assessQuality(cv, rgba);
      if (quality.brightness < MIN_BRIGHTNESS) warnings.push(MSG_TOO_DARK);
      if (quality.blurVariance < MIN_BLUR_VARIANCE) warnings.push(MSG_TOO_BLURRY);

      // Stage 1 + 2: quad detection → warp; fallback = full image bounds
      const detection = detectDocumentQuad(cv, rgba);
      if (detection) {
        let warped = warpToQuad(cv, rgba, detection.corners);
        try {
          // Stage 2b: the first crop is a candidate, not the answer. While its
          // own border still shows non-paper, re-detect ON THE CROP and tighten.
          // Bounded three ways — the pass cap, the "must actually tighten" gate,
          // and detection simply not finding anything better.
          borderDirty = borderDirtyRatio(warped.mat);
          while (refinePasses < MAX_REFINE_PASSES && borderDirty > BORDER_DIRTY_RATIO) {
            const again = detectDocumentQuad(cv, warped.mat, REFINE_MAX_AREA_RATIO);
            if (!again || !quadIsWorthRefining(again.corners, warped.width, warped.height)) {
              // The crop still shows background but nothing better is findable.
              // This is the line to grep when a user reports a loose scan.
              console.log(
                `[scan-enhance] re-crop declined: border=${borderDirty.toFixed(3)} ` +
                  `found=${again?.pass ?? 'none'} ` +
                  `area=${again ? (polygonArea(again.corners) / (warped.width * warped.height)).toFixed(3) : '-'} ` +
                  `${logTag}`,
              );
              break;
            }
            const tighter = warpToQuad(cv, warped.mat, again.corners);
            warped.mat.delete();
            warped = tighter;
            refinePasses++;
            borderDirty = borderDirtyRatio(warped.mat);
            console.log(
              `[scan-enhance] re-crop ${refinePasses}/${MAX_REFINE_PASSES} (pass=${again.pass}) → ` +
                `${warped.width}x${warped.height} border=${borderDirty.toFixed(3)} ${logTag}`,
            );
          }

          // Stage 2c: sideways page → quarter turn (applied by sharp below).
          quarterTurn = needsQuarterTurn(warped.mat);

          outRaw = {
            data: Buffer.from(warped.mat.data),
            width: warped.width,
            height: warped.height,
          };
          edgeDetection = 'detected';
        } finally {
          warped.mat.delete();
        }
        console.log(
          `[scan-enhance] edge detection: detected (pass=${detection.pass}) ` +
            `recrops=${refinePasses} border=${borderDirty.toFixed(3)} turn=${quarterTurn} ${logTag}`,
        );
      } else {
        // No quad at all. The page is still produced — full frame, straightened
        // by nothing but corrected for brightness/contrast by Stage 3 below.
        // The user is deliberately NOT told (see the MSG_ block at the top).
        outRaw = { data: Buffer.from(rgba.data), width: info.width, height: info.height };
        console.log(`[scan-enhance] edge detection: fallback used ${logTag}`);
      }
    } finally {
      rgba.delete();
    }

    // Stage 3: flat-field illumination correction + tone curve, then sharpen.
    // 'bw' outputs a grayscale document look; 'color' keeps colors with a
    // gentler curve and a mild saturation boost.
    const flat = await flattenIllumination(outRaw, mode);
    let pipeline: Sharp = sharp(flat.data, {
      raw: { width: outRaw.width, height: outRaw.height, channels: flat.channels },
    });
    // Stage 2c applied here rather than in OpenCV: a multiple-of-90 rotate is
    // free in sharp and needs no extra Mat.
    if (quarterTurn) pipeline = pipeline.rotate(ORIENT_ROTATE_DEGREES);
    pipeline =
      mode === 'bw'
        ? pipeline.sharpen({ sigma: 1 })
        : pipeline.modulate({ saturation: 1.12 }).sharpen({ sigma: 0.8 });
    const jpeg = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();

    return { jpeg, edgeDetection, warnings, refinePasses, borderDirty, quarterTurn };
  } catch (err) {
    // Whole-pipeline safety net: keep the page with the pre-feature normalize
    console.error(`[scan-enhance] pipeline failed — storing plain image ${logTag}:`, err);
    return {
      jpeg: await plainNormalize(input),
      edgeDetection: 'skipped',
      warnings,
      refinePasses: 0,
      borderDirty: 0,
      quarterTurn: false,
    };
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
 * WinAnsi-only and cannot encode Thai).
 *
 * FIX 16 — BUILD-TIME ASSET. This used to fall back to fetching the font from
 * a CDN on first use and writing it into the container filesystem. Two problems
 * with that: it put a third-party host on the serving path of a user-visible
 * feature, and it wrote whatever bytes came back straight to disk with no
 * integrity check. Both are gone. The font is now fetched once at build time,
 * behind a pinned SHA-256, by scripts/download-tessdata.js — invoked from
 * apps/api/package.json `postinstall` and, for the container, by an explicit
 * RUN step in apps/api/Dockerfile.
 *
 * Reference only, do NOT re-add a fetch here — the URL and its hash live in
 * scripts/download-tessdata.js:
 *   https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf
 *
 * Throws when the file is absent. The single call site (buildScanPdf's text
 * layer) already wraps this in try/catch and logs, so a missing font degrades
 * to an image-only page exactly as the old `return null` did — but LOUDLY, with
 * the fix in the message, instead of silently dropping every Thai word.
 */
const THAI_FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansThai-Regular.ttf');

let thaiFontPromise: Promise<Buffer | null> | null = null;
function getThaiFontBytes(): Promise<Buffer | null> {
  if (!thaiFontPromise) {
    thaiFontPromise = (async () => {
      if (!existsSync(THAI_FONT_PATH)) {
        throw new Error(
          `Thai font missing at ${THAI_FONT_PATH}. Run: node scripts/download-tessdata.js`,
        );
      }
      return fs.readFile(THAI_FONT_PATH);
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

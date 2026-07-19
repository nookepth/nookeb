import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

/**
 * OCR service — one engine for both the ocr_image job (plain text for search)
 * and the finalize_scan searchable-PDF text layer (word bounding boxes).
 *
 * Engine: tesseract.js (tha+eng, ~85–90% on printed Thai). The worker is a lazy
 * singleton — created once per process, terminated via terminateOcr() in the
 * shutdown handler. Traineddata is served from apps/api/tessdata/ (pre-seeded by
 * scripts/download-tessdata.js with tessdata_fast models; tesseract.js
 * auto-downloads into the same cache dir if it's missing).
 *
 * extractText / extractTextDetailed NEVER throw — any OCR error logs and
 * returns empty output, so a caller can never fail a job because OCR failed.
 */

export type OcrLanguage = 'tha' | 'eng' | 'tha+eng';

export interface OcrWord {
  text: string;
  /** Pixel bounding box in the input image's coordinate space. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrPageResult {
  text: string;
  words: OcrWord[];
}

const EMPTY: OcrPageResult = { text: '', words: [] };

// apps/api/tessdata — resolves correctly from both src/services (tsx) and
// dist/services (compiled) since both sit two levels below apps/api.
const TESSDATA_DIR = path.join(__dirname, '..', '..', 'tessdata');

// ---------------------------------------------------------------------------
// tesseract.js singleton
// ---------------------------------------------------------------------------

let tesseractPromise: Promise<TesseractWorker> | null = null;

function getTesseract(): Promise<TesseractWorker> {
  if (!tesseractPromise) {
    tesseractPromise = (async () => {
      await fs.mkdir(TESSDATA_DIR, { recursive: true }).catch(() => undefined);
      // OEM 1 = LSTM only; cachePath keeps traineddata out of the repo cwd
      return createWorker('tha+eng', 1, { cachePath: TESSDATA_DIR });
    })();
    // A failed init must not poison every later call with the same rejection
    tesseractPromise.catch(() => {
      tesseractPromise = null;
    });
  }
  return tesseractPromise;
}

/** Terminate the singleton tesseract worker (process shutdown handler). */
export async function terminateOcr(): Promise<void> {
  if (tesseractPromise) {
    const p = tesseractPromise;
    tesseractPromise = null;
    try {
      const worker = await p;
      await worker.terminate();
    } catch {
      /* already failed — nothing to terminate */
    }
  }
}

// Minimal shapes for the block-tree tesseract.js returns with { blocks: true }
interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text?: string;
  bbox?: TessBbox;
}
interface TessLine {
  words?: TessWord[];
}
interface TessParagraph {
  lines?: TessLine[];
}
interface TessBlock {
  paragraphs?: TessParagraph[];
}

async function tesseractExtract(imageBuffer: Buffer): Promise<OcrPageResult> {
  const worker = await getTesseract();
  const { data } = await worker.recognize(imageBuffer, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const block of (data as { blocks?: TessBlock[] | null }).blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? '').trim();
          const b = word.bbox;
          if (text.length === 0 || !b) continue;
          words.push({ text, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } });
        }
      }
    }
  }
  return { text: (data.text ?? '').trim(), words };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * OCR one image → text + word bounding boxes via tesseract. Never throws; any
 * failure logs and returns empty output.
 */
export async function extractTextDetailed(
  imageBuffer: Buffer,
  _language: OcrLanguage = 'tha+eng',
): Promise<OcrPageResult> {
  try {
    return await tesseractExtract(imageBuffer);
  } catch (err) {
    console.error('[ocr.service] OCR failed — returning empty text:', err);
    return EMPTY;
  }
}

/** OCR one image → plain text. Same engine chain as extractTextDetailed. */
export async function extractText(
  imageBuffer: Buffer,
  language: OcrLanguage = 'tha+eng',
): Promise<string> {
  const { text } = await extractTextDetailed(imageBuffer, language);
  return text;
}

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

// Document AI settings are read from process.env directly (NOT ../config):
// importing config validates the FULL env schema at module load, which would
// break the env-free unit tests that import this service. The vars are still
// declared/documented in config.ts; they're optional plain strings, so
// skipping zod costs nothing.
const documentAiEnv = () => ({
  project: process.env.GOOGLE_DOCUMENT_AI_PROJECT,
  location: process.env.GOOGLE_DOCUMENT_AI_LOCATION,
  processorId: process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
});

/**
 * OCR service — one engine for both the ocr_image job (plain text for search)
 * and the finalize_scan searchable-PDF text layer (word bounding boxes).
 *
 * Engine selection:
 *   - Google Document AI when GOOGLE_DOCUMENT_AI_{PROJECT,LOCATION,PROCESSOR_ID}
 *     are all set (high accuracy on Thai; ~$1.5 / 1000 pages). Any Document AI
 *     failure falls back to tesseract with a logged warning.
 *   - tesseract.js otherwise (tha+eng, ~85–90% on printed Thai). The worker is
 *     a lazy singleton — created once per process, terminated via terminateOcr()
 *     in the shutdown handler. Traineddata is served from apps/api/tessdata/
 *     (pre-seeded by scripts/download-tessdata.js with tessdata_fast models;
 *     tesseract.js auto-downloads into the same cache dir if it's missing).
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
// Google Document AI (optional)
// ---------------------------------------------------------------------------

export function isDocumentAiConfigured(): boolean {
  const { project, location, processorId } = documentAiEnv();
  return Boolean(project && location && processorId);
}

// The client type is imported lazily so worker processes without Document AI
// credentials never load the gRPC stack.
type DocumentAiClient = import('@google-cloud/documentai').v1.DocumentProcessorServiceClient;

let documentAiClientPromise: Promise<DocumentAiClient> | null = null;

function getDocumentAiClient(): Promise<DocumentAiClient> {
  if (!documentAiClientPromise) {
    documentAiClientPromise = (async () => {
      const { v1 } = await import('@google-cloud/documentai');
      const location = documentAiEnv().location!;
      return new v1.DocumentProcessorServiceClient(
        location === 'us' ? {} : { apiEndpoint: `${location}-documentai.googleapis.com` },
      );
    })();
    documentAiClientPromise.catch(() => {
      documentAiClientPromise = null;
    });
  }
  return documentAiClientPromise;
}

async function documentAiExtract(imageBuffer: Buffer): Promise<OcrPageResult> {
  const client = await getDocumentAiClient();
  const { project, location, processorId } = documentAiEnv();
  const name = client.processorPath(project!, location!, processorId!);
  const [result] = await client.processDocument({
    name,
    rawDocument: { content: imageBuffer.toString('base64'), mimeType: 'image/jpeg' },
  });
  const doc = result.document;
  const fullText = doc?.text ?? '';
  const words: OcrWord[] = [];

  for (const page of doc?.pages ?? []) {
    const pageW = page.dimension?.width ?? 0;
    const pageH = page.dimension?.height ?? 0;
    for (const token of page.tokens ?? []) {
      // Token text via its textAnchor segments into the document's full text
      const segments = token.layout?.textAnchor?.textSegments ?? [];
      const text = segments
        .map((s) => fullText.slice(Number(s.startIndex ?? 0), Number(s.endIndex ?? 0)))
        .join('')
        .trim();
      if (text.length === 0) continue;

      // Bounding box: prefer absolute vertices; fall back to normalized × page dims
      const poly = token.layout?.boundingPoly;
      let xs: number[] = [];
      let ys: number[] = [];
      if (poly?.vertices?.length) {
        xs = poly.vertices.map((v) => v.x ?? 0);
        ys = poly.vertices.map((v) => v.y ?? 0);
      } else if (poly?.normalizedVertices?.length && pageW > 0 && pageH > 0) {
        xs = poly.normalizedVertices.map((v) => (v.x ?? 0) * pageW);
        ys = poly.normalizedVertices.map((v) => (v.y ?? 0) * pageH);
      }
      if (xs.length === 0) continue;
      words.push({
        text,
        bbox: {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
        },
      });
    }
  }
  return { text: fullText.trim(), words };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * OCR one image → text + word bounding boxes. Document AI when configured
 * (with tesseract fallback on failure), else tesseract. Never throws; any
 * failure logs and returns empty output.
 */
export async function extractTextDetailed(
  imageBuffer: Buffer,
  _language: OcrLanguage = 'tha+eng',
): Promise<OcrPageResult> {
  if (isDocumentAiConfigured()) {
    try {
      return await documentAiExtract(imageBuffer);
    } catch (err) {
      console.warn('[ocr.service] Document AI failed — falling back to tesseract:', err);
    }
  }
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

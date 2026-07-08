import { config } from '../config';

/**
 * Mistral OCR client (REST, no SDK) — powers the "แปลงไฟล์" convert-to-Word
 * flow. One call per document; PDFs are processed natively (digital AND
 * scanned), images go in as data-URI image_url. Output is markdown per page
 * (headings/lists/inline emphasis, tables as markdown or HTML) which
 * docx-builder.service reconstructs into an editable .docx.
 *
 * Unlike ocr.service (search indexing, must never throw), conversion IS the
 * job — failures throw so BullMQ can retry, and the worker's last-attempt
 * handler tells the user.
 */

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
// OCR of a multi-page PDF can take a while; well under the worker lock but
// far above the LINE messaging timeouts.
const MISTRAL_OCR_TIMEOUT_MS = 120_000;

export interface MistralOcrPage {
  index: number;
  markdown: string;
}

export interface MistralOcrResult {
  pages: MistralOcrPage[];
  /** Total pages billed — logged for cost visibility. */
  pageCount: number;
}

export function isMistralOcrConfigured(): boolean {
  return Boolean(config.MISTRAL_API_KEY);
}

/** Thrown for non-retryable API rejections (bad request / unsupported doc). */
export class MistralOcrRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MistralOcrRejectedError';
  }
}

/**
 * OCR one document. `mimeType` decides the document envelope: PDFs are sent as
 * document_url, everything else as image_url (both base64 data URIs — no
 * pre-upload step, sources are already capped at DOCX_CONVERT_MAX_SOURCE_BYTES).
 */
export async function mistralOcr(buffer: Buffer, mimeType: string): Promise<MistralOcrResult> {
  if (!config.MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY is not set — mistralOcr called while unconfigured');
  }

  const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const document =
    mimeType === 'application/pdf'
      ? { type: 'document_url', document_url: dataUri }
      : { type: 'image_url', image_url: dataUri };

  let res: Response;
  try {
    res = await fetch(MISTRAL_OCR_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.MISTRAL_OCR_MODEL,
        document,
        include_image_base64: false,
      }),
      signal: AbortSignal.timeout(MISTRAL_OCR_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Mistral OCR timed out after ${MISTRAL_OCR_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 4xx (except 429) = the document itself was rejected — retrying the same
    // bytes cannot succeed, so fail the job permanently.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new MistralOcrRejectedError(`Mistral OCR rejected the document: ${res.status} ${body}`);
    }
    throw new Error(`Mistral OCR failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as {
    pages?: { index?: number; markdown?: string }[];
    usage_info?: { pages_processed?: number };
  };
  const pages: MistralOcrPage[] = (json.pages ?? []).map((p, i) => ({
    index: p.index ?? i,
    markdown: p.markdown ?? '',
  }));
  return { pages, pageCount: json.usage_info?.pages_processed ?? pages.length };
}

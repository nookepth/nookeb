import { randomUUID } from 'node:crypto';
import { config } from '../config';

/**
 * VirusTotal Public API v3 client. All calls in the codebase go through here —
 * no inline fetches in the worker.
 *
 * Design contract with the upload pipeline:
 *  - scanning is best-effort: any API/timeout problem yields `scan_failed`,
 *    which the caller treats as "proceed with upload" (never block on VT issues)
 *  - only a completed analysis with ≥1 malicious detection blocks a file
 */

const VT_API = 'https://www.virustotal.com/api/v3';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 12; // 12 × 5s = 60s total budget

interface VtUploadResponse {
  data: { id: string; type: string };
}

interface VtAnalysisStats {
  malicious: number;
  suspicious: number;
  undetected: number;
  harmless: number;
  timeout: number;
}

interface VtEngineResult {
  category: string; // 'malicious' | 'suspicious' | 'undetected' | ...
  engine_name: string;
  result: string | null;
}

interface VtAnalysisResponse {
  data: {
    attributes: {
      status: 'queued' | 'in-progress' | 'completed';
      stats: VtAnalysisStats;
      results: Record<string, VtEngineResult>;
    };
  };
}

export type ScanVerdict =
  | { outcome: 'clean' }
  | { outcome: 'malicious'; detections: number; engines: string[] }
  | { outcome: 'scan_failed'; reason: string };

/**
 * Scanning is opt-in and requires BOTH switches: the `ENABLE_VIRUS_SCAN=true`
 * flag AND a configured API key. Either one missing skips scanning entirely.
 */
export function isVirusScanEnabled(): boolean {
  return config.ENABLE_VIRUS_SCAN && Boolean(config.VIRUSTOTAL_API_KEY);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Hand-rolled multipart body (dependency-free and independent of the Node
 * runtime's FormData typing). VT only needs a single `file` part.
 */
function buildMultipart(buffer: Buffer, filename: string): { body: Buffer; contentType: string } {
  const boundary = `----nookeb-${randomUUID()}`;
  const safeName = filename.replace(/["\r\n]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Upload a buffer to VirusTotal and poll the analysis until it completes
 * (5s interval, 60s budget). Never throws — every failure mode is folded into
 * a `scan_failed` verdict so the caller can decide to proceed.
 */
export async function scanBuffer(buffer: Buffer, filename: string): Promise<ScanVerdict> {
  const apiKey = config.VIRUSTOTAL_API_KEY;
  if (!apiKey) return { outcome: 'scan_failed', reason: 'VIRUSTOTAL_API_KEY not configured' };

  try {
    const { body, contentType } = buildMultipart(buffer, filename);
    const uploadRes = await fetch(`${VT_API}/files`, {
      method: 'POST',
      headers: { 'x-apikey': apiKey, 'Content-Type': contentType },
      body,
    });
    if (!uploadRes.ok) {
      return { outcome: 'scan_failed', reason: `VT upload failed: HTTP ${uploadRes.status}` };
    }
    const analysisId = ((await uploadRes.json()) as VtUploadResponse).data.id;

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(`${VT_API}/analyses/${encodeURIComponent(analysisId)}`, {
        headers: { 'x-apikey': apiKey },
      });
      if (!pollRes.ok) {
        return { outcome: 'scan_failed', reason: `VT poll failed: HTTP ${pollRes.status}` };
      }
      const analysis = (await pollRes.json()) as VtAnalysisResponse;
      if (analysis.data.attributes.status !== 'completed') continue;

      const { stats, results } = analysis.data.attributes;
      if (stats.malicious >= 1) {
        const engines = Object.values(results)
          .filter((r) => r.category === 'malicious')
          .map((r) => r.engine_name);
        return { outcome: 'malicious', detections: stats.malicious, engines };
      }
      return { outcome: 'clean' };
    }
    return {
      outcome: 'scan_failed',
      reason: `VT analysis not completed within ${(POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS) / 1000}s`,
    };
  } catch (err) {
    return {
      outcome: 'scan_failed',
      reason: `VT request error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

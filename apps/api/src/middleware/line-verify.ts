import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

/**
 * Verify X-Line-Signature: HMAC-SHA256 over the raw request body using the
 * channel secret, base64-encoded. MUST run on the raw bytes — parsing the
 * JSON first and re-serializing would break the signature.
 */
export function verifyLineSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', config.LINE_CHANNEL_SECRET).update(rawBody).digest();
  // Buffer.from(str, 'base64') never throws — malformed base64 just yields a
  // wrong-length buffer. The explicit length guard is the real defense (and
  // timingSafeEqual requires equal-length inputs).
  const received = Buffer.from(signature, 'base64');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

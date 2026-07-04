/**
 * One-off: upload the static LINE greeting image to R2 at a fixed key.
 * The image is served publicly via the API (routes/static.ts → /static/welcome.jpg),
 * which streams this object; the `follow` webhook event sends that URL to LINE.
 *
 * Run from apps/api:
 *   npx tsx --env-file=../../.env scripts/upload-greeting-image.ts
 */
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createR2Client, uploadStream } from '../src/services/r2.service';

const KEY = 'static/welcome.jpg';
const SRC = resolve(process.cwd(), '../../welcome.jpg');

async function main(): Promise<void> {
  const r2 = createR2Client();
  const { size } = await uploadStream(r2, KEY, createReadStream(SRC), 'image/jpeg');
  console.log(`uploaded ${size} bytes to R2 key=${KEY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

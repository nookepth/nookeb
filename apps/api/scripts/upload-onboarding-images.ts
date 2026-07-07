/**
 * One-off: upload the 7 static LINE onboarding images to R2 at fixed keys.
 * They are served publicly via the API (routes/static.ts → /static/onboarding/{n}.jpg),
 * which streams these objects; the `follow` and `join` webhook events send those URLs
 * to LINE in order (1 → 7). Same pattern as upload-greeting-image.ts.
 *
 * Run from apps/api:
 *   npx tsx --env-file=../../.env scripts/upload-onboarding-images.ts
 */
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createR2Client, uploadStream } from '../src/services/r2.service';

const COUNT = 7;
const key = (n: number) => `static/onboarding/${n}.jpg`;
// Source images live in the repo root as 1.jpg … 7.jpg
const src = (n: number) => resolve(process.cwd(), `../../${n}.jpg`);

async function main(): Promise<void> {
  const r2 = createR2Client();
  for (let n = 1; n <= COUNT; n++) {
    const path = src(n);
    if (!existsSync(path)) throw new Error(`missing source image: ${path}`);
    const { size } = await uploadStream(r2, key(n), createReadStream(path), 'image/jpeg');
    console.log(`uploaded ${size} bytes to R2 key=${key(n)}`);
  }
  console.log(`done — ${COUNT} onboarding images uploaded`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * One-off: upload the 9 numbered static LINE images to R2 at fixed keys.
 * They are served publicly via the API (routes/static.ts → /static/onboarding/{n}.jpg),
 * which streams these objects. 1 → 8 are the onboarding carousel (`follow` / `join`
 * events); 9 is the referral feature-preview card used by the "หนูเก็บเพิ่มเติม"
 * carousel. Same pattern as upload-greeting-image.ts.
 *
 * Idempotent — re-running overwrites each key with the repo-root source of the same
 * name. Keep COUNT in sync with ONBOARDING_COUNT in routes/static.ts.
 *
 * Run from apps/api:
 *   npx tsx --env-file=../../.env scripts/upload-onboarding-images.ts
 */
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createR2Client, uploadStream } from '../src/services/r2.service';

const COUNT = 9;
const key = (n: number) => `static/onboarding/${n}.jpg`;
// Source images live in the repo root as 1.jpg … 9.jpg
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

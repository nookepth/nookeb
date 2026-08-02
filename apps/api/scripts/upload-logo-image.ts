/**
 * One-off: upload the หนูเก็บ mascot logo to R2 at a fixed key.
 * It is served publicly via the API (routes/static.ts → /static/logo.png), which
 * streams this object; `cardHeader` in flex.service.ts uses that URL as the Flex
 * header avatar. Same public-asset pattern as upload-greeting-image.ts.
 *
 * Idempotent — re-running overwrites the key from the same web source of truth.
 *
 * Unlike the other two upload scripts this one does NOT stream the source
 * verbatim, for three reasons specific to this asset:
 *   1. the source is 3000x3000 / 1.4 MB, absurd for a 30px header avatar that
 *      every LINE client fetches on first render;
 *   2. it carries ~25% transparent padding, so at avatar size the mascot would
 *      shrink to roughly half the tile it sits in — `.trim()` reclaims that;
 *   3. the header box crops to a CIRCLE (cornerRadius 'full'), and a circle
 *      inscribed in a square cuts the corners off, so the trimmed mascot is
 *      re-padded onto a square canvas with a margin that keeps every limb
 *      inside the inscribed circle.
 * Alpha is preserved: the mascot is near-white and sits on the header's dark
 * gradient, which shows through the transparent corners on purpose.
 *
 * Run from apps/api:
 *   npx tsx --env-file=../../.env scripts/upload-logo-image.ts
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createR2Client, uploadStream } from '../src/services/r2.service';

const KEY = 'static/logo.png';
/** Source of truth is the web app's mascot — the SAME file the site renders. */
const SRC = resolve(process.cwd(), '../web/public/logo.png');

/** Rendered avatar edge, in px. 4x the largest size the card draws it at (30px). */
const EDGE = 120;
/**
 * Fraction of EDGE left as breathing room on each side. A circle inscribed in
 * the square clips ~14.6% off each corner; 10% padding keeps the mascot's
 * corners inside that circle without floating it in the middle of the tile.
 */
const PAD_RATIO = 0.1;

async function main(): Promise<void> {
  if (!existsSync(SRC)) throw new Error(`missing source image: ${SRC}`);

  const pad = Math.round(EDGE * PAD_RATIO);
  const inner = EDGE - pad * 2;

  const png = await sharp(SRC)
    // Drop the transparent margin baked into the source art.
    .trim()
    // `fit: 'contain'` keeps the mascot's own (taller-than-wide) proportions —
    // 'cover' would crop its head and feet to make it square.
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const r2 = createR2Client();
  const { size } = await uploadStream(r2, KEY, Readable.from(png), 'image/png');
  console.log(`uploaded ${size} bytes (${EDGE}x${EDGE} png) to R2 key=${KEY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

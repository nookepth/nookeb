// Pre-seed OCR assets:
//   - tessdata/{tha,eng}.traineddata  — tessdata_fast LSTM models (speed over
//     the last % of accuracy; ~7 MB total) for the tesseract.js singleton.
//     BEST-EFFORT: tesseract.js lazily re-downloads these at runtime, so a
//     failure here is non-fatal.
//   - assets/fonts/NotoSansThai-Regular.ttf — Thai-capable font for the
//     searchable-PDF invisible text layer (pdf-lib can't encode Thai with
//     standard fonts). REQUIRED as of FIX 16: scan-enhance.service.ts no
//     longer downloads it at runtime, it throws if the file is absent. A
//     failure here therefore exits non-zero.
//
// Plain Node (no deps): runs during `npm ci` before devDeps are guaranteed.
//
// FIX 16 — why the runtime fetch moved here.
// getThaiFontBytes() used to fetch a CDN URL on first use and write it into the
// container filesystem. That put a third-party host on the serving path of a
// user-visible feature, with no integrity check on the bytes it returned: a
// compromised or hijacked CDN response was written to disk and fed straight
// into pdf-lib. Fetching at build time behind a pinned SHA-256 makes the
// content auditable and turns "the CDN is down" into a build failure instead
// of a silent per-request degradation.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const THAI_FONT_PATH = path.join(ROOT, 'assets', 'fonts', 'NotoSansThai-Regular.ttf');
const THAI_FONT_URL =
  'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf';

/**
 * SHA-256 of NotoSansThai-Regular.ttf (37,780 bytes), verified against the CDN
 * response on 2026-08-02.
 *
 * jsdelivr's `gh/…` form serves the notofonts repo's DEFAULT BRANCH, so an
 * upstream font release changes these bytes and this check starts failing the
 * build. That is the intended behaviour, not a bug to work around: recompute
 * and update the constant DELIBERATELY, after looking at what changed.
 *
 *   node -e "const c=require('crypto'),f=require('fs');
 *     console.log(c.createHash('sha256')
 *     .update(f.readFileSync('apps/api/assets/fonts/NotoSansThai-Regular.ttf'))
 *     .digest('hex'))"
 */
const THAI_FONT_SHA256 = '61cf814eec46b294d6ea4401ac295d0cecd5207bd2331dcc5a15e7301d30ee44';

const ASSETS = [
  {
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/tha.traineddata',
    dest: path.join(ROOT, 'tessdata', 'tha.traineddata'),
    required: false,
  },
  {
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata',
    dest: path.join(ROOT, 'tessdata', 'eng.traineddata'),
    required: false,
  },
  {
    url: THAI_FONT_URL,
    dest: THAI_FONT_PATH,
    sha256: THAI_FONT_SHA256,
    required: true,
  },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download({ url, dest, sha256: expected }) {
  const rel = path.relative(ROOT, dest);

  if (fs.existsSync(dest)) {
    // A cached file with the wrong contents is worse than no file — it would
    // pass the runtime's existsSync check forever. Re-fetch instead of trusting
    // it. Unchecked assets (tessdata) keep the plain skip.
    if (!expected || sha256(fs.readFileSync(dest)) === expected) {
      console.log(`[download-tessdata] exists, skipping: ${rel}`);
      return;
    }
    console.warn(`[download-tessdata] cached ${rel} failed its integrity check — re-downloading`);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  if (expected) {
    const actual = sha256(bytes);
    if (actual !== expected) {
      // Write nothing. A mismatched font is either an upstream release (update
      // the constant on purpose) or a tampered response (do not put it on disk).
      throw new Error(
        `integrity check failed for ${rel}\n` +
          `  expected sha256 ${expected}\n` +
          `  actual   sha256 ${actual}\n` +
          `  source   ${url}`,
      );
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  console.log(
    `[download-tessdata] downloaded ${rel} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)${
      expected ? ' — sha256 ok' : ''
    }`,
  );
}

(async () => {
  let failedRequired = false;
  for (const asset of ASSETS) {
    try {
      await download(asset);
    } catch (err) {
      if (asset.required) {
        // No runtime fallback exists for this one any more (FIX 16).
        console.error(`[download-tessdata] REQUIRED asset failed: ${err.message}`);
        failedRequired = true;
      } else {
        // tesseract.js re-downloads these lazily at runtime.
        console.warn(
          `[download-tessdata] failed (will retry at runtime): ${asset.url}: ${err.message}`,
        );
      }
    }
  }
  if (failedRequired) {
    // Note: apps/api's `postinstall` swallows this with `|| exit 0`, on purpose
    // — a dev running `npm install` offline should not be blocked. The gate
    // that must NOT be swallowed is the explicit RUN step in apps/api/Dockerfile,
    // which invokes this script directly so a broken image fails at build time.
    process.exitCode = 1;
  }
})();

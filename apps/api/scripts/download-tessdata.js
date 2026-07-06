// Pre-seed OCR assets (postinstall, best-effort — the runtime lazily
// re-downloads anything missing, so every failure here is non-fatal):
//   - tessdata/{tha,eng}.traineddata  — tessdata_fast LSTM models (speed over
//     the last % of accuracy; ~7 MB total) for the tesseract.js singleton
//   - assets/fonts/NotoSansThai-Regular.ttf — Thai-capable font for the
//     searchable-PDF invisible text layer (pdf-lib can't encode Thai with
//     standard fonts)
// Plain Node (no deps): runs during `npm ci` before devDeps are guaranteed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const ASSETS = [
  {
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/tha.traineddata',
    dest: path.join(ROOT, 'tessdata', 'tha.traineddata'),
  },
  {
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata',
    dest: path.join(ROOT, 'tessdata', 'eng.traineddata'),
  },
  {
    url: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf',
    dest: path.join(ROOT, 'assets', 'fonts', 'NotoSansThai-Regular.ttf'),
  },
];

async function download({ url, dest }) {
  if (fs.existsSync(dest)) {
    console.log(`[download-tessdata] exists, skipping: ${path.relative(ROOT, dest)}`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  console.log(`[download-tessdata] downloaded ${path.relative(ROOT, dest)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

(async () => {
  for (const asset of ASSETS) {
    try {
      await download(asset);
    } catch (err) {
      // Non-fatal: tesseract.js / scan-enhance re-download lazily at runtime
      console.warn(`[download-tessdata] failed (will retry at runtime): ${asset.url}: ${err.message}`);
    }
  }
})();

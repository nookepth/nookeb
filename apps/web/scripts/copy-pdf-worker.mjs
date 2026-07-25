/**
 * Copy the pdf.js worker into public/ so it is served as a same-origin static
 * asset (referenced by FilePreviewModal's mobile PDF viewer as
 * `/pdf.worker.min.mjs`).
 *
 * Why not `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`?
 * That makes webpack emit the ES-module worker into static/media, and Next's
 * Terser pass then tries to minify the `.mjs` as a classic script and fails
 * with "'import'/'export' cannot be used outside of module code". Serving it
 * from public/ sidesteps webpack/Terser entirely and keeps it same-origin, so
 * the CSP worker-src ('self', via script-src) already allows it.
 *
 * Runs from the `predev` / `prebuild` npm hooks so the copy is always in sync
 * with the installed pdfjs-dist version.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve the worker relative to the installed pdfjs-dist package so a version
// bump is picked up automatically.
const pkgJson = require.resolve('pdfjs-dist/package.json');
const workerSrc = join(dirname(pkgJson), 'build', 'pdf.worker.min.mjs');
const dest = join(webRoot, 'public', 'pdf.worker.min.mjs');

await mkdir(dirname(dest), { recursive: true });
await copyFile(workerSrc, dest);
console.log(`[copy-pdf-worker] ${workerSrc} -> ${dest}`);

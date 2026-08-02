import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import sharp from 'sharp';
import { processScanPage } from './scan-enhance.service';

/**
 * Regression pass over REAL photographs, as opposed to the SVG fixtures in
 * scan-enhance.service.test.ts.
 *
 * Synthetic fixtures can only reproduce the failure modes we already understand
 * — they are built from the diagnosis, so they cannot contradict it. The cases
 * that actually break document detection (wood grain, patterned tablecloths,
 * mixed daylight and lamp light, phone HDR, JPEG noise) are photographic
 * properties that no hand-written SVG contains.
 *
 * The fixture directory is gitignored and normally empty, so this file SKIPS on
 * a clean checkout and in CI. Drop photos in to activate it — see the README
 * next to them.
 */
const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'scan');
const OUT_DIR = path.join(FIXTURE_DIR, 'out');
const IMAGE_RE = /\.(jpe?g|png)$/i;

async function listFixtures(): Promise<string[]> {
  if (!existsSync(FIXTURE_DIR)) return [];
  const entries = await fs.readdir(FIXTURE_DIR);
  return entries.filter((name) => IMAGE_RE.test(name)).sort();
}

/** Mean luma of a corner box — "is this corner paper, or still the table?" */
async function cornerLuma(jpeg: Buffer, corner: 'tl' | 'tr' | 'bl' | 'br'): Promise<number> {
  const { data, info } = await sharp(jpeg).grayscale().raw().toBuffer({ resolveWithObject: true });
  const bw = Math.max(1, Math.round(info.width * 0.06));
  const bh = Math.max(1, Math.round(info.height * 0.06));
  const x0 = corner === 'tl' || corner === 'bl' ? 0 : info.width - bw;
  const y0 = corner === 'tl' || corner === 'tr' ? 0 : info.height - bh;
  let sum = 0;
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) sum += data[y * info.width + x]!;
  }
  return sum / (bw * bh);
}

test('real scan fixtures: pipeline invariants hold on actual photographs', async (t) => {
  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    t.skip(`no fixtures in ${path.relative(process.cwd(), FIXTURE_DIR)} — see its README`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  for (const name of fixtures) {
    const input = await fs.readFile(path.join(FIXTURE_DIR, name));
    const source = await sharp(input).rotate().metadata();
    const stem = name.replace(IMAGE_RE, '');

    for (const mode of ['bw', 'color'] as const) {
      const result = await processScanPage(input, mode, `real=${name} mode=${mode}`);
      const meta = await sharp(result.jpeg).metadata();

      // Written out so the crop can actually be LOOKED at — the assertions
      // below can only check invariants, not whether it looks right.
      await fs.writeFile(path.join(OUT_DIR, `${stem}.${mode}.jpg`), result.jpeg);

      console.log(
        `[real] ${name} (${mode}): ${source.width}x${source.height} → ${meta.width}x${meta.height} ` +
          `edge=${result.edgeDetection} recrops=${result.refinePasses} ` +
          `border=${result.borderDirty.toFixed(3)} turn=${result.quarterTurn}`,
      );

      // ISSUE 1 — no edge-detection complaint may reach the user, ever.
      assert.ok(
        !result.warnings.some((w) => w.includes('ตรวจจับขอบเอกสาร')),
        `${name} (${mode}): edge-detection failure must not warn the user`,
      );
      // ISSUE 2 — the re-crop loop is bounded.
      assert.ok(
        result.refinePasses >= 0 && result.refinePasses <= 2,
        `${name} (${mode}): refinePasses out of budget (${result.refinePasses})`,
      );
      // A decodable page always comes out, whatever detection decided.
      assert.equal(meta.format, 'jpeg', `${name} (${mode}): expected a JPEG`);

      // Opt-in, by filename: this photo has background that MUST be cropped off.
      if (name.includes('expect-crop')) {
        assert.equal(
          result.edgeDetection,
          'detected',
          `${name} (${mode}): expected the document to be found`,
        );
        const shrank =
          (meta.width ?? 0) < (source.width ?? 0) * 0.95 ||
          (meta.height ?? 0) < (source.height ?? 0) * 0.95;
        assert.ok(shrank, `${name} (${mode}): nothing was cropped away`);
        for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
          const luma = await cornerLuma(result.jpeg, corner);
          assert.ok(
            luma > 170,
            `${name} (${mode}): ${corner} corner is not paper (luma ${luma.toFixed(0)}) — background left in frame`,
          );
        }
        assert.ok(
          result.borderDirty < 0.22,
          `${name} (${mode}): border still dirty after refinement (${result.borderDirty.toFixed(3)})`,
        );
      }
    }
  }
});

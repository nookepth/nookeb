/**
 * LINE Rich Menu setup — หนูเก็บ two-page A/B menu (2500x1686 each)
 *
 * Menu A (หน้าแรก, richmenu_1.jpg) ⇄ Menu B (หน้าคำสั่ง, richmenu_2.jpg),
 * linked via rich menu aliases + `richmenuswitch` actions. Menu A is set as
 * the default for all users.
 *
 * Every `message` action's text is an existing handler in
 * src/routes/webhook/line.ts — keep them in sync. The switch taps arrive as
 * `postback` events with data "switch", which the webhook silently ignores
 * (unprefixed, unrecognized → quiet-chatter rule).
 *
 * Run (from apps/api):
 *   npx tsx --env-file=../../.env scripts/setup-rich-menu-ab.ts
 *
 * Safety: does NOT delete existing menus unless CLEANUP_OLD_MENUS=1 — this is
 * deliberate; a blanket delete-others step is what destroyed the original A/B
 * pair (see setup-rich-menu-large.ts step 7).
 */
/**
 * ⚠️  RICH MENU POLICY — DO NOT MODIFY WITHOUT EXPLICIT APPROVAL
 * ---------------------------------------------------------------
 * This project uses a fixed two-page A/B rich menu design:
 *   Page A: richmenu_1.jpg (หน้าแรก)   — default for all users
 *   Page B: richmenu_2.jpg (หน้าคำสั่ง) — reachable via switch button
 *
 * Aliases: richmenu-alias-a (→ Menu A) / richmenu-alias-b (→ Menu B)
 *
 * Rules:
 *   1. Never run setup-rich-menu-large.ts — it deletes ALL menus including A/B
 *   2. Never delete menus via LINE API without explicit user confirmation
 *   3. To re-register: run THIS script only (setup-rich-menu-ab.ts)
 *   4. Old-menu deletion is OPT-IN only: CLEANUP_OLD_MENUS=1
 *   5. Do not add, remove, or rearrange button areas without approval
 * ---------------------------------------------------------------
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';
const WIDTH = 2500;
const HEIGHT = 1686;
const COL_W = 833;
const CENTER_W = 834; // centre column is 834 so the row sums to 2500
const ROW_H = 843;
const MAX_IMAGE_BYTES = 1024 * 1024; // LINE hard limit: 1 MB
const ALIAS_A = 'richmenu-alias-a';
const ALIAS_B = 'richmenu-alias-b';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const auth = { Authorization: `Bearer ${token ?? ''}` };

async function lineFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

type Action = Record<string, string>;

/** 3x2 grid cell (same geometry as the previous nookeb-main-6 menu). */
const cell = (col: 0 | 1 | 2, row: 0 | 1, action: Action) => ({
  bounds: {
    x: col === 0 ? 0 : col === 1 ? COL_W : COL_W + CENTER_W,
    y: row * ROW_H,
    width: col === 1 ? CENTER_W : COL_W,
    height: ROW_H,
  },
  action,
});
const msg = (text: string, label: string): Action => ({ type: 'message', text, label });
const toB: Action = { type: 'richmenuswitch', richMenuAliasId: ALIAS_B, data: 'switch', label: 'หน้าคำสั่ง' };
const toA: Action = { type: 'richmenuswitch', richMenuAliasId: ALIAS_A, data: 'switch', label: 'หน้าแรก' };

const MENU_A = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: 'nookeb-page-a',
  chatBarText: 'เมนูหนูเก็บ',
  areas: [
    cell(0, 0, { type: 'uri', uri: 'https://nookeb-web.vercel.app/dashboard', label: 'ล็อกเกอร์' }),
    cell(1, 0, { type: 'uri', uri: 'https://nookeb-web.vercel.app/', label: 'แนะนำตัว' }),
    cell(2, 0, msg('หนูเก็บ', 'เรียกหนูเก็บ')),
    cell(0, 1, msg('หนูเก็บวิธีใช้', 'วิธีใช้งาน')),
    cell(1, 1, msg('ติดต่อหนูเก็บ', 'ติดต่อหนูเก็บ')),
    cell(2, 1, toB),
  ],
};

const MENU_B = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: 'nookeb-page-b',
  chatBarText: 'เมนูหนูเก็บ',
  areas: [
    cell(0, 0, msg('หนูเก็บไดอารี่', 'ไดอารี่ 365 วัน')),
    cell(1, 0, msg('หนูเก็บคำสั่ง', 'คำสั่งทั้งหมด')),
    cell(2, 0, msg('หนูเก็บรวมรูป', 'รวมรูปเป็น PDF')),
    cell(0, 1, msg('หนูเก็บแปลงไฟล์', 'แปลงไฟล์เป็น DOC')),
    cell(1, 1, msg('หนูเก็บสแกน', 'สแกนเอกสารเป็น PDF')),
    cell(2, 1, toA),
  ],
};

async function loadImage(path: string): Promise<{ buf: Buffer; type: string }> {
  const buf = await readFile(path);
  const meta = await sharp(buf).metadata();
  if (meta.width !== WIDTH || meta.height !== HEIGHT) {
    throw new Error(`${path}: ${meta.width}x${meta.height} — ต้องเป็น ${WIDTH}x${HEIGHT}px`);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${path}: เกิน 1 MB (LINE limit)`);
  if (meta.format !== 'jpeg' && meta.format !== 'png') throw new Error(`${path}: ต้องเป็น PNG/JPEG`);
  return { buf, type: meta.format === 'png' ? 'image/png' : 'image/jpeg' };
}

async function createMenu(def: object, imagePath: string): Promise<string> {
  const { buf, type } = await loadImage(imagePath);
  const res = await lineFetch(`${LINE_API}/richmenu`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  const { richMenuId } = (await res.json()) as { richMenuId: string };
  await lineFetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': type },
    body: new Uint8Array(buf),
  });
  console.log(`✓ created ${richMenuId} (${imagePath})`);
  return richMenuId;
}

/** Point alias at menu — update if it already exists (ours dangle), create otherwise. */
async function setAlias(aliasId: string, richMenuId: string): Promise<void> {
  const update = await fetch(`${LINE_API}/richmenu/alias/${aliasId}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ richMenuId }),
  });
  if (update.ok) {
    console.log(`✓ alias ${aliasId} → ${richMenuId} (updated)`);
    return;
  }
  await lineFetch(`${LINE_API}/richmenu/alias`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
  });
  console.log(`✓ alias ${aliasId} → ${richMenuId} (created)`);
}

async function main(): Promise<void> {
  if (!token) throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน env');
  const root = resolve(process.cwd(), '../..'); // repo root when run from apps/api

  const before = (
    (await (await lineFetch(`${LINE_API}/richmenu/list`, { headers: auth })).json()) as {
      richmenus: { richMenuId: string }[];
    }
  ).richmenus;
  console.log(`→ เมนูเดิมบน LINE: ${before.length} อัน`);

  const idA = await createMenu(MENU_A, resolve(root, 'richmenu_1.jpg'));
  const idB = await createMenu(MENU_B, resolve(root, 'richmenu_2.jpg'));
  await setAlias(ALIAS_A, idA);
  await setAlias(ALIAS_B, idB);

  await lineFetch(`${LINE_API}/user/all/richmenu/${idA}`, { method: 'POST', headers: auth });
  console.log(`✓ menu A (${idA}) ตั้งเป็น default แล้ว`);

  if (process.env.CLEANUP_OLD_MENUS === '1') {
    for (const m of before) {
      if (m.richMenuId === idA || m.richMenuId === idB) continue;
      try {
        await lineFetch(`${LINE_API}/richmenu/${m.richMenuId}`, { method: 'DELETE', headers: auth });
        console.log(`  ลบเมนูเดิม: ${m.richMenuId}`);
      } catch (err) {
        console.log(`  ⚠ ลบ ${m.richMenuId} ไม่สำเร็จ: ${(err as Error).message}`);
      }
    }
  } else if (before.length > 0) {
    console.log(`⚠ เมนูเดิม ${before.length} อันยังอยู่ (รันซ้ำด้วย CLEANUP_OLD_MENUS=1 เพื่อลบ)`);
  }

  console.log(`\nเสร็จเรียบร้อย ✓\n  menu A (default) : ${idA}\n  menu B           : ${idB}`);
}

main().catch((err) => {
  console.error(`\n✗ ล้มเหลว: ${(err as Error).message}`);
  process.exit(1);
});

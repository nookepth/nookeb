/**
 * LINE Rich Menu setup — หนูเก็บ SINGLE menu (RichMenu_Nookeb, 2500x1686)
 *
 * Replaces the retired two-page A/B design (see setup-rich-menu-ab.ts, kept as
 * an archive). There is ONE menu, set as the default for all users — no
 * aliases, no `richmenuswitch`, no page B.
 *
 * Every `message` action's text is an existing handler in
 * src/routes/webhook/line.ts — keep them in sync:
 *   หนูเก็บฟีเจอร์เอกสาร · หนูเก็บไดอารี่ · หนูเก็บเพิ่มเติม · ติดต่อหนูเก็บ
 *
 * DESTRUCTIVE: this script deletes EVERY existing rich menu on the channel
 * (and the two legacy aliases) before creating the new one. That is the point —
 * the A/B pair must not linger as a second default. Not reversible via the API.
 *
 * Run (from apps/api):
 *   npx tsx --env-file=../../.env scripts/setup-rich-menu-single.ts
 *
 * Optional first CLI arg: path to an alternative 2500x1686 PNG/JPEG
 * (default: New_1.jpg at the repo root).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

const WIDTH = 2500;
const HEIGHT = 1686;
const MAX_IMAGE_BYTES = 1024 * 1024; // LINE hard limit: 1 MB
const DEFAULT_IMAGE = 'New_1.jpg'; // repo root

/** Legacy A/B aliases — deleted so a re-run can never collide with them. */
const LEGACY_ALIASES = ['richmenu-alias-a', 'richmenu-alias-b'];

const token = config.LINE_CHANNEL_ACCESS_TOKEN;
const auth = { Authorization: `Bearer ${token}` };

async function lineFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/**
 * The `uri` actions are baked into the menu permanently — a localhost WEB_URL
 * here ships broken links to every user of the OA (same guard as
 * setup-rich-menu.ts).
 */
function resolveWebUrl(): string {
  const webUrl = config.WEB_URL.replace(/\/+$/, '');
  if (webUrl.includes('localhost') && process.env.RICH_MENU_ALLOW_LOCALHOST !== '1') {
    throw new Error(
      `WEB_URL resolves to "${config.WEB_URL}" — refusing to bake a localhost URL into the rich menu. ` +
        'Set WEB_URL to the production web URL (or RICH_MENU_ALLOW_LOCALHOST=1 to override).',
    );
  }
  return webUrl;
}

/**
 * The 7 zones of New_1.jpg. They tile the full 2500x1686 canvas with no gaps
 * and no overlaps:
 *   rows    0–843 (zones 1–2) · 843–1686 (zones 3–7)
 *   bottom  800 + 720 + 980 = 2500 · right column 407 + 436 = 843
 */
function buildMenu(webUrl: string): object {
  return {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name: 'RichMenu_Nookeb',
    chatBarText: 'เมนู',
    areas: [
      // 1 — OPEN LOCKER (top-left)
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'ล็อคเกอร์', uri: `${webUrl}/dashboard` },
      },
      // 2 — สร้างงาน (top-right) — opens the web task dashboard directly
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'สร้างงาน', uri: `${webUrl}/dashboard/tasks` },
      },
      // 3 — ฟีเจอร์เอกสาร (bottom-left)
      {
        bounds: { x: 0, y: 843, width: 800, height: 843 },
        action: { type: 'message', label: 'ฟีเจอร์เอกสาร', text: 'หนูเก็บฟีเจอร์เอกสาร' },
      },
      // 4 — บันทึกไดอารี่ (bottom-centre)
      {
        bounds: { x: 800, y: 843, width: 720, height: 843 },
        action: { type: 'message', label: 'บันทึกไดอารี่', text: 'หนูเก็บไดอารี่' },
      },
      // 5 — รวมคำสั่ง (bottom-right, upper-left)
      {
        bounds: { x: 1520, y: 843, width: 430, height: 407 },
        action: { type: 'message', label: 'รวมคำสั่ง', text: 'หนูเก็บเพิ่มเติม' },
      },
      // 6 — Nookeb Website (bottom-right, upper-right)
      {
        bounds: { x: 1950, y: 843, width: 550, height: 407 },
        action: { type: 'uri', label: 'เว็บไซต์หนูเก็บ', uri: `${webUrl}/` },
      },
      // 7 — ช่วยเหลือ / เสนอไอเดีย (bottom-right, lower)
      {
        bounds: { x: 1520, y: 1250, width: 980, height: 436 },
        action: { type: 'message', label: 'ช่วยเหลือ', text: 'ติดต่อหนูเก็บ' },
      },
    ],
  };
}

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

/** Delete a legacy alias. A missing alias (404) is the expected happy path. */
async function deleteAlias(aliasId: string): Promise<void> {
  const res = await fetch(`${LINE_API}/richmenu/alias/${aliasId}`, {
    method: 'DELETE',
    headers: auth,
  });
  if (res.ok) {
    console.log(`✅ ลบ alias ${aliasId}`);
  } else if (res.status === 404) {
    console.log(`✅ alias ${aliasId} ไม่มีอยู่แล้ว (ข้าม)`);
  } else {
    console.log(`❌ ลบ alias ${aliasId} ไม่สำเร็จ: ${res.status} ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  if (!token) throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน env');
  const webUrl = resolveWebUrl();
  const imagePath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), '../..', DEFAULT_IMAGE); // repo root when run from apps/api

  console.log(`→ WEB_URL        : ${webUrl}`);
  console.log(`→ LINE_LIFF_ID   : ${config.LINE_LIFF_ID ?? '(unset — ไม่ได้ใช้ในเมนูนี้)'}`);
  console.log(`→ image          : ${imagePath}`);

  // Validate the image BEFORE deleting anything — a bad image must not leave
  // the channel with zero menus.
  const { buf, type } = await loadImage(imagePath);
  console.log(`✅ ตรวจรูปผ่าน (${WIDTH}x${HEIGHT}, ${(buf.length / 1024).toFixed(0)} KB, ${type})`);

  // 1. Delete every existing rich menu
  const existing = (
    (await (await lineFetch(`${LINE_API}/richmenu/list`, { headers: auth })).json()) as {
      richmenus: { richMenuId: string }[];
    }
  ).richmenus;
  console.log(`→ เมนูเดิมบน LINE: ${existing.length} อัน`);
  for (const menu of existing) {
    try {
      await lineFetch(`${LINE_API}/richmenu/${menu.richMenuId}`, { method: 'DELETE', headers: auth });
      console.log(`✅ ลบเมนูเดิม ${menu.richMenuId}`);
    } catch (err) {
      console.log(`❌ ลบ ${menu.richMenuId} ไม่สำเร็จ: ${(err as Error).message}`);
    }
  }

  // 2. Delete the legacy A/B aliases (404 = already gone)
  for (const aliasId of LEGACY_ALIASES) await deleteAlias(aliasId);

  // 3. Create the single menu
  const createRes = await lineFetch(`${LINE_API}/richmenu`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMenu(webUrl)),
  });
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  console.log(`✅ สร้างเมนู RichMenu_Nookeb: ${richMenuId}`);

  // 4. Upload the image
  await lineFetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': type },
    body: new Uint8Array(buf),
  });
  console.log('✅ อัปโหลดรูปเมนูแล้ว');

  // 5. Set as the default for all users
  await lineFetch(`${LINE_API}/user/all/richmenu/${richMenuId}`, { method: 'POST', headers: auth });
  console.log(`✅ ตั้งเป็น default rich menu แล้ว (${richMenuId})`);

  console.log(`\nเสร็จเรียบร้อย ✓\n  RichMenu_Nookeb (default): ${richMenuId}`);
}

main().catch((err) => {
  console.error(`\n❌ ล้มเหลว: ${(err as Error).message}`);
  process.exit(1);
});

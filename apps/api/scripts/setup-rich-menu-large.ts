/**
 * LINE Rich Menu setup — หนูเก็บ "large" 6-cell menu (2500 x 1686)
 *
 * Layout (3 columns x 2 rows, each cell 833/834 x 843):
 *   ┌───────────────┬───────────────┬───────────────┐
 *   │ ล็อคเกอร์     │ แนะนำตัว       │ รวมรูปเป็น PDF  │   row 0 (y 0..843)
 *   ├───────────────┼───────────────┼───────────────┤
 *   │ วิธีใช้งาน      │ สแกนรูปเป็น PDF │ ช่วยเหลือ       │   row 1 (y 843..1686)
 *   └───────────────┴───────────────┴───────────────┘
 *
 * The bot has NO postback handler (see apps/api/src/routes/webhook/line.ts), so the
 * cells use `uri` (ล็อคเกอร์ → dashboard) and `message` actions whose trigger words
 * the webhook's text-command handler understands. Keep these in sync with that handler.
 *
 * What it does: validates the image against LINE's spec → creates the rich menu →
 * uploads the image → sets it as the default for all users → deletes older menus.
 *
 * Env (read directly from process.env):
 *   LINE_CHANNEL_ACCESS_TOKEN   (required) — Messaging API channel access token
 *   WEB_URL                     (optional) — dashboard base URL for the ล็อคเกอร์ cell
 *                                            (default http://localhost:3000; localhost is
 *                                            refused unless RICH_MENU_ALLOW_LOCALHOST=1)
 *   RICH_MENU_IMAGE             (optional) — path to the menu image (default ./rich_menu.png)
 *   RICH_MENU_ALLOW_LOCALHOST   (optional) — set to 1 to allow a localhost dashboard URL
 *
 * Run (from apps/api, loads the repo-root .env):
 *   npx tsx --env-file=../../.env scripts/setup-rich-menu-large.ts [path/to/rich_menu.png]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

// LINE "large" rich menu spec
const WIDTH = 2500;
const HEIGHT = 1686;
const COL_W = 833; // left/right columns; centre column is 834 so the row sums to 2500
const CENTER_W = WIDTH - COL_W * 2; // 834
const ROW_H = HEIGHT / 2; // 843
const MAX_IMAGE_BYTES = 1024 * 1024; // LINE hard limit: 1 MB

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const authHeaders = { Authorization: `Bearer ${token ?? ''}` };

interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action:
    | { type: 'uri'; uri: string; label?: string }
    | { type: 'message'; text: string; label?: string };
}

function log(msg: string): void {
  console.log(msg);
}

/** fetch wrapper that turns non-2xx responses into readable errors. */
async function lineFetch(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`${init.method ?? 'GET'} ${url} — network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  return res;
}

/** Validate the image against LINE's rich-menu spec before we create anything. */
async function loadAndValidateImage(imagePath: string): Promise<{ buffer: Buffer; contentType: string }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(imagePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(
        `ไม่พบไฟล์รูป rich menu ที่: ${imagePath}\n` +
          `วางไฟล์ไว้ตรงนั้น หรือส่ง path เป็น argument / ตั้ง RICH_MENU_IMAGE น้า`,
      );
    }
    throw err;
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error(`อ่านรูปไม่ได้ (ไฟล์อาจไม่ใช่รูปภาพ): ${imagePath}`);
  }

  const problems: string[] = [];

  const format = meta.format; // 'png' | 'jpeg' | ...
  if (format !== 'png' && format !== 'jpeg') {
    problems.push(`- format ต้องเป็น PNG หรือ JPEG แต่ไฟล์นี้เป็น "${format ?? 'unknown'}"`);
  }
  if (meta.width !== WIDTH || meta.height !== HEIGHT) {
    problems.push(`- ขนาดต้องเป็น ${WIDTH}x${HEIGHT}px แต่ไฟล์นี้เป็น ${meta.width ?? '?'}x${meta.height ?? '?'}px`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    problems.push(
      `- ไฟล์ใหญ่เกินไป: ${(buffer.length / 1024 / 1024).toFixed(2)} MB (LINE จำกัดไม่เกิน 1 MB) — ลองบีบอัดรูปก่อนน้า`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`รูป rich menu ไม่ตรงสเปค LINE:\n${problems.join('\n')}`);
  }

  log(`✓ รูปผ่านการตรวจสอบ: ${format?.toUpperCase()} ${meta.width}x${meta.height}px, ${(buffer.length / 1024).toFixed(0)} KB`);
  return { buffer, contentType: format === 'png' ? 'image/png' : 'image/jpeg' };
}

/** Resolve the dashboard URL for the ล็อคเกอร์ cell, guarding against baking in localhost. */
function resolveDashboardUri(): string {
  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  const uri = `${webUrl.replace(/\/+$/, '')}/dashboard`;
  if (uri.includes('localhost') && process.env.RICH_MENU_ALLOW_LOCALHOST !== '1') {
    throw new Error(
      `WEB_URL = "${webUrl}" → ล็อคเกอร์ จะลิงก์ไป localhost ซึ่งใช้ไม่ได้กับผู้ใช้จริง\n` +
        `ตั้ง WEB_URL เป็น URL production (หรือ RICH_MENU_ALLOW_LOCALHOST=1 ถ้าตั้งใจทดสอบ localhost)`,
    );
  }
  return uri;
}

function buildAreas(dashboardUri: string): RichMenuArea[] {
  const x0 = 0;
  const x1 = COL_W; // 833
  const x2 = COL_W + CENTER_W; // 1667
  const y0 = 0;
  const y1 = ROW_H; // 843

  return [
    // Row 0
    {
      bounds: { x: x0, y: y0, width: COL_W, height: ROW_H },
      action: { type: 'uri', uri: 'https://nookeb-web.vercel.app', label: 'ล็อคเกอร์' },
    },
    {
      bounds: { x: x1, y: y0, width: CENTER_W, height: ROW_H },
      action: { type: 'message', text: 'หนูเก็บแนะนำตัว', label: 'แนะนำตัว' },
    },
    {
      bounds: { x: x2, y: y0, width: COL_W, height: ROW_H },
      action: { type: 'message', text: 'หนูเก็บรวมรูป', label: 'รวมรูปเป็น PDF' },
    },
    // Row 1
    {
      bounds: { x: x0, y: y1, width: COL_W, height: ROW_H },
      action: { type: 'message', text: 'หนูเก็บวิธีใช้', label: 'วิธีใช้งาน' },
    },
    {
      bounds: { x: x1, y: y1, width: CENTER_W, height: ROW_H },
      action: { type: 'message', text: 'หนูเก็บสแกน', label: 'สแกนรูปเป็น PDF' },
    },
    {
      bounds: { x: x2, y: y1, width: COL_W, height: ROW_H },
      action: { type: 'message', text: 'หนูเก็บช่วยเหลือ', label: 'ช่วยเหลือ' },
    },
  ];
}

async function main(): Promise<void> {
  if (!token) {
    throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน env — ตั้งค่าก่อนรันน้า');
  }

  const imagePath = resolve(process.cwd(), process.argv[2] ?? process.env.RICH_MENU_IMAGE ?? 'rich_menu.png');
  log(`→ รูป rich menu: ${imagePath}`);

  // 1. Validate the image up front (fail fast before touching the LINE API)
  const { buffer, contentType } = await loadAndValidateImage(imagePath);

  // 2. Resolve the dashboard link + build the 6 tap areas
  const dashboardUri = resolveDashboardUri();
  log(`→ ล็อคเกอร์ ลิงก์ไป: ${dashboardUri}`);
  const areas = buildAreas(dashboardUri);

  // 3. List existing menus (removed after the new one is live)
  const listRes = await lineFetch(`${LINE_API}/richmenu/list`, { headers: authHeaders });
  const existing = ((await listRes.json()) as { richmenus: { richMenuId: string }[] }).richmenus;
  log(`→ พบ rich menu เดิม ${existing.length} อัน`);

  // 4. Create the rich menu definition
  const createRes = await lineFetch(`${LINE_API}/richmenu`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: WIDTH, height: HEIGHT },
      selected: true,
      name: 'nookeb-main-6',
      chatBarText: 'เมนูหนูเก็บ',
      areas,
    }),
  });
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  log(`✓ สร้าง rich menu: ${richMenuId}`);

  // 5. Upload the image
  await lineFetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': contentType },
    body: new Uint8Array(buffer),
  });
  log('✓ อัปโหลดรูป rich menu แล้ว');

  // 6. Set as the default menu for every user
  await lineFetch(`${LINE_API}/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: authHeaders,
  });
  log('✓ ตั้งเป็น default rich menu แล้ว');

  // 7. Remove old menus (best-effort — don't fail the whole run if one delete errors)
  let deleted = 0;
  for (const menu of existing) {
    if (menu.richMenuId === richMenuId) continue;
    try {
      await lineFetch(`${LINE_API}/richmenu/${menu.richMenuId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      deleted++;
      log(`  ลบ rich menu เดิม: ${menu.richMenuId}`);
    } catch (err) {
      log(`  ⚠ ลบ rich menu เดิม ${menu.richMenuId} ไม่สำเร็จ: ${(err as Error).message}`);
    }
  }

  log('');
  log('เสร็จเรียบร้อย ✓');
  log(`  rich menu id : ${richMenuId}`);
  log(`  ลบเมนูเดิม     : ${deleted}/${existing.length}`);
}

main().catch((err) => {
  console.error(`\n✗ ล้มเหลว: ${(err as Error).message}`);
  process.exit(1);
});

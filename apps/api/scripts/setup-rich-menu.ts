/**
 * LINE Rich Menu setup (Phase 2)
 *
 * Creates the หนูเก็บ rich menu (คลัง / ค้นหา / วิธีใช้), uploads its image,
 * sets it as the default for all users, and removes older rich menus.
 *
 * Run:  npx tsx --env-file=../../.env scripts/setup-rich-menu.ts [custom-image.png]
 * The optional argument is a 2500x843 PNG/JPEG to use instead of the generated image.
 */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../src/config';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';
const authHeaders = { Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` };

const WIDTH = 2500;
const HEIGHT = 843;
const CELL = WIDTH / 3;

function menuSvg(): string {
  const labels = ['📂 คลังไฟล์', '📸 สแกน PDF', '💡 วิธีใช้'];
  const cells = labels
    .map(
      (label, i) => `
    <rect x="${i * CELL + 24}" y="24" width="${CELL - 48}" height="${HEIGHT - 48}" rx="32" fill="#ffffff"/>
    <text x="${i * CELL + CELL / 2}" y="${HEIGHT / 2 + 24}" font-size="96" font-family="sans-serif"
          text-anchor="middle" fill="#3730a3">${label}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#e0e7ff"/>${cells}
  </svg>`;
}

async function buildImage(customPath?: string): Promise<Buffer> {
  if (customPath) return readFile(customPath);
  return sharp(Buffer.from(menuSvg())).png().toBuffer();
}

async function lineFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function main(): Promise<void> {
  // 1. Existing menus (cleaned up after the new one is live)
  const listRes = await lineFetch(`${LINE_API}/richmenu/list`, { headers: authHeaders });
  const existing = ((await listRes.json()) as { richmenus: { richMenuId: string }[] }).richmenus;

  // 2. Create the menu definition
  const createRes = await lineFetch(`${LINE_API}/richmenu`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: WIDTH, height: HEIGHT },
      selected: true,
      name: 'nookeb-main',
      chatBarText: 'เมนู',
      areas: [
        {
          bounds: { x: 0, y: 0, width: CELL, height: HEIGHT },
          action: { type: 'uri', uri: `${config.WEB_URL}/dashboard` },
        },
        {
          bounds: { x: CELL, y: 0, width: CELL, height: HEIGHT },
          action: { type: 'message', text: 'สแกน' },
        },
        {
          bounds: { x: CELL * 2, y: 0, width: CELL, height: HEIGHT },
          action: { type: 'message', text: 'วิธีใช้' },
        },
      ],
    }),
  });
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  console.log(`created rich menu: ${richMenuId}`);

  // 3. Upload the image
  const image = await buildImage(process.argv[2]);
  await lineFetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  });
  console.log('uploaded rich menu image');

  // 4. Set as default for all users
  await lineFetch(`${LINE_API}/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: authHeaders,
  });
  console.log('set as default rich menu');

  // 5. Remove old menus
  for (const menu of existing) {
    if (menu.richMenuId === richMenuId) continue;
    await lineFetch(`${LINE_API}/richmenu/${menu.richMenuId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    console.log(`deleted old rich menu: ${menu.richMenuId}`);
  }

  console.log('done ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

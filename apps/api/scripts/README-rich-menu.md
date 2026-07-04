# Rich Menu — หนูเก็บ (large 6-cell)

Script: [`setup-rich-menu-large.ts`](./setup-rich-menu-large.ts)
Creates the **2500 × 1686** LINE rich menu (3 columns × 2 rows), uploads the image,
sets it as the default menu for all users, and deletes older menus.

## Layout & actions

| Cell | Label | Bounds (x, y, w, h) | Action |
|------|-------|---------------------|--------|
| Top-Left | ล็อคเกอร์ | `0, 0, 833, 843` | `uri` → `WEB_URL/dashboard` |
| Top-Center | แนะนำตัว | `833, 0, 834, 843` | `message` "แนะนำตัว" → bot self-intro |
| Top-Right | รวมรูปเป็น PDF | `1667, 0, 833, 843` | `message` "รวมรูปเป็น PDF" → start scan mode |
| Bottom-Left | วิธีใช้งาน | `0, 843, 833, 843` | `message` "วิธีใช้งาน" → usage guide |
| Bottom-Center | ช่วยเหลือ | `833, 843, 834, 843` | `message` "ช่วยเหลือ" → support text |
| Bottom-Right | สแกนรูปเป็น PDF | `1667, 843, 833, 843` | `message` "สแกนรูปเป็น PDF" → start scan mode |

> **Why `message`, not `postback`?** The webhook has no postback handler — rich-menu
> buttons send these Thai trigger words as text, which the command handler in
> [`src/routes/webhook/line.ts`](../src/routes/webhook/line.ts) recognizes. If you rename
> a label here, update that handler too.

## Image requirements (validated before upload)

- Format: **PNG or JPEG**
- Size: exactly **2500 × 1686 px**
- File size: **≤ 1 MB** (LINE's hard limit)

If the file is missing or doesn't match, the script stops and tells you what's wrong —
nothing is created on LINE.

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | Messaging API channel access token |
| `WEB_URL` | – | Dashboard base URL for the ล็อคเกอร์ cell (default `http://localhost:3000`). A `localhost` value is **refused** unless `RICH_MENU_ALLOW_LOCALHOST=1`. |
| `RICH_MENU_IMAGE` | – | Path to the image (default `./rich_menu.png`, relative to where you run the command). Can also be passed as the first CLI argument. |
| `RICH_MENU_ALLOW_LOCALHOST` | – | Set to `1` to allow a `localhost` dashboard URL (local testing only). |

## Run

From `apps/api` (the `--env-file` path loads the repo-root `.env`):

```bash
# default: reads ./rich_menu.png (place it in apps/api/ or pass a path)
npm run setup:rich-menu

# or pass an explicit image path
npx tsx --env-file=../../.env scripts/setup-rich-menu-large.ts /path/to/rich_menu.png
```

The image path is resolved against your current directory and printed at the start, so
you can confirm it looked in the right place.

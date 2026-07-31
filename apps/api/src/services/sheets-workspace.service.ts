import { google, type sheets_v4 } from 'googleapis';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The multi-tab workspace layout the user's spreadsheet gets built into.
 *
 * WHY THIS LIVES SERVER-SIDE. The obvious way to ship a Sheets "app" is bound
 * Apps Script, but installing one into a user's file needs the Apps Script API
 * plus the `script.projects` scope — a second consent screen and a Google
 * verification review. So every view here is a FORMULA over the data the sync
 * already writes, and the few things formulas cannot derive (real timestamps,
 * progress, links) are written as columns by the worker. Result: the workspace
 * is live the moment the user opens the link, with no extra scope, no install
 * step, and nothing for them to keep running.
 *
 * THE SYNC CONTRACT (see google-sheets.service.ts). Columns A–J of the
 * `งานของฉัน` tab belong to the sync: it rewrites their values and repaints
 * their background on every task change, and finds a task's row by the hidden
 * รหัสงาน in column J. Therefore:
 *   - everything this module adds lives in K–R, or on a tab of its own;
 *   - conditional formats over A–J may set FONT colour only, never background,
 *     or the next sync's repaint would fight them;
 *   - column J never moves.
 *
 * UPGRADES. The layout version is stamped as spreadsheet developer metadata.
 * The worker compares it on sync and rebuilds when it differs, so existing
 * users move to a new layout without touching anything. Rebuilding DELETES and
 * recreates the generated tabs — they hold no user data, only formulas — and
 * never touches `งานของฉัน` beyond its K–R extension columns.
 */

/**
 * Same derivation as google-sheets.service.ts: npm resolves two copies of
 * google-auth-library and their OAuth2Client declarations are structurally
 * incompatible, so importing the type directly breaks `google.sheets({ auth })`.
 */
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/**
 * v2 — every _ข้อมูลคำนวณ reference to the master is now INDIRECT (see
 * pinToMaster). v1 sheets have references that drifted one row per task and
 * read from below their own data, so they MUST rebuild to recover.
 * v3 — the ภาพรวม tab gained the "sync ประวัติงาน" block.
 * v4 — สั่งงาน tab removed; สรุปสัปดาห์ became สรุปงาน (date/month picker);
 *      new ✅ งานเสร็จ report; month-anchored analytics ranges; dashboard
 *      polish; same-tab chart sources now shift with the nav.
 */
export const LAYOUT_VERSION = 4;
const METADATA_KEY = 'nookeb_layout_version';

/**
 * Marks that the historical backfill has run for this spreadsheet, and what it
 * imported: `"<ISO instant>|<count>"`.
 *
 * Spreadsheet developer metadata rather than a column in `google_integrations`,
 * for the same reason รหัสงาน lives in the sheet: the fact belongs to the
 * SPREADSHEET. A user who deletes their sheet gets a fresh one that has never
 * been backfilled, and a DB flag would then wrongly claim it had. It also needs
 * no migration, and — unlike a cell — it survives a layout rebuild, since
 * ensureWorkspace only ever deletes its OWN key.
 */
export const HISTORICAL_METADATA_KEY = 'nookeb_historical_sync';

const BANGKOK_TZ = 'Asia/Bangkok';

/** The tab the sync owns. Must match TAB_TITLE in google-sheets.service.ts. */
const MASTER = 'งานของฉัน';

/** Generated tabs, in the order they appear. The dashboard is first so opening
 * the spreadsheet link lands on it rather than on the raw table. */
const TAB = {
  DASH: '📊 ภาพรวม',
  PRIO: '⚡ ความสำคัญ',
  TRACK: '🔄 ติดตามสถานะ',
  TEAM: '👥 รายงานทีม',
  CAL: '🗓️ ปฏิทิน',
  ANA: '📈 วิเคราะห์',
  WEEK: '📅 สรุปงาน',
  DONE: '✅ งานเสร็จ',
  HELP: '➕ วิธีสั่งงาน',
  CALC: '_ข้อมูลคำนวณ',
  CONF: '_ตัวเลือก',
} as const;

/**
 * Tabs earlier layouts generated under names the current layout no longer
 * uses. A rebuild must DELETE these or an upgraded sheet keeps a dead tab
 * around forever — but they are never recreated:
 *   - 📋 สั่งงาน: retired outright (Part E, 2026-08-01). The in-sheet form
 *     could never create a real task (the sync is one-way), and its real
 *     replacement is the urgency-aware create flows in LIFF and the web.
 *   - 📅 สรุปสัปดาห์: renamed to 📅 สรุปงาน with a date/month picker.
 */
const LEGACY_TABS: string[] = ['📋 สั่งงาน', '📅 สรุปสัปดาห์'];

/** Order shown in the tab strip: dashboard, the raw table, then the views. */
const TAB_ORDER = [
  TAB.DASH, MASTER, TAB.PRIO, TAB.TRACK, TAB.TEAM,
  TAB.CAL, TAB.ANA, TAB.WEEK, TAB.DONE, TAB.HELP, TAB.CALC, TAB.CONF,
];

/**
 * Row 1 of every visible tab is an identical nav strip, so the workspace reads
 * as one product rather than eleven loose sheets. Each entry is a HYPERLINK to
 * a tab's gid, which is only known at build time — hence the gid lookup.
 *
 * Eight links, one per column A–H. Every visible tab is therefore at least 8
 * columns wide (see TabPlan.cols); the calendar's 8th column is spare space
 * beside its seven day columns.
 */
const NAV: { tab: string; label: string }[] = [
  { tab: TAB.DASH, label: '📊 ภาพรวม' },
  { tab: TAB.PRIO, label: '⚡ ความสำคัญ' },
  { tab: TAB.TRACK, label: '🔄 ติดตาม' },
  { tab: TAB.TEAM, label: '👥 ทีม' },
  { tab: TAB.CAL, label: '🗓️ ปฏิทิน' },
  { tab: TAB.ANA, label: '📈 วิเคราะห์' },
  { tab: TAB.DONE, label: '✅ งานเสร็จ' },
  { tab: MASTER, label: '📝 งานของฉัน' },
];

/** How many rows the nav occupies at the top of every visible tab. */
const NAV_ROWS = 1;

/** Tabs that get the nav strip — the visible generated views, plus the master. */
const NAV_TABS: string[] = [
  TAB.DASH, TAB.PRIO, TAB.TRACK, TAB.TEAM,
  TAB.CAL, TAB.ANA, TAB.WEEK, TAB.DONE, TAB.HELP,
];

const HIDDEN_TABS: string[] = [TAB.CALC, TAB.CONF];

/** Tabs this module owns outright — deleted and rebuilt on every upgrade. */
const GENERATED_TABS = Object.values(TAB);

// ---- master extension columns (0-based, continuing after รหัสงาน = J = 9) ----

export const MASTER_EXT = {
  URGENCY: 10, // K — user-editable dropdown, the worker only fills it when blank
  PROGRESS: 11, // L — worker
  LINKS: 12, // M — worker
  NOTE: 13, // N — user's own column, never written after the first blank fill
  LOG: 14, // O — worker appends one line per status change
  CREATED: 15, // P — hidden, real date serial
  DONE: 16, // Q — hidden, real date serial
  DEADLINE_DATE: 17, // R — hidden, real date serial (E is the display string)
} as const;

export const MASTER_LAST_COLUMN = MASTER_EXT.DEADLINE_DATE + 1; // exclusive → 18

const EXT_HEADERS = [
  '🚦 ความเร่งด่วน',
  '📊 ความคืบหน้า',
  '🔗 ลิงก์ที่แนบ',
  '📝 หมายเหตุ',
  '🕐 ประวัติสถานะ',
  'สร้างเมื่อ',
  'เสร็จเมื่อ',
  'กำหนดส่ง (วันที่)',
];

// ---- design system ----

/**
 * The palette. The first block is the brand system verbatim; the second block
 * is the semantic names the builders actually call, mapped onto it. Keeping the
 * aliases means a palette change happens in ONE place instead of at ~120 call
 * sites, and no builder can quietly introduce an off-system colour.
 */
const C = {
  NAVY: '#1A237E',
  BLUE: '#1565C0',
  LIGHT_BG: '#F8F9FF',
  WHITE: '#FFFFFF',
  TEAL: '#00695C',
  AMBER: '#E65100',
  ORANGE: '#F57C00',
  GREEN: '#2E7D32',
  RED: '#C62828',
  GRAY: '#546E7A',
  DIVIDER: '#E3E8F0',

  PRIMARY: '#1A237E', // NAVY  — page titles, nav bar, header bands
  ACCENT: '#1565C0', // BLUE  — section headers, กำลังทำ
  SUCCESS: '#2E7D32', // GREEN — เสร็จแล้ว
  WARNING: '#F57C00', // ORANGE — ด่วน
  DANGER: '#C62828', // RED   — เกินกำหนด
  NEUTRAL: '#F8F9FF', // LIGHT_BG — section bands, zebra rows
  BORDER: '#E3E8F0', // DIVIDER
  TEXT: '#263238',
  MUTED: '#546E7A', // GRAY
  SLATE: '#546E7A', // GRAY
  // รอตรวจ. The palette has no purple, so review state takes TEAL — it is the
  // one accent not already spoken for by a status above.
  PURPLE: '#00695C',

  // Row tints. Deliberately pale: conditional formatting over A–J of the master
  // may set FONT colour only, so these are for the generated views.
  URGENT_BG: '#FFEBEE',
  SOON_BG: '#FFF3E0',
  OK_BG: '#FFFDE7',
  RELAX_BG: '#F1F8E9',
};

/** Row heights, in pixels. */
const ROW_H = {
  NAV: 34,
  HEADER: 40,
  DATA: 32,
  SECTION: 36,
  TITLE: 42,
};

/** The Sheets API takes 0–1 floats, not hex. */
function rgb(hex: string): sheets_v4.Schema$Color {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

/**
 * Sarabun — a Google Font with a real Thai face, so Sheets renders it without
 * the user installing anything. `textFormat.fontFamily` takes any family name;
 * an unknown one silently falls back to the default face rather than erroring,
 * so this is safe even where the font is unavailable.
 *
 * Exported so the sync's own row formatting (google-sheets.service.ts) cannot
 * drift to a different family — the master tab and the views must match.
 */
export const FONT = 'Sarabun';

// ---- statuses, urgencies (must match what sheetsWorker writes) ----

const STATUS_OPEN = ['รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'ตีกลับ'];
const STATUS_ALL = ['รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'ตีกลับ', 'ยกเลิก'];
const TYPES = ['งานเดียว', 'หลายรายการ', 'งานประจำ'];

export const URGENCIES = ['🔴 ด่วนมาก', '🟠 ด่วน', '🟡 ปกติ', '🟢 ไม่รีบ'];
export const DEFAULT_URGENCY = '🟡 ปกติ';

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// =====================================================================
// Pure helpers (unit-tested — no network, no env)
// =====================================================================

/**
 * ISO instant → the Sheets serial number for that moment in BANGKOK wall time.
 *
 * Sheets stores a date as "days since 1899-12-30" in the file's own timezone.
 * The spreadsheet is created with timeZone Asia/Bangkok, so the serial has to
 * be built from the Bangkok clock reading, not from UTC — otherwise every
 * deadline lands 7 hours early and "ครบกำหนดวันนี้" fires on the wrong day.
 */
export function toSheetSerial(iso: string | null | undefined): number | '' {
  if (!iso) return '';
  const d = dayjs(iso);
  if (!d.isValid()) return '';
  const local = d.tz(BANGKOK_TZ);
  // Read the wall clock, then treat it as if it were UTC to get a pure offset.
  const asUtc = Date.UTC(
    local.year(), local.month(), local.date(),
    local.hour(), local.minute(), local.second(),
  );
  const EPOCH = Date.UTC(1899, 11, 30);
  return (asUtc - EPOCH) / 86_400_000;
}

/** "▓▓▓░░ 60%" — a progress bar the sheet can render without a chart. */
export function progressBar(done: number, total: number): string {
  if (!total || total < 0) return '';
  const safeDone = Math.max(0, Math.min(done, total));
  const pct = Math.round((safeDone / total) * 100);
  const filled = Math.round((safeDone / total) * 5);
  return `${'▓'.repeat(filled)}${'░'.repeat(5 - filled)} ${pct}%`;
}

/**
 * Prepend one line to the status history, newest first, capped at 12 lines so
 * the cell stays readable (and well under the 50k-character cell limit).
 * Returns the existing value unchanged when the status did not actually move —
 * the sync re-writes a row for edits that have nothing to do with status.
 */
export function appendStatusLog(
  existing: string,
  from: string | null,
  to: string,
  at: Date,
): string {
  if (!to || from === to) return existing;
  const stamp = dayjs(at).tz(BANGKOK_TZ).format('DD/MM HH:mm');
  const line = from ? `${stamp}  ${from} → ${to}` : `${stamp}  เริ่มติดตาม: ${to}`;
  const lines = [line, ...existing.split('\n').filter(Boolean)];
  return lines.slice(0, 12).join('\n');
}

// =====================================================================
// Small request builders
// =====================================================================

function grid(
  sheetId: number,
  startRow: number,
  startCol: number,
  endRow?: number,
  endCol?: number,
): sheets_v4.Schema$GridRange {
  const range: sheets_v4.Schema$GridRange = { sheetId, startRowIndex: startRow, startColumnIndex: startCol };
  if (endRow !== undefined) range.endRowIndex = endRow;
  if (endCol !== undefined) range.endColumnIndex = endCol;
  return range;
}

function fmt(
  range: sheets_v4.Schema$GridRange,
  format: sheets_v4.Schema$CellFormat,
  fields: string,
): sheets_v4.Schema$Request {
  return { repeatCell: { range, cell: { userEnteredFormat: format }, fields: `userEnteredFormat(${fields})` } };
}

/** Header band: navy background, white SemiBold text, centred, 40px tall. */
function headerFormat(range: sheets_v4.Schema$GridRange): sheets_v4.Schema$Request[] {
  return [
    fmt(range, {
      backgroundColor: rgb(C.PRIMARY),
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
      textFormat: { foregroundColor: rgb(C.WHITE), bold: true, fontFamily: FONT, fontSize: 10 },
    }, 'backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat'),
    {
      updateBorders: {
        range,
        bottom: { style: 'SOLID_MEDIUM', color: rgb(C.BLUE) },
        innerVertical: { style: 'SOLID', color: rgb(C.BLUE) },
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: range.sheetId!,
          dimension: 'ROWS',
          startIndex: range.startRowIndex!,
          endIndex: range.startRowIndex! + 1,
        },
        properties: { pixelSize: ROW_H.HEADER },
        fields: 'pixelSize',
      },
    },
  ];
}

/** Page title: large, navy, bold — merged across the width of the view. */
function titleFormat(range: sheets_v4.Schema$GridRange): sheets_v4.Schema$Request[] {
  return [
    { mergeCells: { range, mergeType: 'MERGE_ALL' } },
    fmt(range, {
      verticalAlignment: 'MIDDLE',
      textFormat: { foregroundColor: rgb(C.PRIMARY), bold: true, fontFamily: FONT, fontSize: 14 },
    }, 'verticalAlignment,textFormat'),
  ];
}

function widths(sheetId: number, px: number[], startCol = 0): sheets_v4.Schema$Request[] {
  return px.map((size, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: startCol + i, endIndex: startCol + i + 1 },
      properties: { pixelSize: size },
      fields: 'pixelSize',
    },
  }));
}

function cfFormula(
  sheetId: number,
  ranges: sheets_v4.Schema$GridRange[],
  formula: string,
  format: sheets_v4.Schema$CellFormat,
): sheets_v4.Schema$Request {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges,
        booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format },
      },
      index: 0,
    },
  };
}

function cfText(
  ranges: sheets_v4.Schema$GridRange[],
  type: 'TEXT_EQ' | 'TEXT_CONTAINS',
  value: string,
  format: sheets_v4.Schema$CellFormat,
): sheets_v4.Schema$Request {
  return {
    addConditionalFormatRule: {
      rule: { ranges, booleanRule: { condition: { type, values: [{ userEnteredValue: value }] }, format } },
      index: 0,
    },
  };
}

// =====================================================================
// Formula fragments
// =====================================================================

const M = `'${MASTER}'`;
const CALC = `'${TAB.CALC}'`;
const CONF = `'${TAB.CONF}'`;

/** `{"a";"b"}` — an inline column array, for MATCH/COUNTIF lists. */
function arr(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/"/g, '""')}"`).join(';')}}`;
}

const OPEN_ARR = arr(STATUS_OPEN);

/**
 * Matches a direct master-tab range, e.g. `'งานของฉัน'!$J$2:$J` or `!R2:R`.
 * MASTER is plain Thai text with no regex metacharacters, so it needs no escaping.
 */
const MASTER_REF = new RegExp(`'${MASTER}'!(\\$?[A-Z]{1,2}\\$?\\d+:\\$?[A-Z]{1,2}\\$?\\d*)`, 'g');

/**
 * Rewrite every DIRECT master reference as INDIRECT("…").
 *
 * Sheets auto-adjusts a direct reference whenever a row is inserted at or above
 * it, and the sync appends task rows with values.append. So the correct
 * `'งานของฉัน'!J2:J` written here silently drifted to J3:J, J4:J, … — one row
 * further down per task created — until _ข้อมูลคำนวณ was reading from BELOW its
 * own data and every view legitimately reported zero. INDIRECT takes a STRING,
 * which no row insertion can rewrite, so the window stays pinned to row 2
 * forever. That also makes the workspace safe against the user inserting rows
 * by hand, which they are free to do.
 *
 * Applied inside `pass` rather than at each call site so that no formula added
 * later can forget it.
 */
function pinToMaster(expr: string): string {
  return expr.replace(MASTER_REF, (_full, range: string) => `INDIRECT("${M}!${range}")`);
}

/**
 * Every generated view reads _ข้อมูลคำนวณ, never the master directly, so the
 * derivations (is it overdue? how many days left? which pipeline stage?) exist
 * in exactly one place. The master's own row gate is column J: a row without a
 * รหัสงาน is not a task.
 */
export function calcFormulas(): string[][] {
  const gate = `${M}!$J$2:$J=""`;
  const pass = (expr: string) =>
    `=ARRAYFORMULA(IF(${pinToMaster(gate)},, ${pinToMaster(expr)}))`;
  return [[
    pass(`${M}!J2:J`),              // A  รหัสงาน
    pass(`${M}!B2:B`),              // B  ชื่องาน
    pass(`${M}!D2:D`),              // C  ประเภท
    pass(`${M}!F2:F`),              // D  ผู้สั่ง
    pass(`${M}!G2:G`),              // E  ผู้รับผิดชอบ
    pass(`${M}!H2:H`),              // F  สถานะ
    pass(`${M}!R2:R`),              // G  กำหนดส่ง (วันที่จริง)
    pass(`${M}!P2:P`),              // H  สร้างเมื่อ
    pass(`${M}!Q2:Q`),              // I  เสร็จเมื่อ
    pass(`IF(${M}!K2:K="", "${DEFAULT_URGENCY}", ${M}!K2:K)`), // J  ความเร่งด่วน
    pass(`IFERROR(MATCH(IF(${M}!K2:K="", "${DEFAULT_URGENCY}", ${M}!K2:K), ${arr(URGENCIES)}, 0), 3)`), // K อันดับด่วน
    pass(`IF(${M}!R2:R="",, ${M}!R2:R-NOW())`), // L  วันคงเหลือ
    pass(`(${M}!R2:R<>"")*(${M}!R2:R<NOW())*ISNUMBER(MATCH(${M}!H2:H, ${OPEN_ARR}, 0))=1`), // M เกินกำหนด
    pass(`ISNUMBER(MATCH(${M}!H2:H, ${OPEN_ARR}, 0))`), // N  ยังไม่จบ
    pass(
      `IF(NOT(ISNUMBER(MATCH(${M}!H2:H, ${OPEN_ARR}, 0))), "—", ` +
      `IF(${M}!R2:R="", "ไม่มีกำหนด", ` +
      `IF(${M}!R2:R<NOW(), "⏰ เกิน " & ROUNDUP(NOW()-${M}!R2:R, 0) & " วัน", ` +
      `IF(${M}!R2:R-NOW()<1, "🔥 ครบกำหนดวันนี้", "เหลือ " & ROUNDDOWN(${M}!R2:R-NOW(), 0) & " วัน"))))`,
    ), // O  นับถอยหลัง
    pass(
      `LET(r, IFERROR(MATCH(IF(${M}!K2:K="", "${DEFAULT_URGENCY}", ${M}!K2:K), ${arr(URGENCIES)}, 0), 3), ` +
      `REPT("▓", 5-r) & REPT("░", r-1))`,
    ), // P  มิเตอร์ความด่วน
    pass(
      `IFS(${M}!H2:H="รอดำเนินการ", "●┄○┄○┄○  มอบหมายแล้ว", ` +
      `${M}!H2:H="กำลังทำ", "●━●┄○┄○  กำลังทำ", ` +
      `${M}!H2:H="รอตรวจ", "●━●━◐┄○  ส่งแล้ว รอตรวจ", ` +
      `${M}!H2:H="เสร็จแล้ว", "●━●━●━●  เสร็จสมบูรณ์", ` +
      `${M}!H2:H="ตีกลับ", "●━●━✖┄○  ตีกลับ ต้องแก้", ` +
      `${M}!H2:H="ยกเลิก", "○┄○┄○┄○  ยกเลิก", ` +
      `TRUE, ${M}!H2:H)`,
    ), // Q  สายพานสถานะ
    pass(`${M}!M2:M`),              // R  ลิงก์
    pass(`${M}!N2:N`),              // S  หมายเหตุ
    pass(`${M}!I2:I`),              // T  อัปเดตล่าสุด (ข้อความ)
    pass(`IF(${M}!P2:P="",, IF(${M}!Q2:Q<>"", ${M}!Q2:Q-${M}!P2:P, NOW()-${M}!P2:P))`), // U อายุงาน/ใช้เวลา (วัน)
    pass(
      `IF(NOT(ISNUMBER(MATCH(${M}!H2:H, ${OPEN_ARR}, 0))), "", ` +
      `IF(${M}!P2:P="", "", IF(NOW()-${M}!P2:P>7, "⚠️ ค้างมา " & ROUNDDOWN(NOW()-${M}!P2:P, 0) & " วัน", "")))`,
    ), // V  คอขวด
    pass(`${M}!L2:L`),              // W  ความคืบหน้า
  ]];
}

const CALC_HEADERS = [
  'รหัสงาน', 'ชื่องาน', 'ประเภท', 'ผู้สั่ง', 'ผู้รับผิดชอบ', 'สถานะ', 'กำหนดส่ง', 'สร้างเมื่อ',
  'เสร็จเมื่อ', 'ความเร่งด่วน', 'อันดับด่วน', 'วันคงเหลือ', 'เกินกำหนด', 'ยังไม่จบ', 'นับถอยหลัง',
  'มิเตอร์', 'สายพาน', 'ลิงก์', 'หมายเหตุ', 'อัปเดตล่าสุด', 'อายุงาน', 'คอขวด', 'ความคืบหน้า',
];

/**
 * A view row: SORT(FILTER(...)) over _ข้อมูลคำนวณ with the sort key carried as a
 * trailing column and then trimmed off by ARRAY_CONSTRAIN. Sheets cannot sort
 * by a column it does not select, and a deadline of "" must sort last, hence
 * the 9E+99 substitution.
 */
function viewFormula(opts: {
  columns: string[];
  where: string;
  sortKey: string;
  ascending?: boolean;
  limit: number;
  empty: string;
}): string {
  const { columns, where, sortKey, ascending = true, limit, empty } = opts;
  const body = `{${columns.join(', ')}, ${sortKey}}`;
  return (
    `=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(${body}, ${where}), ` +
    `${columns.length + 1}, ${ascending ? 'TRUE' : 'FALSE'}), ${limit}, ${columns.length}), "${empty}")`
  );
}

const DEADLINE_SORT = `IF(${CALC}!G2:G="", 9E+99, ${CALC}!G2:G)`;

// =====================================================================
// Tab builders — each returns the values to write and the formatting requests
// =====================================================================

export interface TabPlan {
  /** A1 ranges (without the sheet name) → the values to write there. */
  values: { range: string; rows: (string | number)[][] }[];
  requests: sheets_v4.Schema$Request[];
  /** Grid size the tab is created with. */
  rows: number;
  cols: number;
  /** Rows of column headers under the title, frozen with the nav. */
  frozen?: number;
}

/**
 * Every builder below writes in NAV-FREE coordinates — row 1 is its own title,
 * exactly as it would be with no nav strip. `shiftPlan` then moves the whole
 * plan down by NAV_ROWS as the last step before it is materialised.
 *
 * Doing it as a transform rather than by hand keeps each builder readable in
 * one coordinate space and, more importantly, makes the offset impossible to
 * apply inconsistently: there is no literal row number anywhere that could be
 * missed. Formulas that point at a builder's OWN cells go through `self()`,
 * which applies the identical offset.
 */
function shiftPlan(plan: TabPlan, by: number): TabPlan {
  return {
    ...plan,
    rows: plan.rows + by,
    values: plan.values.map((v) => ({ ...v, range: shiftA1(v.range, by) })),
    requests: plan.requests.map((r) => shiftRequest(r, by)),
  };
}

/** "A7" / "H8" / "B2:D9" → the same range moved down `by` rows. */
function shiftA1(a1: string, by: number): string {
  return a1.replace(/([A-Z]+)(\d+)/g, (_m, col: string, row: string) => `${col}${Number(row) + by}`);
}

/**
 * An A1 self-reference inside a builder's own formulas ($B$2 → $B$3).
 * Always use this for a cell on the SAME tab; cross-tab references to _ตัวเลือก
 * and _ข้อมูลคำนวณ must NOT be shifted (those tabs are hidden and get no nav).
 */
function self(a1: string): string {
  return a1.replace(/\$?([A-Z]+)\$?(\d+)/g, (_m, col: string, row: string) => `$${col}$${Number(row) + NAV_ROWS}`);
}

/**
 * Shift the row numbers in a conditional-format CUSTOM_FORMULA.
 *
 * A CF formula is evaluated RELATIVE to the top-left cell of its range, so when
 * the range moves down the formula has to move with it or the rule reads the
 * wrong row — `=$B5="🔴 ด่วนมาก"` on a range starting at row 5 must become
 * `=$B6` once that range starts at row 6.
 *
 * A formula naming another sheet is left alone: the tabs have different offsets
 * (the hidden ones have none), so it cannot be shifted mechanically. Those must
 * be written with self() for the local part instead — asserted in the tests.
 */
function shiftConditionFormula(formula: string, by: number): string {
  if (formula.includes('!')) return formula;
  return formula.replace(
    /(\$?)([A-Z]{1,2})(\$?)(\d+)/g,
    (_m, absCol: string, col: string, absRow: string, row: string) =>
      `${absCol}${col}${absRow}${Number(row) + by}`,
  );
}

/** Deep-shift the row indices of every grid range a request carries. */
function shiftRequest(req: sheets_v4.Schema$Request, by: number): sheets_v4.Schema$Request {
  const rule = req.addConditionalFormatRule?.rule;
  const condition = rule?.booleanRule?.condition;
  if (condition?.type === 'CUSTOM_FORMULA' && condition.values?.length) {
    req = {
      ...req,
      addConditionalFormatRule: {
        ...req.addConditionalFormatRule,
        rule: {
          ...rule,
          booleanRule: {
            ...rule!.booleanRule,
            condition: {
              ...condition,
              values: condition.values.map((v) => (
                typeof v.userEnteredValue === 'string'
                  ? { ...v, userEnteredValue: shiftConditionFormula(v.userEnteredValue, by) }
                  : v
              )),
            },
          },
        },
      },
    };
  }
  const shiftRange = (r: sheets_v4.Schema$GridRange): sheets_v4.Schema$GridRange => ({
    ...r,
    ...(r.startRowIndex != null ? { startRowIndex: r.startRowIndex + by } : {}),
    ...(r.endRowIndex != null ? { endRowIndex: r.endRowIndex + by } : {}),
  });

  const walk = (node: unknown, key?: string): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, key));
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      // A DimensionRange over ROWS uses startIndex/endIndex, not *RowIndex.
      if (obj.dimension === 'ROWS' && typeof obj.startIndex === 'number') {
        return {
          ...obj,
          startIndex: obj.startIndex + by,
          ...(typeof obj.endIndex === 'number' ? { endIndex: obj.endIndex + by } : {}),
        };
      }
      // A DimensionRange over COLUMNS must be left exactly as it is.
      if (obj.dimension === 'COLUMNS') return obj;
      if (typeof obj.sheetId === 'number' && ('startRowIndex' in obj || 'endRowIndex' in obj)) {
        return shiftRange(obj as sheets_v4.Schema$GridRange);
      }
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, walk(v, k)]));
    }
    return node;
  };

  return walk(req) as sheets_v4.Schema$Request;
}

/**
 * Move an addChart down by the nav offset: the anchor cell always (it sits on
 * the chart's own nav-shifted tab), and each SOURCE range only when it reads a
 * tab that was itself shifted. A chart fed from _ตัวเลือก keeps its sources
 * untouched (that tab has no nav strip); a chart fed from its own visible tab
 * must have them moved, or it reads one blank row and silently drops the last
 * data row — the exact off-by-one the analytics charts shipped with before v4.
 */
function shiftChart(
  req: sheets_v4.Schema$Request,
  by: number,
  shiftedGids: Set<number>,
): sheets_v4.Schema$Request {
  const chart = req.addChart?.chart;
  const anchor = chart?.position?.overlayPosition?.anchorCell;
  if (!chart || !anchor || typeof anchor.rowIndex !== 'number') return req;

  const shiftSources = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(shiftSources);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (
        typeof obj.sheetId === 'number' &&
        shiftedGids.has(obj.sheetId) &&
        ('startRowIndex' in obj || 'endRowIndex' in obj)
      ) {
        const r = obj as sheets_v4.Schema$GridRange;
        return {
          ...r,
          ...(r.startRowIndex != null ? { startRowIndex: r.startRowIndex + by } : {}),
          ...(r.endRowIndex != null ? { endRowIndex: r.endRowIndex + by } : {}),
        };
      }
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, shiftSources(v)]));
    }
    return node;
  };

  const spec = shiftSources(chart.spec) as sheets_v4.Schema$ChartSpec;
  return {
    ...req,
    addChart: {
      ...req.addChart,
      chart: {
        ...chart,
        spec,
        position: {
          ...chart.position,
          overlayPosition: {
            ...chart.position!.overlayPosition,
            anchorCell: { ...anchor, rowIndex: anchor.rowIndex + by },
          },
        },
      },
    },
  };
}

/**
 * The nav strip itself, in ABSOLUTE coordinates (row 0) — built after the shift
 * so it is never moved by it.
 */
function navBar(sheetId: number, cols: number, gidOf: (title: string) => number | undefined): TabPlan {
  const links = NAV.map(({ tab, label }) => {
    const gid = gidOf(tab);
    // A tab whose gid we could not resolve degrades to plain text rather than a
    // #REF link — the strip still renders and the other seven still work.
    return gid == null ? label : `=HYPERLINK("#gid=${gid}", "${label}")`;
  });

  return {
    rows: NAV_ROWS,
    cols,
    values: [{ range: `A1:${colLetter(NAV.length - 1)}1`, rows: [links] }],
    requests: [
      // Paint the FULL width, not just the eight link cells, so the strip runs
      // edge to edge on the wider tabs.
      fmt(grid(sheetId, 0, 0, 1, cols), {
        backgroundColor: rgb(C.NAVY),
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
        padding: { top: 2, bottom: 2 },
        // Explicit white + no underline: a HYPERLINK otherwise renders in the
        // default link blue, which is unreadable on navy.
        textFormat: {
          foregroundColor: rgb(C.WHITE), bold: true, underline: false,
          fontFamily: FONT, fontSize: 10,
        },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,padding,textFormat'),
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: ROW_H.NAV },
          fields: 'pixelSize',
        },
      },
      {
        updateBorders: {
          range: grid(sheetId, 0, 0, 1, cols),
          bottom: { style: 'SOLID_THICK', color: rgb(C.BLUE) },
          innerVertical: { style: 'SOLID', color: rgb(C.NAVY) },
        },
      },
    ],
  };
}

/**
 * Nav-free coordinates of the historical-sync block on the dashboard. Exported
 * (shifted by the nav) so the backfill can stamp its result into the cell
 * without re-deriving the layout — if the block moves, it moves in ONE place.
 */
const HISTORICAL_ROW = 18; // 0-based, nav-free — the row the block starts on
export const HISTORICAL_STAMP_A1 = `I${HISTORICAL_ROW + 2 + NAV_ROWS + 1}`;
export const DASH_TAB: string = TAB.DASH;
const HISTORICAL_EMPTY_TEXT = 'ยังไม่เคยดึงประวัติงานเก่า';

function buildDashboard(gid: number, syncUrl?: string): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({
    range: 'A1',
    rows: [[
      '="👋 " & IFS(HOUR(NOW())<12, "สวัสดีตอนเช้า", HOUR(NOW())<17, "สวัสดีตอนบ่าย", TRUE, "สวัสดีตอนเย็น") ' +
      '& "น้า — " & TEXT(NOW(), "d mmmm yyyy") & "  ⏰ " & TEXT(NOW(), "HH:mm") & " น."',
    ]],
  });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 12)));
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 42 },
      fields: 'pixelSize',
    },
  });

  // ---- KPI cards: label row 3, number row 4, unit row 5; two columns each ----
  const kpis: { label: string; formula: string; color: string; bg: string }[] = [
    // SUMPRODUCT, not COUNTA: _ข้อมูลคำนวณ spills an ARRAYFORMULA down the whole
    // column, and COUNTA counts a formula's empty-string result as a value.
    { label: '📦 งานทั้งหมด', formula: `=SUMPRODUCT((${CALC}!$A$2:$A$2000<>"")*1)`, color: C.PRIMARY, bg: '#E8EEF6' },
    { label: '⏸️ รอดำเนินการ', formula: `=COUNTIF(${CALC}!F2:F, "รอดำเนินการ")`, color: C.SLATE, bg: '#ECEFF1' },
    { label: '🔵 กำลังทำ', formula: `=COUNTIF(${CALC}!F2:F, "กำลังทำ")`, color: C.ACCENT, bg: '#E3F2FD' },
    { label: '🟣 รอตรวจ', formula: `=COUNTIF(${CALC}!F2:F, "รอตรวจ")`, color: C.PURPLE, bg: '#EDE7F6' },
    { label: '✅ เสร็จแล้ว', formula: `=COUNTIF(${CALC}!F2:F, "เสร็จแล้ว")`, color: C.SUCCESS, bg: '#E8F5E9' },
    { label: '⏰ เกินกำหนด', formula: `=COUNTIF(${CALC}!M2:M, TRUE)`, color: C.DANGER, bg: C.URGENT_BG },
  ];
  // Card anatomy (v4 polish): white card, one THICK accent rule on top carrying
  // the card's semantic colour, hairline DIVIDER around the rest. The pastel
  // fill lives only behind the number now — six fully-tinted boxes in a row
  // read as six competing highlights; one accent line each reads as a system.
  kpis.forEach((k, i) => {
    const col = i * 2;
    values.push({ range: `${colLetter(col)}3`, rows: [[k.label]] });
    values.push({ range: `${colLetter(col)}4`, rows: [[k.formula]] });
    values.push({ range: `${colLetter(col)}5`, rows: [['รายการ']] });
    requests.push(
      { mergeCells: { range: grid(gid, 2, col, 3, col + 2), mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: grid(gid, 3, col, 4, col + 2), mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: grid(gid, 4, col, 5, col + 2), mergeType: 'MERGE_ALL' } },
      fmt(grid(gid, 2, col, 3, col + 2), {
        backgroundColor: rgb(C.WHITE), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 9, bold: true, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
      fmt(grid(gid, 3, col, 4, col + 2), {
        backgroundColor: rgb(k.bg), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 26, bold: true, foregroundColor: rgb(k.color) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
      fmt(grid(gid, 4, col, 5, col + 2), {
        backgroundColor: rgb(C.WHITE), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 8, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      {
        updateBorders: {
          range: grid(gid, 2, col, 5, col + 2),
          top: { style: 'SOLID_THICK', color: rgb(k.color) },
          bottom: { style: 'SOLID', color: rgb(C.BORDER) },
          left: { style: 'SOLID', color: rgb(C.BORDER) },
          right: { style: 'SOLID', color: rgb(C.BORDER) },
        },
      },
    );
  });
  requests.push(
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 26 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 3, endIndex: 4 },
        properties: { pixelSize: 52 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 4, endIndex: 5 },
        properties: { pixelSize: 18 },
        fields: 'pixelSize',
      },
    },
  );

  // ---- urgent / overdue ----
  values.push({ range: 'A7', rows: [['🚨 ด่วนมาก & เกินกำหนด']] });
  values.push({ range: 'A8', rows: [['ระดับ', 'ชื่องาน', 'ผู้รับผิดชอบ', 'นับถอยหลัง', 'สถานะ', 'คอขวด']] });
  values.push({
    range: 'A9',
    rows: [[viewFormula({
      columns: [`${CALC}!J2:J`, `${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!O2:O`, `${CALC}!F2:F`, `${CALC}!V2:V`],
      where: `(${CALC}!N2:N=TRUE) * ((${CALC}!K2:K=1) + (${CALC}!M2:M=TRUE))`,
      sortKey: DEADLINE_SORT,
      limit: 8,
      empty: '🎉 ไม่มีงานด่วนหรือเกินกำหนดตอนนี้',
    })]],
  });
  requests.push(...sectionHeader(gid, 6, 0, 6, '🚨 ด่วนมาก & เกินกำหนด'));
  requests.push(...headerFormat(grid(gid, 7, 0, 8, 6)));

  // ---- next deadlines ----
  values.push({ range: 'H7', rows: [['⏳ ใกล้ถึงกำหนดส่ง']] });
  values.push({ range: 'H8', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'นับถอยหลัง', 'ระดับ']] });
  values.push({
    range: 'H9',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!G2:G`, `${CALC}!O2:O`, `${CALC}!J2:J`],
      where: `(${CALC}!N2:N=TRUE) * (${CALC}!G2:G<>"")`,
      sortKey: `${CALC}!G2:G`,
      limit: 8,
      empty: 'ยังไม่มีงานที่ตั้งกำหนดส่ง',
    })]],
  });
  requests.push(...sectionHeader(gid, 6, 7, 5, '⏳ ใกล้ถึงกำหนดส่ง'));
  requests.push(...headerFormat(grid(gid, 7, 7, 8, 12)));
  requests.push(fmt(grid(gid, 8, 9, 17, 10), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));

  // ---- activity feed ----
  values.push({ range: 'A19', rows: [['🕐 ความเคลื่อนไหวล่าสุด']] });
  values.push({ range: 'A20', rows: [['งาน', 'สถานะ', 'ความคืบหน้า', 'อัปเดตล่าสุด']] });
  values.push({
    range: 'A21',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!F2:F`, `${CALC}!W2:W`, `${CALC}!T2:T`],
      where: `(${CALC}!A2:A<>"")`,
      sortKey: `IF(${CALC}!I2:I="", ${CALC}!H2:H, ${CALC}!I2:I)`,
      ascending: false,
      limit: 10,
      empty: 'ยังไม่มีความเคลื่อนไหว',
    })]],
  });
  requests.push(...sectionHeader(gid, 18, 0, 6, '🕐 ความเคลื่อนไหวล่าสุด'));
  requests.push(...headerFormat(grid(gid, 19, 0, 20, 4)));

  // ---- historical backfill: button + last-run stamp ----
  //
  // A Sheets cell cannot call an HTTP endpoint on its own — only Apps Script
  // can, and the whole workspace is built on "nothing to install". So the
  // button is a HYPERLINK into the dashboard, which already holds the user's
  // session and fires the request for them (?sync=historical). One click from
  // the sheet either way, and it keeps working for users who never install the
  // optional add-on.
  const hRow = HISTORICAL_ROW;
  values.push({ range: `I${hRow + 1}`, rows: [['🗂️ ประวัติงานเก่า']] });
  values.push({
    range: `I${hRow + 2}`,
    rows: [[
      syncUrl
        ? `=HYPERLINK("${syncUrl}", "🔄 sync ประวัติงาน")`
        : '🔄 sync ประวัติงาน',
    ]],
  });
  values.push({ range: `I${hRow + 3}`, rows: [[HISTORICAL_EMPTY_TEXT]] });
  values.push({
    range: `I${hRow + 4}`,
    rows: [['ดึงงานที่สร้างไว้ก่อนต่อ Sheet เข้ามาทีเดียว — งานที่มีอยู่แล้วหนูจะไม่เพิ่มซ้ำน้า']],
  });
  // Pushed AFTER baseFormat below, not here: baseFormat repaints the whole grid
  // white, and a request later in the same batchUpdate wins. The button has to
  // outlive that repaint or it renders as plain text on white.
  const historicalRequests: sheets_v4.Schema$Request[] = [
    ...sectionHeader(gid, hRow, 8, 4, '🗂️ ประวัติงานเก่า'),
    { mergeCells: { range: grid(gid, hRow + 1, 8, hRow + 2, 12), mergeType: 'MERGE_ALL' } },
    fmt(grid(gid, hRow + 1, 8, hRow + 2, 12), {
      backgroundColor: rgb(C.NAVY), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      textFormat: { bold: true, fontFamily: FONT, fontSize: 12, foregroundColor: rgb(C.WHITE) },
    }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: hRow + 1, endIndex: hRow + 2 },
        properties: { pixelSize: 38 },
        fields: 'pixelSize',
      },
    },
    { mergeCells: { range: grid(gid, hRow + 2, 8, hRow + 3, 12), mergeType: 'MERGE_ALL' } },
    fmt(grid(gid, hRow + 2, 8, hRow + 3, 12), {
      backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.MUTED) },
    }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
    { mergeCells: { range: grid(gid, hRow + 3, 8, hRow + 4, 12), mergeType: 'MERGE_ALL' } },
    fmt(grid(gid, hRow + 3, 8, hRow + 4, 12), {
      wrapStrategy: 'WRAP', verticalAlignment: 'TOP',
      textFormat: { fontFamily: FONT, fontSize: 9, foregroundColor: rgb(C.MUTED) },
    }, 'wrapStrategy,verticalAlignment,textFormat'),
  ];

  // ---- charts section ----
  values.push({ range: 'A30', rows: [['📊 กราฟสรุป']] });

  requests.push(...widths(gid, [95, 150, 130, 120, 110, 120, 20, 190, 130, 130, 120, 100]));
  requests.push(...baseFormat(gid, 40, 14));
  requests.push(...historicalRequests);
  // sectionHeader AFTER baseFormat for the same last-write-wins reason as the
  // historical block above.
  requests.push(...sectionHeader(gid, 29, 0, 12, '📊 กราฟสรุป'));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });
  requests.push(cfText([grid(gid, 8, 3, 17, 4)], 'TEXT_CONTAINS', 'เกิน',
    { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }));

  return { values, requests, rows: 40, cols: 14 };
}

/** Charts live in their own pass because they need the CONF tab's gid too. */
function dashboardCharts(dashGid: number, confGid: number): sheets_v4.Schema$Request[] {
  const anchor = (row: number, col: number, w: number, h: number): sheets_v4.Schema$EmbeddedObjectPosition => ({
    overlayPosition: {
      anchorCell: { sheetId: dashGid, rowIndex: row, columnIndex: col },
      offsetXPixels: 0, offsetYPixels: 0, widthPixels: w, heightPixels: h,
    },
  });
  const src = (startRow: number, endRow: number, col: number): sheets_v4.Schema$ChartData => ({
    sourceRange: { sources: [grid(confGid, startRow, col, endRow, col + 1)] },
  });

  return [
    {
      addChart: {
        chart: {
          spec: {
            title: 'สัดส่วนสถานะงาน',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            pieChart: {
              legendPosition: 'RIGHT_LEGEND',
              pieHole: 0.55,
              domain: src(0, 1 + STATUS_ALL.length, 2),
              series: src(0, 1 + STATUS_ALL.length, 3),
            },
          },
          position: anchor(31, 0, 430, 260),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'งานแยกตามประเภท',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(0, 1 + TYPES.length, 5) }],
              series: [{ series: src(0, 1 + TYPES.length, 6), targetAxis: 'LEFT_AXIS', color: rgb(C.BLUE) }],
            },
          },
          position: anchor(31, 4, 430, 260),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'งานค้างต่อคน',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(0, 31, 8) }],
              series: [{ series: src(0, 31, 9), targetAxis: 'BOTTOM_AXIS', color: rgb(C.BLUE) }],
            },
          },
          position: anchor(31, 8, 430, 300),
        },
      },
    },
  ];
}

function buildPriority(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['⚡ ความสำคัญ — ด่วนมาก + ใกล้กำหนด ขึ้นก่อนเสมอ (เรียงให้อัตโนมัติ)']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 9)));

  values.push({ range: 'A2', rows: [['แสดง:', 'ทั้งหมด', 'เลือกได้: ทั้งหมด / เร่งด่วน / เกินกำหนด / รอรับงาน']] });
  requests.push(
    fmt(grid(gid, 1, 0, 2, 1), {
      horizontalAlignment: 'RIGHT', textFormat: { bold: true, fontFamily: FONT },
    }, 'horizontalAlignment,textFormat'),
    fmt(grid(gid, 1, 1, 2, 2), {
      backgroundColor: rgb('#E3F2FD'), horizontalAlignment: 'CENTER',
      textFormat: { bold: true, fontFamily: FONT, foregroundColor: rgb(C.PRIMARY) },
    }, 'backgroundColor,horizontalAlignment,textFormat'),
    fmt(grid(gid, 1, 2, 2, 6), {
      textFormat: { fontFamily: FONT, fontSize: 9, foregroundColor: rgb(C.MUTED) },
    }, 'textFormat'),
    {
      setDataValidation: {
        range: grid(gid, 1, 1, 2, 2),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: ['ทั้งหมด', 'เร่งด่วน', 'เกินกำหนด', 'รอรับงาน'].map((v) => ({ userEnteredValue: v })),
          },
          showCustomUi: true,
          strict: true,
        },
      },
    },
  );

  values.push({ range: 'A4', rows: [['มิเตอร์', 'ระดับ', 'ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'นับถอยหลัง', 'ความคืบหน้า', 'สถานะ', 'คอขวด']] });
  requests.push(...headerFormat(grid(gid, 3, 0, 4, 9)));

  // B2 is this tab's own dropdown, so it moves with the nav strip — self().
  const pick = self('B2');
  const filter =
    `IF(${pick}="ทั้งหมด", 1, IF(${pick}="เร่งด่วน", (${CALC}!K2:K<=2), ` +
    `IF(${pick}="เกินกำหนด", (${CALC}!M2:M=TRUE), (${CALC}!F2:F="รอดำเนินการ"))))`;
  values.push({
    range: 'A5',
    rows: [[viewFormula({
      columns: [
        `${CALC}!P2:P`, `${CALC}!J2:J`, `${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!G2:G`,
        `${CALC}!O2:O`, `${CALC}!W2:W`, `${CALC}!F2:F`, `${CALC}!V2:V`,
      ],
      // Urgency rank first, deadline second — the ×1e6 keeps the two keys from
      // interleaving without needing a second SORT column.
      where: `(${CALC}!N2:N=TRUE) * ${filter}`,
      sortKey: `${CALC}!K2:K*1000000 + IF(${CALC}!G2:G="", 999999, ${CALC}!G2:G)`,
      limit: 300,
      empty: '🎉 ไม่มีงานในหมวดนี้',
    })]],
  });

  requests.push(...widths(gid, [80, 100, 230, 140, 130, 130, 110, 100, 120]));
  requests.push(...baseFormat(gid, 320, 9));
  requests.push(
    fmt(grid(gid, 4, 4, 320, 5), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'),
    fmt(grid(gid, 4, 0, 320, 1), { textFormat: { fontFamily: 'Roboto Mono', foregroundColor: rgb(C.ACCENT) } }, 'textFormat'),
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: 4 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Banding first, urgency stripes on top — a conditional format always wins
    // over a banded range, so the zebra only shows on rows with no stripe.
    banding(gid, 4, 0, 320, 9),
    cfFormula(gid, [grid(gid, 4, 0, 320, 9)], `=$B5="${URGENCIES[0]}"`, { backgroundColor: rgb(C.URGENT_BG) }),
    cfFormula(gid, [grid(gid, 4, 0, 320, 9)], `=$B5="${URGENCIES[1]}"`, { backgroundColor: rgb(C.SOON_BG) }),
    cfText([grid(gid, 4, 5, 320, 6)], 'TEXT_CONTAINS', 'เกิน', { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }),
    cfText([grid(gid, 4, 8, 320, 9)], 'TEXT_CONTAINS', '⚠️', { textFormat: { foregroundColor: rgb(C.WARNING), bold: true } }),
  );

  // Freeze title + filter + column headers (rows 1-4) along with the nav.
  return { values, requests, rows: 320, cols: 9, frozen: 4 };
}

function buildTracker(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['🔄 ติดตามสถานะ — มอบหมาย → กำลังทำ → ส่งงาน → ตรวจ → เสร็จ / ตีกลับ']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 9)));

  values.push({ range: 'A2', rows: [['ผู้สั่ง:', '', 'ผู้รับ:', '', 'ประเภท:', '', 'ระดับด่วน:', '', 'เว้นว่าง = ทั้งหมด']] });
  [1, 3, 5, 7].forEach((col) => {
    requests.push(
      fmt(grid(gid, 1, col - 1, 2, col), {
        horizontalAlignment: 'RIGHT', textFormat: { bold: true, fontSize: 9, fontFamily: FONT },
      }, 'horizontalAlignment,textFormat'),
      fmt(grid(gid, 1, col, 2, col + 1), {
        backgroundColor: rgb('#E3F2FD'), textFormat: { fontFamily: FONT, bold: true },
      }, 'backgroundColor,textFormat'),
    );
  });
  requests.push(
    validationFromRange(grid(gid, 1, 3, 2, 4), `=${CONF}!$A$2:$A$40`),
    validationFromList(grid(gid, 1, 5, 2, 6), TYPES),
    validationFromList(grid(gid, 1, 7, 2, 8), URGENCIES),
    fmt(grid(gid, 1, 8, 2, 9), { textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) } }, 'textFormat'),
  );

  values.push({ range: 'A4', rows: [['ชื่องาน', 'ประเภท', 'สายพานสถานะ', 'ความคืบหน้า', 'ผู้สั่ง', 'ผู้รับผิดชอบ', 'กำหนดส่ง', '🔗 ลิงก์ที่แนบ', '📝 หมายเหตุ']] });
  requests.push(...headerFormat(grid(gid, 3, 0, 4, 9)));

  // The four filter cells live on this tab, so they move with the nav strip.
  const [byFrom, byTo, byType, byUrg] = [self('B2'), self('D2'), self('F2'), self('H2')];
  const where =
    `IF(${byFrom}="", 1, ISNUMBER(SEARCH(${byFrom}, ${CALC}!D2:D))) * ` +
    `IF(${byTo}="", 1, ISNUMBER(SEARCH(${byTo}, ${CALC}!E2:E))) * ` +
    `IF(${byType}="", 1, (${CALC}!C2:C=${byType})) * ` +
    `IF(${byUrg}="", 1, (${CALC}!J2:J=${byUrg})) * (${CALC}!A2:A<>"")`;
  values.push({
    range: 'A5',
    rows: [[viewFormula({
      columns: [
        `${CALC}!B2:B`, `${CALC}!C2:C`, `${CALC}!Q2:Q`, `${CALC}!W2:W`, `${CALC}!D2:D`,
        `${CALC}!E2:E`, `${CALC}!G2:G`, `${CALC}!R2:R`, `${CALC}!S2:S`,
      ],
      where,
      sortKey: DEADLINE_SORT,
      limit: 300,
      empty: 'ไม่พบงานตามตัวกรองนี้',
    })]],
  });

  requests.push(...widths(gid, [210, 90, 190, 110, 110, 140, 130, 160, 190]));
  requests.push(...baseFormat(gid, 320, 9));
  requests.push(
    fmt(grid(gid, 4, 6, 320, 7), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'),
    fmt(grid(gid, 4, 2, 320, 3), { textFormat: { fontFamily: 'Roboto Mono', fontSize: 9 } }, 'textFormat'),
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: 4 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    banding(gid, 4, 0, 320, 9),
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'ตีกลับ', { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }),
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'เสร็จสมบูรณ์', { textFormat: { foregroundColor: rgb(C.SUCCESS) } }),
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'รอตรวจ', { textFormat: { foregroundColor: rgb(C.PURPLE), bold: true } }),
  );

  // Freeze title + filter + column headers (rows 1-4) along with the nav.
  return { values, requests, rows: 320, cols: 9, frozen: 4 };
}

function buildTeam(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['👥 รายงานทีม — ใครถืองานเท่าไหร่ ใครล้นมือ ใครว่าง']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 10)));
  values.push({
    range: 'A2',
    rows: [['รอตรวจ = ส่งงานกลับมาแล้วรอเจ้าของงานตรวจ · ตีกลับ = ถูกส่งกลับไปแก้ · ภาระงานค้าง = งานที่ยังไม่จบทั้งหมด']],
  });
  requests.push(fmt(grid(gid, 1, 0, 2, 10), {
    textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
  }, 'textFormat'));

  values.push({
    range: 'A4',
    rows: [['สมาชิก', 'ได้รับทั้งหมด', 'รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'ตีกลับ', 'เสร็จแล้ว', 'เกินกำหนด', '% สำเร็จ', 'ภาระงานค้าง']],
  });
  requests.push(...headerFormat(grid(gid, 3, 0, 4, 10)));

  // One MAP per column keeps every cell a single spilled array — no per-row fill.
  const person = `${CONF}!$A$2:$A$40`;
  const countWhere = (extra: string) =>
    `=MAP(${person}, LAMBDA(p, IF(p="",, SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$A$2:$A$2000<>"")${extra}))))`;
  values.push({ range: 'A5', rows: [[`=IFERROR(FILTER(${person}, ${person}<>""), "")`]] });
  values.push({ range: 'B5', rows: [[countWhere('')]] });
  values.push({ range: 'C5', rows: [[countWhere(` * (${CALC}!$F$2:$F$2000="รอดำเนินการ")`)]] });
  values.push({ range: 'D5', rows: [[countWhere(` * (${CALC}!$F$2:$F$2000="กำลังทำ")`)]] });
  values.push({ range: 'E5', rows: [[countWhere(` * (${CALC}!$F$2:$F$2000="รอตรวจ")`)]] });
  values.push({ range: 'F5', rows: [[countWhere(` * (${CALC}!$F$2:$F$2000="ตีกลับ")`)]] });
  values.push({ range: 'G5', rows: [[countWhere(` * (${CALC}!$F$2:$F$2000="เสร็จแล้ว")`)]] });
  values.push({ range: 'H5', rows: [[countWhere(` * (${CALC}!$M$2:$M$2000=TRUE)`)]] });
  values.push({ range: 'I5', rows: [[`=ARRAYFORMULA(IF($A5:$A="",, IF($B5:$B=0, 0, $G5:$G/$B5:$B)))`]] });
  values.push({ range: 'J5', rows: [[`=ARRAYFORMULA(IF($A5:$A="",, $C5:$C+$D5:$D+$E5:$E+$F5:$F))`]] });

  requests.push(...widths(gid, [150, 105, 105, 90, 85, 85, 95, 100, 90, 110]));
  requests.push(...baseFormat(gid, 45, 10));
  requests.push(
    fmt(grid(gid, 4, 1, 45, 10), { horizontalAlignment: 'CENTER' }, 'horizontalAlignment'),
    fmt(grid(gid, 4, 0, 45, 1), { textFormat: { bold: true, fontFamily: FONT } }, 'textFormat'),
    fmt(grid(gid, 4, 8, 45, 9), { numberFormat: { type: 'PERCENT', pattern: '0%' } }, 'numberFormat'),
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: 4 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Workload heatmap: white → amber → red as the open-task pile grows.
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [grid(gid, 4, 9, 45, 10)],
          gradientRule: {
            minpoint: { color: rgb(C.WHITE), type: 'NUMBER', value: '0' },
            midpoint: { color: rgb('#FFE0B2'), type: 'NUMBER', value: '3' },
            maxpoint: { color: rgb('#EF9A9A'), type: 'NUMBER', value: '8' },
          },
        },
        index: 0,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [grid(gid, 4, 8, 45, 9)],
          gradientRule: {
            minpoint: { color: rgb('#FFCDD2'), type: 'NUMBER', value: '0' },
            midpoint: { color: rgb('#FFF9C4'), type: 'NUMBER', value: '0.5' },
            maxpoint: { color: rgb('#C8E6C9'), type: 'NUMBER', value: '1' },
          },
        },
        index: 0,
      },
    },
    cfFormula(gid, [grid(gid, 4, 7, 45, 8)], '=$H5>0', { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }),
  );

  return { values, requests, rows: 45, cols: 10 };
}

function buildCalendar(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];
  const nowBkk = dayjs().tz(BANGKOK_TZ);

  values.push({ range: 'A1', rows: [['🗓️ ปฏิทินกำหนดส่ง']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 3)));
  values.push({
    range: 'D1',
    rows: [[
      THAI_MONTHS[nowBkk.month()] ?? THAI_MONTHS[0]!,
      nowBkk.year(),
      '← เลือกเดือน/ปี แล้วปฏิทินอัปเดตเอง',
    ]],
  });
  requests.push(
    fmt(grid(gid, 0, 3, 1, 5), {
      backgroundColor: rgb('#E3F2FD'), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      textFormat: { bold: true, fontSize: 12, fontFamily: FONT, foregroundColor: rgb(C.PRIMARY) },
    }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
    fmt(grid(gid, 0, 5, 1, 7), {
      textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
    }, 'textFormat'),
    validationFromList(grid(gid, 0, 3, 1, 4), THAI_MONTHS),
    validationFromList(
      grid(gid, 0, 4, 1, 5),
      [nowBkk.year() - 1, nowBkk.year(), nowBkk.year() + 1, nowBkk.year() + 2].map(String),
    ),
  );

  values.push({
    range: 'A2',
    rows: [['🔴 ด่วนมาก · 🟠 ด่วน · 🟡 ปกติ · 🟢 ไม่รีบ · ✓ = เสร็จแล้ว · แต่ละช่องแสดงงานที่ครบกำหนดวันนั้น (สูงสุด 3 งาน)']],
  });
  requests.push(fmt(grid(gid, 1, 0, 2, 7), {
    textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
  }, 'textFormat'));

  const dows = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  values.push({ range: 'A3', rows: [dows] });
  requests.push(...headerFormat(grid(gid, 2, 0, 3, 7)));

  // The month's first cell is the Sunday on or before the 1st; cell i is that
  // date + i. Everything else is derived, so changing D1/E1 redraws the grid.
  // D1/E1 are this tab's own month + year pickers — they move with the nav.
  const monthNum = `MATCH(${self('D1')}, ${arr(THAI_MONTHS)}, 0)`;
  const firstOfMonth = `DATE(${self('E1')}, ${monthNum}, 1)`;
  const gridRows: string[][] = [];
  for (let week = 0; week < 6; week++) {
    const row: string[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const offset = week * 7 + dow;
      row.push(
        `=LET(d, ${firstOfMonth} - WEEKDAY(${firstOfMonth}) + 1 + ${offset}, ` +
        `IF(MONTH(d)<>${monthNum}, "", ` +
        // A half-open day window rather than INT(deadline)=d: INT("") is an
        // error, and one error anywhere in the array would blank the calendar.
        `DAY(d) & IFERROR(CHAR(10) & TEXTJOIN(CHAR(10), TRUE, ARRAY_CONSTRAIN(SORT(FILTER(` +
        `IF(${CALC}!$F$2:$F="เสร็จแล้ว", "✓ ", LEFT(${CALC}!$J$2:$J, 2) & " ") & ${CALC}!$B$2:$B, ` +
        `${CALC}!$G$2:$G>=d, ${CALC}!$G$2:$G<d+1), 1, TRUE), 3, 1)), "")))`,
      );
    }
    gridRows.push(row);
  }
  values.push({ range: 'A4', rows: gridRows });

  requests.push(...widths(gid, [150, 150, 150, 150, 150, 150, 150]));
  requests.push(...baseFormat(gid, 10, 7));
  requests.push(
    fmt(grid(gid, 3, 0, 9, 7), {
      verticalAlignment: 'TOP', wrapStrategy: 'WRAP',
      textFormat: { fontFamily: FONT, fontSize: 9 },
    }, 'verticalAlignment,wrapStrategy,textFormat'),
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 3, endIndex: 9 },
        properties: { pixelSize: 92 },
        fields: 'pixelSize',
      },
    },
    {
      updateBorders: {
        range: grid(gid, 3, 0, 9, 7),
        innerHorizontal: { style: 'SOLID', color: rgb(C.BORDER) },
        innerVertical: { style: 'SOLID', color: rgb(C.BORDER) },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: 3 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Tint a day cell by the most urgent unfinished task shown in it.
    cfFormula(gid, [grid(gid, 3, 0, 9, 7)], '=REGEXMATCH(A4&"", "🔴")', { backgroundColor: rgb(C.URGENT_BG) }),
    cfFormula(gid, [grid(gid, 3, 0, 9, 7)], '=REGEXMATCH(A4&"", "🟠")', { backgroundColor: rgb(C.SOON_BG) }),
    cfFormula(gid, [grid(gid, 3, 0, 9, 7)], '=REGEXMATCH(A4&"", "🟡")', { backgroundColor: rgb(C.OK_BG) }),
    cfFormula(gid, [grid(gid, 3, 0, 9, 7)], '=A4=""', { backgroundColor: rgb(C.NEUTRAL) }),
  );

  // Freeze the title, the legend and the day-name header (rows 1-3).
  return { values, requests, rows: 10, cols: 7, frozen: 3 };
}

function buildAnalytics(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['📈 วิเคราะห์ — งานเข้า/งานเสร็จ ความเร็วของทีม และงานที่เกินกำหนด']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 12)));
  values.push({
    range: 'A2',
    rows: [['นับจากวันที่งานถูกสร้างจริงในระบบหนูเก็บ — ทุกตัวเลขคำนวณสดจากตารางงาน ไม่ต้องกดรีเฟรช']],
  });
  requests.push(fmt(grid(gid, 1, 0, 2, 12), {
    textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
  }, 'textFormat'));

  // ---- month-anchored ranges: previous month + this month ----
  //
  // Each month splits into the CALENDAR chunks 1-7, 8-14, 15-21, 22-28 and
  // 29-end — not rolling 7-day blocks, so a label always names real dates of
  // one month. The 29-end chunk clamps to the month's true last day (29-31,
  // 29-30, or 29-28 never exists: in a non-leap February day 29 is already the
  // next month, and the row blanks itself via the label gate). All of it is
  // TODAY()-derived formulas, so the table stays current without a rebuild.
  values.push({ range: 'A4', rows: [['ช่วงวันที่', 'งานเข้า', 'งานเสร็จ', 'อัตราเสร็จ']] });
  requests.push(...headerFormat(grid(gid, 3, 0, 4, 4)));
  const rangeRows: string[][] = [];
  const CHUNKS_PER_MONTH = 5;
  [-1, 0].forEach((off, block) => {
    const mStart = `DATE(YEAR(TODAY()), MONTH(TODAY())+${off}, 1)`;
    const mNext = `DATE(YEAR(TODAY()), MONTH(TODAY())+${off + 1}, 1)`;
    for (let k = 0; k < CHUNKS_PER_MONTH; k++) {
      const rowNo = 5 + block * CHUNKS_PER_MONTH + k; // nav-free sheet row of this entry
      const start = `${mStart}+${k * 7}`;
      const end = `MIN(${start}+7, ${mNext})`;
      const label = self(`$A$${rowNo}`);
      rangeRows.push([
        `=IF(${start}>=${mNext}, "", TEXT(${start}, "d") & "-" & TEXT(${end}-1, "d") & " " & TEXT(${start}, "mmm"))`,
        `=IF(${label}="", "", COUNTIFS(${CALC}!$H$2:$H, ">="&${start}, ${CALC}!$H$2:$H, "<"&${end}))`,
        `=IF(${label}="", "", COUNTIFS(${CALC}!$I$2:$I, ">="&${start}, ${CALC}!$I$2:$I, "<"&${end}))`,
        `=IF(${label}="", "", IF(${self(`$B$${rowNo}`)}=0, 0, ${self(`$C$${rowNo}`)}/${self(`$B$${rowNo}`)}))`,
      ]);
    }
  });
  values.push({ range: 'A5', rows: rangeRows });
  requests.push(fmt(grid(gid, 4, 3, 14, 4), { numberFormat: { type: 'PERCENT', pattern: '0%' } }, 'numberFormat'));

  // ---- per type ----
  values.push({ range: 'F4', rows: [['ประเภท', 'เฉลี่ย (วัน)', 'เสร็จแล้ว', 'ทั้งหมด']] });
  requests.push(...headerFormat(grid(gid, 3, 5, 4, 9)));
  values.push({
    range: 'F5',
    // ">0" rather than "<>" for "has a completion date": the column holds date
    // serials, and a "<>" criterion also matches the empty strings the spilled
    // ARRAYFORMULA leaves behind, which would drag every average toward zero.
    rows: TYPES.map((t) => [
      t,
      `=IFERROR(ROUND(AVERAGEIFS(${CALC}!$U$2:$U, ${CALC}!$C$2:$C, "${t}", ${CALC}!$I$2:$I, ">0"), 1), 0)`,
      `=COUNTIFS(${CALC}!$C$2:$C, "${t}", ${CALC}!$I$2:$I, ">0")`,
      `=COUNTIF(${CALC}!$C$2:$C, "${t}")`,
    ]),
  });

  // ---- per person speed ----
  values.push({ range: 'K4', rows: [['สมาชิก', 'เสร็จแล้ว', 'เฉลี่ย (วัน)']] });
  requests.push(...headerFormat(grid(gid, 3, 10, 4, 13)));
  const person = `${CONF}!$A$2:$A$40`;
  values.push({ range: 'K5', rows: [[`=IFERROR(FILTER(${person}, ${person}<>""), "")`]] });
  values.push({
    range: 'L5',
    rows: [[
      `=MAP(${person}, LAMBDA(p, IF(p="",, SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"")))))`,
    ]],
  });
  values.push({
    range: 'M5',
    rows: [[
      `=MAP(${person}, LAMBDA(p, IF(p="",, IFERROR(ROUND(` +
      `SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"") * ${CALC}!$U$2:$U$2000) / ` +
      `SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"")), 1), 0))))`,
    ]],
  });

  // ---- summary strip ----
  values.push({
    range: 'A19',
    rows: [[
      // K5/L5 are this tab's own per-person table — self() moves them with the nav.
      `="🏆 ทำงานเสร็จมากที่สุด: " & IFERROR(INDEX(${self('K5')}:$K, MATCH(MAX(${self('L5')}:$L), ${self('L5')}:$L, 0)) & " (" & MAX(${self('L5')}:$L) & " งาน)", "—") & ` +
      `"     ⏱️ เวลาเฉลี่ยทั้งทีม: " & IFERROR(ROUND(AVERAGE(FILTER(${CALC}!$U$2:$U, ${CALC}!$I$2:$I<>"")), 1) & " วัน", "—") & ` +
      `"     ⏰ เกินกำหนดตอนนี้: " & COUNTIF(${CALC}!$M$2:$M, TRUE) & " งาน"`,
    ]],
  });
  requests.push(
    { mergeCells: { range: grid(gid, 18, 0, 19, 12), mergeType: 'MERGE_ALL' } },
    fmt(grid(gid, 18, 0, 19, 12), {
      backgroundColor: rgb(C.NEUTRAL), verticalAlignment: 'MIDDLE',
      textFormat: { bold: true, fontFamily: FONT, fontSize: 11, foregroundColor: rgb(C.PRIMARY) },
    }, 'backgroundColor,verticalAlignment,textFormat'),
  );

  requests.push(...widths(gid, [110, 80, 80, 90, 20, 110, 95, 90, 85, 20, 140, 90, 95]));
  requests.push(...baseFormat(gid, 60, 13));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 2 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  return { values, requests, rows: 60, cols: 13 };
}

function analyticsCharts(gid: number): sheets_v4.Schema$Request[] {
  const anchor = (row: number, col: number, w: number, h: number): sheets_v4.Schema$EmbeddedObjectPosition => ({
    overlayPosition: {
      anchorCell: { sheetId: gid, rowIndex: row, columnIndex: col },
      offsetXPixels: 0, offsetYPixels: 0, widthPixels: w, heightPixels: h,
    },
  });
  const src = (startRow: number, endRow: number, col: number): sheets_v4.Schema$ChartData => ({
    sourceRange: { sources: [grid(gid, startRow, col, endRow, col + 1)] },
  });

  return [
    {
      addChart: {
        chart: {
          spec: {
            title: 'งานเข้า vs งานเสร็จ (รายช่วงวันที่)',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'LINE',
              legendPosition: 'BOTTOM_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 14, 0) }],
              series: [
                { series: src(3, 14, 1), targetAxis: 'LEFT_AXIS', color: rgb(C.BLUE) },
                { series: src(3, 14, 2), targetAxis: 'LEFT_AXIS', color: rgb(C.GREEN) },
              ],
            },
          },
          position: anchor(20, 0, 450, 280),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'อัตรางานเสร็จรายช่วงวันที่',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 14, 0) }],
              series: [{ series: src(3, 14, 3), targetAxis: 'LEFT_AXIS', color: rgb(C.BLUE) }],
            },
          },
          position: anchor(20, 5, 450, 280),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'เวลาเฉลี่ยกว่างานจะเสร็จ แยกตามประเภท (วัน)',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 4 + TYPES.length, 5) }],
              series: [{ series: src(3, 4 + TYPES.length, 6), targetAxis: 'BOTTOM_AXIS', color: rgb(C.BLUE) }],
            },
          },
          position: anchor(36, 0, 450, 250),
        },
      },
    },
  ];
}

/**
 * 📅 สรุปงาน (was สรุปสัปดาห์) — one summary view over a USER-PICKED window:
 * either a whole month (เดือน + ปี dropdowns) or a single day (วันที่ cell).
 * Every metric and table below recomputes from the picked window; nothing here
 * is pinned to "this week" any more. Formula-only, like the rest of the
 * workspace — the picker is plain data-validated cells, no script.
 */
function buildSummary(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];
  const nowBkk = dayjs().tz(BANGKOK_TZ);

  // The picker cells (this tab's own → self()).
  const mode = self('B2');
  const month = self('D2');
  const year = self('E2');
  const day = self('G2');
  const monthNum = `MATCH(${month}, ${arr(THAI_MONTHS)}, 0)`;
  // DATE() normalises month 13 → January next year, so the month window needs
  // no special year-end handling.
  const start = `IF(${mode}="รายวัน", ${day}, DATE(${year}, ${monthNum}, 1))`;
  const end = `IF(${mode}="รายวัน", ${day}+1, DATE(${year}, ${monthNum}+1, 1))`;
  const windowLabel =
    `IF(${mode}="รายวัน", TEXT(${day}, "d mmmm yyyy"), ${month} & " " & ${year})`;

  values.push({ range: 'A1', rows: [[`="📅 สรุปงาน — " & ${windowLabel}`]] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 9)));

  // ---- the picker row ----
  values.push({
    range: 'A2',
    rows: [['ดูแบบ:', 'รายเดือน', 'เดือน:', THAI_MONTHS[nowBkk.month()] ?? THAI_MONTHS[0]!,
      String(nowBkk.year()), 'วันที่:', nowBkk.format('DD/MM/YYYY'),
      '← เลือก รายเดือน/รายวัน แล้วสรุปคำนวณใหม่เอง']],
  });
  [0, 2, 5].forEach((col) => {
    requests.push(fmt(grid(gid, 1, col, 2, col + 1), {
      horizontalAlignment: 'RIGHT', textFormat: { bold: true, fontSize: 9, fontFamily: FONT },
    }, 'horizontalAlignment,textFormat'));
  });
  [1, 3, 4, 6].forEach((col) => {
    requests.push(fmt(grid(gid, 1, col, 2, col + 1), {
      backgroundColor: rgb('#E3F2FD'), horizontalAlignment: 'CENTER',
      textFormat: { bold: true, fontFamily: FONT, foregroundColor: rgb(C.PRIMARY) },
    }, 'backgroundColor,horizontalAlignment,textFormat'));
  });
  requests.push(
    validationFromList(grid(gid, 1, 1, 2, 2), ['รายเดือน', 'รายวัน']),
    validationFromList(grid(gid, 1, 3, 2, 4), THAI_MONTHS),
    validationFromList(
      grid(gid, 1, 4, 2, 5),
      [nowBkk.year() - 2, nowBkk.year() - 1, nowBkk.year(), nowBkk.year() + 1].map(String),
    ),
    fmt(grid(gid, 1, 6, 2, 7), { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } }, 'numberFormat'),
    fmt(grid(gid, 1, 7, 2, 9), {
      textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
    }, 'textFormat'),
  );

  // ---- KPI cards for the picked window ----
  const cards: [string, string, string][] = [
    ['งานเข้าในช่วงนี้', `=COUNTIFS(${CALC}!$H$2:$H, ">="&${start}, ${CALC}!$H$2:$H, "<"&${end})`, C.ACCENT],
    ['เสร็จในช่วงนี้', `=COUNTIFS(${CALC}!$I$2:$I, ">="&${start}, ${CALC}!$I$2:$I, "<"&${end})`, C.SUCCESS],
    ['ครบกำหนดในช่วงนี้', `=COUNTIFS(${CALC}!$G$2:$G, ">="&${start}, ${CALC}!$G$2:$G, "<"&${end})`, C.WARNING],
    ['เกินกำหนดตอนนี้', `=COUNTIF(${CALC}!$M$2:$M, TRUE)`, C.DANGER],
  ];
  cards.forEach((card, i) => {
    const col = i * 2;
    values.push({ range: `${colLetter(col)}4`, rows: [[card[0]]] });
    values.push({ range: `${colLetter(col)}5`, rows: [[card[1]]] });
    requests.push(
      { mergeCells: { range: grid(gid, 3, col, 4, col + 2), mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: grid(gid, 4, col, 5, col + 2), mergeType: 'MERGE_ALL' } },
      fmt(grid(gid, 3, col, 4, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      fmt(grid(gid, 4, col, 5, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 22, bold: true, foregroundColor: rgb(card[2]) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
      {
        updateBorders: {
          range: grid(gid, 3, col, 5, col + 2),
          top: { style: 'SOLID_MEDIUM', color: rgb(card[2]) },
        },
      },
    );
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 4, endIndex: 5 },
      properties: { pixelSize: 44 },
      fields: 'pixelSize',
    },
  });

  // ---- tables over the picked window ----
  values.push({ range: 'A7', rows: [['✅ เสร็จในช่วงที่เลือก']] });
  values.push({ range: 'A8', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'ใช้เวลา (วัน)', 'เสร็จเมื่อ']] });
  values.push({
    range: 'A9',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `ROUND(${CALC}!U2:U, 1)`, `${CALC}!I2:I`],
      where: `(${CALC}!I2:I<>"") * (${CALC}!I2:I>=${start}) * (${CALC}!I2:I<${end})`,
      sortKey: `${CALC}!I2:I`,
      ascending: false,
      limit: 20,
      empty: 'ไม่มีงานเสร็จในช่วงที่เลือก',
    })]],
  });
  requests.push(...sectionHeader(gid, 6, 0, 4, '✅ เสร็จในช่วงที่เลือก'));
  requests.push(...headerFormat(grid(gid, 7, 0, 8, 4)));
  requests.push(fmt(grid(gid, 8, 3, 29, 4), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));

  values.push({ range: 'F7', rows: [['⏳ ครบกำหนดในช่วงที่เลือก']] });
  values.push({ range: 'F8', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'สถานะ']] });
  values.push({
    range: 'F9',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!G2:G`, `${CALC}!F2:F`],
      where: `(${CALC}!G2:G<>"") * (${CALC}!G2:G>=${start}) * (${CALC}!G2:G<${end})`,
      sortKey: `${CALC}!G2:G`,
      limit: 20,
      empty: 'ไม่มีงานครบกำหนดในช่วงที่เลือก',
    })]],
  });
  requests.push(...sectionHeader(gid, 6, 5, 4, '⏳ ครบกำหนดในช่วงที่เลือก'));
  requests.push(...headerFormat(grid(gid, 7, 5, 8, 9)));
  requests.push(fmt(grid(gid, 8, 7, 29, 8), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));

  values.push({ range: 'A31', rows: [['🚧 ค้างนานเกิน 7 วัน (สถานะปัจจุบัน ไม่ขึ้นกับช่วงที่เลือก)']] });
  values.push({ range: 'A32', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'สถานะ', 'ค้างมา']] });
  values.push({
    range: 'A33',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!F2:F`, `${CALC}!V2:V`],
      where: `(${CALC}!V2:V<>"")`,
      sortKey: `${CALC}!U2:U`,
      ascending: false,
      limit: 12,
      empty: '✨ ไม่มีงานค้างนาน',
    })]],
  });
  requests.push(...sectionHeader(gid, 30, 0, 5, '🚧 ค้างนานเกิน 7 วัน'));
  requests.push(...headerFormat(grid(gid, 31, 0, 32, 4)));

  requests.push(...widths(gid, [200, 130, 105, 130, 20, 190, 130, 130, 110]));
  requests.push(...baseFormat(gid, 46, 9));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 2 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // Freeze title + picker with the nav.
  return { values, requests, rows: 46, cols: 9, frozen: 2 };
}

/**
 * ✅ งานเสร็จ — every task whose status is เสร็จแล้ว, with the time it took.
 *
 * "ใช้เวลา" is _ข้อมูลคำนวณ column U, which for a finished row is the real
 * completion instant (hidden master column Q, stamped from the assignees'
 * done_at) minus the real creation instant (column P) — no new date field is
 * invented here, per the codebase's one-source-of-truth rule for stamps. Rows
 * are gated on I<>"" everywhere because U also holds the AGE of still-open
 * tasks.
 */
function buildDone(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['✅ งานเสร็จ — งานที่ปิดจบแล้ว และเวลาที่ใช้จริง']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 13)));
  values.push({
    range: 'A2',
    rows: [['เวลาที่ใช้ = เสร็จจริง − สร้างงาน (หน่วยวัน) · งานหลายรายการนับแยกตามรายการย่อย']],
  });
  requests.push(fmt(grid(gid, 1, 0, 2, 13), {
    textFormat: { fontSize: 9, fontFamily: FONT, foregroundColor: rgb(C.MUTED) },
  }, 'textFormat'));

  // ---- KPI strip ----
  const doneFilter = `FILTER(${CALC}!$U$2:$U, ${CALC}!$I$2:$I<>"")`;
  const cards: [string, string, string][] = [
    ['เสร็จทั้งหมด', `=COUNTIF(${CALC}!$F$2:$F, "เสร็จแล้ว")`, C.SUCCESS],
    ['เฉลี่ย (วัน)', `=IFERROR(ROUND(AVERAGE(${doneFilter}), 1), 0)`, C.ACCENT],
    ['เร็วสุด (วัน)', `=IFERROR(ROUND(MIN(${doneFilter}), 1), 0)`, C.PRIMARY],
    ['ช้าสุด (วัน)', `=IFERROR(ROUND(MAX(${doneFilter}), 1), 0)`, C.WARNING],
  ];
  cards.forEach((card, i) => {
    const col = i * 2;
    values.push({ range: `${colLetter(col)}4`, rows: [[card[0]]] });
    values.push({ range: `${colLetter(col)}5`, rows: [[card[1]]] });
    requests.push(
      { mergeCells: { range: grid(gid, 3, col, 4, col + 2), mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: grid(gid, 4, col, 5, col + 2), mergeType: 'MERGE_ALL' } },
      fmt(grid(gid, 3, col, 4, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      fmt(grid(gid, 4, col, 5, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 22, bold: true, foregroundColor: rgb(card[2]) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
      {
        updateBorders: {
          range: grid(gid, 3, col, 5, col + 2),
          top: { style: 'SOLID_MEDIUM', color: rgb(card[2]) },
        },
      },
    );
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 4, endIndex: 5 },
      properties: { pixelSize: 44 },
      fields: 'pixelSize',
    },
  });

  // ---- the list ----
  values.push({ range: 'A7', rows: [['📋 รายการงานที่เสร็จ (ล่าสุดขึ้นก่อน)']] });
  values.push({ range: 'A8', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'ผู้สั่ง', 'เสร็จเมื่อ', 'ใช้เวลา (วัน)']] });
  values.push({
    range: 'A9',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!D2:D`, `${CALC}!I2:I`, `ROUND(${CALC}!U2:U, 1)`],
      where: `(${CALC}!F2:F="เสร็จแล้ว") * (${CALC}!I2:I<>"")`,
      sortKey: `${CALC}!I2:I`,
      ascending: false,
      limit: 200,
      empty: 'ยังไม่มีงานที่เสร็จ',
    })]],
  });
  requests.push(...sectionHeader(gid, 6, 0, 5, '📋 รายการงานที่เสร็จ'));
  requests.push(...headerFormat(grid(gid, 7, 0, 8, 5)));
  requests.push(fmt(grid(gid, 8, 3, 209, 4), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));
  requests.push(banding(gid, 8, 0, 209, 5));

  // ---- distribution of completion time ----
  values.push({ range: 'G7', rows: [['⏱️ การกระจายเวลาที่ใช้']] });
  values.push({ range: 'G8', rows: [['ช่วงเวลา', 'จำนวนงาน']] });
  const doneGate = (extra: string) =>
    `=COUNTIFS(${CALC}!$I$2:$I, ">0"${extra})`;
  values.push({
    range: 'G9',
    rows: [
      ['ภายใน 1 วัน', doneGate(`, ${CALC}!$U$2:$U, "<=1"`)],
      ['1–3 วัน', doneGate(`, ${CALC}!$U$2:$U, ">1", ${CALC}!$U$2:$U, "<=3"`)],
      ['3–7 วัน', doneGate(`, ${CALC}!$U$2:$U, ">3", ${CALC}!$U$2:$U, "<=7"`)],
      ['7–14 วัน', doneGate(`, ${CALC}!$U$2:$U, ">7", ${CALC}!$U$2:$U, "<=14"`)],
      ['เกิน 14 วัน', doneGate(`, ${CALC}!$U$2:$U, ">14"`)],
    ],
  });
  requests.push(...sectionHeader(gid, 6, 6, 3, '⏱️ การกระจายเวลาที่ใช้'));
  requests.push(...headerFormat(grid(gid, 7, 6, 8, 8)));
  requests.push(fmt(grid(gid, 8, 7, 13, 8), { horizontalAlignment: 'CENTER' }, 'horizontalAlignment'));

  // ---- per person ----
  values.push({ range: 'J7', rows: [['🏆 เสร็จต่อคน']] });
  values.push({ range: 'J8', rows: [['สมาชิก', 'เสร็จ', 'เฉลี่ย (วัน)']] });
  const person = `${CONF}!$A$2:$A$40`;
  values.push({ range: 'J9', rows: [[`=IFERROR(FILTER(${person}, ${person}<>""), "")`]] });
  values.push({
    range: 'K9',
    rows: [[
      `=MAP(${person}, LAMBDA(p, IF(p="",, SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"")))))`,
    ]],
  });
  values.push({
    range: 'L9',
    rows: [[
      `=MAP(${person}, LAMBDA(p, IF(p="",, IFERROR(ROUND(` +
      `SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"") * ${CALC}!$U$2:$U$2000) / ` +
      `SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$I$2:$I$2000<>"")), 1), 0))))`,
    ]],
  });
  requests.push(...sectionHeader(gid, 6, 9, 4, '🏆 เสร็จต่อคน'));
  requests.push(...headerFormat(grid(gid, 7, 9, 8, 12)));
  requests.push(fmt(grid(gid, 8, 10, 48, 12), { horizontalAlignment: 'CENTER' }, 'horizontalAlignment'));

  requests.push(...widths(gid, [230, 140, 120, 130, 100, 20, 110, 90, 20, 140, 70, 90, 20]));
  requests.push(...baseFormat(gid, 212, 13));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 2 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  return { values, requests, rows: 212, cols: 13, frozen: 2 };
}

/** Charts for ✅ งานเสร็จ — sources on its own (nav-shifted) tab. */
function doneCharts(gid: number): sheets_v4.Schema$Request[] {
  const anchor = (row: number, col: number, w: number, h: number): sheets_v4.Schema$EmbeddedObjectPosition => ({
    overlayPosition: {
      anchorCell: { sheetId: gid, rowIndex: row, columnIndex: col },
      offsetXPixels: 0, offsetYPixels: 0, widthPixels: w, heightPixels: h,
    },
  });
  const src = (startRow: number, endRow: number, col: number): sheets_v4.Schema$ChartData => ({
    sourceRange: { sources: [grid(gid, startRow, col, endRow, col + 1)] },
  });

  return [
    {
      addChart: {
        chart: {
          spec: {
            title: 'การกระจายเวลาทำงาน (วัน)',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              // Header row 7 + the five buckets (nav-free; shiftChart moves it).
              domains: [{ domain: src(7, 13, 6) }],
              series: [{ series: src(7, 13, 7), targetAxis: 'LEFT_AXIS', color: rgb(C.GREEN) }],
            },
          },
          position: anchor(15, 6, 430, 280),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'งานเสร็จต่อคน',
            fontName: FONT,
            backgroundColor: rgb(C.WHITE),
            titleTextFormat: { fontFamily: FONT, fontSize: 12, bold: true, foregroundColor: rgb(C.NAVY) },
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(7, 39, 9) }],
              series: [{ series: src(7, 39, 10), targetAxis: 'BOTTOM_AXIS', color: rgb(C.BLUE) }],
            },
          },
          position: anchor(30, 6, 430, 300),
        },
      },
    },
  ];
}

/**
 * The "add a task" tab. It deliberately teaches the LINE commands instead of
 * offering an in-sheet form: the sync is one-way (nookeb → sheet), so a row
 * typed here would never become a real task, never notify anyone, and never
 * appear in the app. Pointing at the real entry points is the honest UX.
 */
function buildHelp(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['➕ วิธีสั่งงานใหม่']] });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 6)));

  const rows: string[][] = [
    ['', ''],
    ['📱 สั่งงานในกลุ่ม LINE', 'พิมพ์:  หนูเก็บเตือนงาน @ชื่อคน <ชื่องาน> ส่ง <วันไหน>'],
    ['', 'ตัวอย่าง:  หนูเก็บเตือนงาน @สมชาย ทำสไลด์นำเสนอ ส่งพรุ่งนี้ 17:00'],
    ['', 'หนูจะสรุปให้ดูก่อน กด "ยืนยัน" แล้วงานถึงจะถูกสร้างน้า'],
    ['', ''],
    ['🙋 งานส่วนตัว', 'ทักหนูในแชทส่วนตัว พิมพ์:  หนูเก็บเตือนงาน'],
    ['', 'หรือเปิดหน้า "งานของฉัน" บนเว็บแล้วกดปุ่มสร้างงาน'],
    ['', ''],
    ['✅ อัปเดตงาน', 'กดปุ่มบนการ์ดใน LINE: รับทราบ / เสร็จแล้ว / ส่งงานกลับ'],
    ['', 'คนสั่งงานกด "รับงาน" หรือ "ตีกลับ" ได้จากการ์ดเดียวกัน'],
    ['', ''],
    ['🔄 ชีตนี้อัปเดตเมื่อไหร่', 'ทุกครั้งที่งานเปลี่ยนแปลงในระบบหนูเก็บ ชีตจะอัปเดตให้เองภายในไม่กี่วินาที'],
    ['', ''],
    ['✏️ แก้ในชีตได้ไหม', 'คอลัมน์ 🚦 ความเร่งด่วน และ 📝 หมายเหตุ แก้เองได้เลย หนูจะไม่เขียนทับ'],
    ['', 'คอลัมน์อื่นหนูเขียนทับทุกครั้งที่ sync — แก้ที่ LINE หรือหน้าเว็บแทนน้า'],
    ['', ''],
    ['🗑️ ลบแถวในชีต', 'ลบได้ ไม่พัง — งานนั้นจะกลับมาใหม่เมื่อมีการอัปเดตครั้งถัดไป'],
    ['', ''],
    ['⚙️ สคริปต์เสริม (ไม่บังคับ)', 'เพิ่มปุ่มเลือกความเร่งด่วน + ตรวจงานเกินกำหนดทุกเช้า 07:00'],
    ['', 'ติดตั้ง: ส่วนขยาย → Apps Script → วางไฟล์ nookeb-addon.gs → บันทึก → รัน installTriggers()'],
    ['', 'ไฟล์อยู่ในโปรเจกต์ที่ google-sheets-workspace/nookeb-addon.gs'],
  ];
  // Column A is a narrow gutter — labels go in B, prose in C.
  values.push({ range: 'B2', rows });

  requests.push(...widths(gid, [30, 230, 620]));
  requests.push(...baseFormat(gid, 30, 4));
  requests.push(
    // Cover the whole prose block, not a fixed 25 rows — the copy grows.
    fmt(grid(gid, 1, 1, 30, 2), {
      textFormat: { bold: true, fontFamily: FONT, fontSize: 11, foregroundColor: rgb(C.PRIMARY) },
      verticalAlignment: 'TOP',
    }, 'textFormat,verticalAlignment'),
    fmt(grid(gid, 1, 2, 30, 3), {
      wrapStrategy: 'WRAP', verticalAlignment: 'TOP', textFormat: { fontFamily: FONT, fontSize: 10 },
    }, 'wrapStrategy,verticalAlignment,textFormat'),
  );

  return { values, requests, rows: 30, cols: 4 };
}

function buildConfig(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [['สมาชิก (อัตโนมัติ)', '', 'สถานะ', 'จำนวน', '', 'ประเภท', 'จำนวน', '', 'สมาชิก', 'งานค้าง']] });

  /**
   * The roster comes from the assignee column itself: join every cell, split on
   * the comma the worker writes between names, then de-duplicate. SPLIT cannot
   * be array-mapped, which is why this goes through TEXTJOIN rather than
   * ARRAYFORMULA.
   */
  values.push({
    range: 'A2',
    rows: [[
      `=IFERROR(SORT(UNIQUE(TRANSPOSE(TRIM(SPLIT(TEXTJOIN(",", TRUE, ${CALC}!$E$2:$E), ","))))), "")`,
    ]],
  });

  values.push({ range: 'C2', rows: STATUS_ALL.map((s) => [s, `=COUNTIF(${CALC}!$F$2:$F, "${s}")`]) });
  values.push({ range: 'F2', rows: TYPES.map((t) => [t, `=COUNTIF(${CALC}!$C$2:$C, "${t}")`]) });
  values.push({ range: 'I2', rows: [[`=IFERROR(FILTER($A$2:$A$40, $A$2:$A$40<>""), "")`]] });
  values.push({
    range: 'J2',
    rows: [[
      `=MAP($A$2:$A$40, LAMBDA(p, IF(p="",, SUMPRODUCT(ISNUMBER(SEARCH(p, ${CALC}!$E$2:$E$2000)) * (${CALC}!$N$2:$N$2000=TRUE)))))`,
    ]],
  });

  // Urgency list for the master column's dropdown.
  values.push({ range: 'L1', rows: [['ระดับความเร่งด่วน']] });
  values.push({ range: 'L2', rows: URGENCIES.map((u) => [u]) });

  requests.push(...baseFormat(gid, 60, 13));
  requests.push(fmt(grid(gid, 0, 0, 1, 13), { textFormat: { bold: true, fontFamily: FONT } }, 'textFormat'));

  return { values, requests, rows: 60, cols: 13 };
}

function buildCalc(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  values.push({ range: 'A1', rows: [CALC_HEADERS] });
  values.push({ range: 'A2', rows: calcFormulas() });

  requests.push(...baseFormat(gid, 2100, CALC_HEADERS.length));
  requests.push(
    fmt(grid(gid, 0, 0, 1, CALC_HEADERS.length), { textFormat: { bold: true, fontFamily: FONT } }, 'textFormat'),
    fmt(grid(gid, 1, 6, 2100, 9), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'),
    fmt(grid(gid, 1, 11, 2100, 12), { numberFormat: { type: 'NUMBER', pattern: '0.0' } }, 'numberFormat'),
    fmt(grid(gid, 1, 20, 2100, 21), { numberFormat: { type: 'NUMBER', pattern: '0.0' } }, 'numberFormat'),
  );

  return { values, requests, rows: 2100, cols: CALC_HEADERS.length };
}

// ---- shared small pieces ----

function sectionHeader(
  sheetId: number, row: number, col: number, span: number, _label: string,
): sheets_v4.Schema$Request[] {
  const range = grid(sheetId, row, col, row + 1, col + span);
  return [
    { mergeCells: { range, mergeType: 'MERGE_ALL' } },
    fmt(range, {
      backgroundColor: rgb(C.NEUTRAL), verticalAlignment: 'MIDDLE',
      padding: { left: 8 },
      textFormat: { bold: true, fontSize: 12, fontFamily: FONT, foregroundColor: rgb(C.ACCENT) },
    }, 'backgroundColor,verticalAlignment,padding,textFormat'),
    {
      updateBorders: {
        range,
        bottom: { style: 'SOLID', color: rgb(C.BORDER) },
        left: { style: 'SOLID_THICK', color: rgb(C.ACCENT) },
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 },
        properties: { pixelSize: ROW_H.SECTION },
        fields: 'pixelSize',
      },
    },
  ];
}

/**
 * Font, text colour, row rhythm and hidden gridlines for a whole tab.
 *
 * Gridlines are OFF everywhere in the workspace: the grey default grid fights
 * the #E3E8F0 borders the views draw for themselves, and a view that is mostly
 * merged cards reads as noise with both. Anything that needs a rule draws one.
 */
function baseFormat(sheetId: number, rows: number, cols: number): sheets_v4.Schema$Request[] {
  return [
    fmt(grid(sheetId, 0, 0, rows, cols), {
      backgroundColor: rgb(C.WHITE),
      textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.TEXT) },
      verticalAlignment: 'MIDDLE',
    }, 'backgroundColor,textFormat,verticalAlignment'),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: rows },
        properties: { pixelSize: ROW_H.DATA },
        fields: 'pixelSize',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { hideGridlines: true } },
        fields: 'gridProperties.hideGridlines',
      },
    },
  ];
}

/**
 * Zebra striping for a data table. `addBanding` is the native feature, so the
 * stripes follow rows as the view's FILTER output grows and shrinks — a
 * conditional format on ISEVEN(ROW()) would too, but banding also survives the
 * user sorting the range, and costs one request instead of one per range.
 */
function banding(
  sheetId: number, startRow: number, startCol: number, endRow: number, endCol: number,
): sheets_v4.Schema$Request {
  return {
    addBanding: {
      bandedRange: {
        range: grid(sheetId, startRow, startCol, endRow, endCol),
        rowProperties: {
          firstBandColor: rgb(C.WHITE),
          secondBandColor: rgb(C.LIGHT_BG),
        },
      },
    },
  };
}

/** A thin #E3E8F0 rule around and inside a range — the only grid the views show. */
function tableBorders(range: sheets_v4.Schema$GridRange): sheets_v4.Schema$Request {
  const line = { style: 'SOLID' as const, color: rgb(C.BORDER) };
  return {
    updateBorders: {
      range, top: line, bottom: line, left: line, right: line,
      innerHorizontal: line, innerVertical: line,
    },
  };
}

function validationFromList(range: sheets_v4.Schema$GridRange, list: string[]): sheets_v4.Schema$Request {
  return {
    setDataValidation: {
      range,
      rule: {
        condition: { type: 'ONE_OF_LIST', values: list.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

function validationFromRange(range: sheets_v4.Schema$GridRange, a1: string): sheets_v4.Schema$Request {
  return {
    setDataValidation: {
      range,
      rule: {
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: a1 }] },
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

/** 0-based column index → A1 letter (A..Z, AA..). */
function colLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// =====================================================================
// Master tab extension (K–R)
// =====================================================================

function masterExtensionRequests(gid: number): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  const first = MASTER_EXT.URGENCY;
  requests.push(
    ...headerFormat(grid(gid, 0, first, 1, MASTER_LAST_COLUMN)),
    ...widths(gid, [115, 110, 170, 180, 260, 130, 130, 130], first),
    fmt(grid(gid, 1, first, 1000, MASTER_LAST_COLUMN), {
      textFormat: { fontFamily: FONT, fontSize: 10 }, verticalAlignment: 'MIDDLE',
    }, 'textFormat,verticalAlignment'),
    fmt(grid(gid, 1, MASTER_EXT.URGENCY, 1000, MASTER_EXT.URGENCY + 1), {
      horizontalAlignment: 'CENTER',
    }, 'horizontalAlignment'),
    fmt(grid(gid, 1, MASTER_EXT.LOG, 1000, MASTER_EXT.LOG + 1), {
      wrapStrategy: 'WRAP', textFormat: { fontFamily: FONT, fontSize: 8, foregroundColor: rgb(C.MUTED) },
    }, 'wrapStrategy,textFormat'),
    fmt(grid(gid, 1, MASTER_EXT.CREATED, 1000, MASTER_LAST_COLUMN), {
      numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' },
    }, 'numberFormat'),
    validationFromRange(
      grid(gid, 1, MASTER_EXT.URGENCY, 1000, MASTER_EXT.URGENCY + 1),
      `=${CONF}!$L$2:$L$5`,
    ),
    // The three date columns are machine plumbing — useful to formulas, noise to
    // a reader, same reasoning as the hidden รหัสงาน column.
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: MASTER_EXT.CREATED, endIndex: MASTER_LAST_COLUMN },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
  );

  // Overdue deadlines go red — FONT only, because the sync repaints the
  // background of A–J on every write and would erase a fill.
  requests.push(cfFormula(
    gid,
    [grid(gid, 1, 4, 1000, 5)],
    `=AND($R2<>"", $R2<NOW(), OR(${STATUS_OPEN.map((s) => `$H2="${s}"`).join(', ')}))`,
    { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } },
  ));
  const URGENCY_BG = [C.URGENT_BG, C.SOON_BG, C.OK_BG, C.RELAX_BG];
  URGENCIES.forEach((u, i) => {
    const bg = URGENCY_BG[i] ?? C.OK_BG;
    requests.push(cfText(
      [grid(gid, 1, MASTER_EXT.URGENCY, 1000, MASTER_EXT.URGENCY + 1)],
      'TEXT_EQ', u, { backgroundColor: rgb(bg) },
    ));
  });

  return requests;
}

// =====================================================================
// Orchestration
// =====================================================================

/**
 * The builders' own nav-free grid sizes. `sizeOf` adds the nav strip's row and
 * widens anything narrower than the strip, so the grid a tab is CREATED with and
 * the coordinates its plan writes to can never disagree.
 */
const BASE_SIZE: Record<string, { rows: number; cols: number }> = {
  [TAB.DASH]: { rows: 40, cols: 14 },
  [TAB.PRIO]: { rows: 320, cols: 9 },
  [TAB.TRACK]: { rows: 320, cols: 9 },
  [TAB.TEAM]: { rows: 45, cols: 10 },
  [TAB.CAL]: { rows: 10, cols: 7 },
  [TAB.ANA]: { rows: 60, cols: 13 },
  [TAB.WEEK]: { rows: 46, cols: 9 },
  [TAB.DONE]: { rows: 212, cols: 13 },
  [TAB.HELP]: { rows: 30, cols: 4 },
  [TAB.CALC]: { rows: 2100, cols: CALC_HEADERS.length },
  [TAB.CONF]: { rows: 60, cols: 13 },
};

export function sizeOf(title: string): { rows: number; cols: number } {
  const base = BASE_SIZE[title] ?? { rows: 100, cols: 12 };
  return NAV_TABS.includes(title)
    ? { rows: base.rows + NAV_ROWS, cols: Math.max(base.cols, NAV.length) }
    : base;
}

/**
 * Build every tab's plan and drop the nav strip onto the visible ones.
 *
 * Extracted from ensureWorkspace and exported so the layout can be asserted
 * without a network call — this is where the nav offset is applied, and a
 * mistake here silently misplaces every formula in the workspace.
 *
 * The hidden calculation tabs are deliberately skipped: nothing links to them,
 * and shifting _ข้อมูลคำนวณ would move the ARRAYFORMULA anchors the whole
 * workspace reads. The master tab is skipped too — its row 1 is the sync's
 * header row, and a row above it would break every index the sync writes.
 */
export function composeWorkspacePlans(
  gid: (title: string) => number,
  masterGid: number,
  opts: { syncUrl?: string } = {},
): [string, TabPlan][] {
  const built: [string, TabPlan][] = [
    [TAB.CONF, buildConfig(gid(TAB.CONF))],
    [TAB.CALC, buildCalc(gid(TAB.CALC))],
    [TAB.DASH, buildDashboard(gid(TAB.DASH), opts.syncUrl)],
    [TAB.PRIO, buildPriority(gid(TAB.PRIO))],
    [TAB.TRACK, buildTracker(gid(TAB.TRACK))],
    [TAB.TEAM, buildTeam(gid(TAB.TEAM))],
    [TAB.CAL, buildCalendar(gid(TAB.CAL))],
    [TAB.ANA, buildAnalytics(gid(TAB.ANA))],
    [TAB.WEEK, buildSummary(gid(TAB.WEEK))],
    [TAB.DONE, buildDone(gid(TAB.DONE))],
    [TAB.HELP, buildHelp(gid(TAB.HELP))],
  ];

  return built.map(([title, plan]) => {
    if (!NAV_TABS.includes(title)) return [title, plan];
    const sheetId = gid(title);
    const { cols } = sizeOf(title);
    const shifted = shiftPlan(plan, NAV_ROWS);
    const nav = navBar(sheetId, cols, (t) => (t === MASTER ? masterGid : gid(t)));
    return [title, {
      ...shifted,
      cols,
      values: [...nav.values, ...shifted.values],
      requests: [
        ...shifted.requests,
        ...nav.requests,
        // Freeze the nav plus whatever header rows the view declared, so both
        // stay put while the data below scrolls. Last write wins over any
        // frozenRowCount the builder set for itself.
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { frozenRowCount: NAV_ROWS + (plan.frozen ?? 0) },
            },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    }];
  });
}

/**
 * Every embedded chart, nav-shifted and ready to batch. Charts are authored in
 * the same nav-free coordinates as their tab. The anchor always shifts; a
 * SOURCE range shifts only when it reads a tab that itself carries the nav
 * strip (see shiftChart) — _ตัวเลือก does not, the วิเคราะห์ and งานเสร็จ tabs
 * do. Exported so the shift is assertable without a network call: getting it
 * wrong makes a chart read one blank row and drop its last data row, which is
 * exactly what the pre-v4 analytics charts did.
 */
export function composeChartRequests(
  gid: (title: string) => number,
): sheets_v4.Schema$Request[] {
  const shiftedGids = new Set(NAV_TABS.map((title) => gid(title)));
  return [
    ...dashboardCharts(gid(TAB.DASH), gid(TAB.CONF))
      .map((r) => shiftChart(r, NAV_ROWS, shiftedGids)),
    ...analyticsCharts(gid(TAB.ANA)).map((r) => shiftChart(r, NAV_ROWS, shiftedGids)),
    ...doneCharts(gid(TAB.DONE)).map((r) => shiftChart(r, NAV_ROWS, shiftedGids)),
  ];
}

function readVersion(metadata: sheets_v4.Schema$DeveloperMetadata[] | undefined): number | null {
  const row = metadata?.find((m) => m.metadataKey === METADATA_KEY);
  if (!row?.metadataValue) return null;
  const parsed = Number(row.metadataValue);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build (or rebuild) the workspace around the sync's `งานของฉัน` tab.
 *
 * Returns true when it wrote a new layout, false when the sheet already had the
 * current version. Safe to call on every sync — the version check makes the
 * no-op path a single spreadsheets.get.
 */
export async function ensureWorkspace(
  auth: OAuth2Client,
  spreadsheetId: string,
  opts: { force?: boolean; syncUrl?: string } = {},
): Promise<boolean> {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties),developerMetadata',
  });

  const existingVersion = readVersion(meta.data.developerMetadata ?? undefined);
  if (!opts.force && existingVersion === LAYOUT_VERSION) return false;

  const existing = meta.data.sheets ?? [];
  const masterProps = existing.find((s) => s.properties?.title === MASTER)?.properties
    ?? existing[0]?.properties;
  if (!masterProps?.sheetId && masterProps?.sheetId !== 0) {
    throw new Error('workspace: master tab not found');
  }
  const masterGid = masterProps.sheetId!;
  const masterColumns = masterProps.gridProperties?.columnCount ?? 10;

  // --- pass 1: drop the generated tabs, recreate them empty ---------------
  // LEGACY_TABS are dropped too (a rebuild must clean up tabs an older layout
  // generated under names the current one no longer uses) but never recreated.
  const droppable: string[] = [...GENERATED_TABS, ...LEGACY_TABS];
  const drops: sheets_v4.Schema$Request[] = existing
    .filter((s) => droppable.includes(s.properties?.title ?? ''))
    .map((s) => ({ deleteSheet: { sheetId: s.properties!.sheetId! } }));

  const adds: sheets_v4.Schema$Request[] = GENERATED_TABS.map((title) => {
    const size = sizeOf(title);
    return {
      addSheet: {
        properties: { title, gridProperties: { rowCount: size.rows, columnCount: size.cols } },
      },
    };
  });

  // The master tab is created with only the sync's 10 columns. Widening it has
  // to happen HERE, in the first batch: pass 2 writes the K–R headers, and a
  // values write past the grid edge is a hard error, not an auto-expand.
  const widen: sheets_v4.Schema$Request[] = masterColumns < MASTER_LAST_COLUMN
    ? [{
        appendDimension: {
          sheetId: masterGid,
          dimension: 'COLUMNS',
          length: MASTER_LAST_COLUMN - masterColumns,
        },
      }]
    : [];

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [...drops, ...widen, ...adds] },
  });

  const gids = new Map<string, number>();
  (created.data.replies ?? []).forEach((reply) => {
    const props = reply.addSheet?.properties;
    if (props?.title && props.sheetId != null) gids.set(props.title, props.sheetId);
  });
  const gid = (title: string): number => {
    const found = gids.get(title);
    if (found == null) throw new Error(`workspace: missing gid for ${title}`);
    return found;
  };

  // --- pass 2: values (formulas + labels) --------------------------------
  const plans = composeWorkspacePlans(gid, masterGid, { syncUrl: opts.syncUrl });

  const data: sheets_v4.Schema$ValueRange[] = [
    { range: `'${MASTER}'!${colLetter(MASTER_EXT.URGENCY)}1`, values: [EXT_HEADERS] },
  ];
  plans.forEach(([title, plan]) => {
    plan.values.forEach((v) => data.push({ range: `'${title}'!${v.range}`, values: v.rows }));
  });

  // A rebuild deletes and recreates ภาพรวม, so the last-backfill line the
  // dashboard shows would revert to "ยังไม่เคย…" even though the backfill did
  // run. The metadata is the record of truth (it survives the rebuild); this
  // just paints it back on.
  const priorHistorical = parseHistoricalStamp(
    (meta.data.developerMetadata ?? []).find((m) => m.metadataKey === HISTORICAL_METADATA_KEY)
      ?.metadataValue,
  );
  if (priorHistorical) {
    data.push({
      range: `'${TAB.DASH}'!${HISTORICAL_STAMP_A1}`,
      values: [[formatHistoricalStamp(priorHistorical)]],
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // --- pass 3: formatting, charts, tab order, version stamp ---------------
  const requests: sheets_v4.Schema$Request[] = [];
  plans.forEach(([, plan]) => requests.push(...plan.requests));
  requests.push(...masterExtensionRequests(masterGid));
  requests.push(...composeChartRequests(gid));

  HIDDEN_TABS.forEach((title) => {
    requests.push({
      updateSheetProperties: { properties: { sheetId: gid(title), hidden: true }, fields: 'hidden' },
    });
  });
  TAB_ORDER.forEach((title, index) => {
    const id = title === MASTER ? masterGid : gids.get(title);
    if (id == null) return;
    requests.push({ updateSheetProperties: { properties: { sheetId: id, index }, fields: 'index' } });
  });

  if (existingVersion !== null) {
    requests.push({
      deleteDeveloperMetadata: {
        dataFilter: { developerMetadataLookup: { metadataKey: METADATA_KEY } },
      },
    });
  }
  requests.push({
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: METADATA_KEY,
        metadataValue: String(LAYOUT_VERSION),
        location: { spreadsheet: true },
        visibility: 'DOCUMENT',
      },
    },
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return true;
}

// =====================================================================
// Historical-backfill marker
// =====================================================================

export interface HistoricalStamp {
  /** ISO instant of the last completed backfill. */
  at: string;
  /** How many rows that run imported. */
  count: number;
}

/** `"<ISO>|<count>"` → a stamp, or null for anything unparseable. */
export function parseHistoricalStamp(value: string | null | undefined): HistoricalStamp | null {
  if (!value) return null;
  const [at, rawCount] = String(value).split('|');
  if (!at || !dayjs(at).isValid()) return null;
  const count = Number(rawCount);
  return { at, count: Number.isFinite(count) ? count : 0 };
}

export function serializeHistoricalStamp(stamp: HistoricalStamp): string {
  return `${stamp.at}|${stamp.count}`;
}

/** The one line the dashboard shows under the button. */
export function formatHistoricalStamp(stamp: HistoricalStamp | null): string {
  if (!stamp) return HISTORICAL_EMPTY_TEXT;
  const when = dayjs(stamp.at).tz(BANGKOK_TZ).format('DD/MM/YYYY HH:mm');
  return `ดึงล่าสุด ${when} · ${stamp.count} งาน`;
}

/** When (and how much) the last backfill imported, or null if never. */
export async function readHistoricalStamp(
  auth: OAuth2Client,
  spreadsheetId: string,
): Promise<HistoricalStamp | null> {
  const meta = await google
    .sheets({ version: 'v4', auth })
    .spreadsheets.get({ spreadsheetId, fields: 'developerMetadata' });
  const row = (meta.data.developerMetadata ?? []).find(
    (m) => m.metadataKey === HISTORICAL_METADATA_KEY,
  );
  return parseHistoricalStamp(row?.metadataValue);
}

/**
 * Record a completed backfill: the metadata (authoritative, survives a layout
 * rebuild) and the dashboard line (what the user actually sees).
 *
 * The cell write is best-effort — the marker matters, the cosmetics don't, and
 * ภาพรวม may legitimately not exist yet if the workspace build failed earlier.
 */
export async function writeHistoricalStamp(
  auth: OAuth2Client,
  spreadsheetId: string,
  stamp: HistoricalStamp,
): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth });
  const existing = await readHistoricalStamp(auth, spreadsheetId);

  const requests: sheets_v4.Schema$Request[] = [];
  // Deleting a key that isn't there is an error, not a no-op — same guard the
  // layout version uses.
  if (existing) {
    requests.push({
      deleteDeveloperMetadata: {
        dataFilter: { developerMetadataLookup: { metadataKey: HISTORICAL_METADATA_KEY } },
      },
    });
  }
  requests.push({
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: HISTORICAL_METADATA_KEY,
        metadataValue: serializeHistoricalStamp(stamp),
        location: { spreadsheet: true },
        visibility: 'DOCUMENT',
      },
    },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${TAB.DASH}'!${HISTORICAL_STAMP_A1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[formatHistoricalStamp(stamp)]] },
    });
  } catch {
    // The dashboard tab isn't there (or isn't writable) — the marker is stored,
    // which is the part correctness depends on.
  }
}

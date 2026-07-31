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

export const LAYOUT_VERSION = 1;
const METADATA_KEY = 'nookeb_layout_version';

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
  WEEK: '📅 สรุปสัปดาห์',
  HELP: '➕ วิธีสั่งงาน',
  CALC: '_ข้อมูลคำนวณ',
  CONF: '_ตัวเลือก',
} as const;

/** Order shown in the tab strip: dashboard, the raw table, then the views. */
const TAB_ORDER = [
  TAB.DASH, MASTER, TAB.PRIO, TAB.TRACK, TAB.TEAM,
  TAB.CAL, TAB.ANA, TAB.WEEK, TAB.HELP, TAB.CALC, TAB.CONF,
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

const C = {
  PRIMARY: '#1B4F8A',
  ACCENT: '#2196F3',
  SUCCESS: '#4CAF50',
  WARNING: '#FF9800',
  DANGER: '#F44336',
  NEUTRAL: '#F5F7FA',
  WHITE: '#FFFFFF',
  BORDER: '#D5DCE4',
  TEXT: '#1F2937',
  MUTED: '#6B7280',
  URGENT_BG: '#FDECEA',
  SOON_BG: '#FFF3E0',
  OK_BG: '#FFFDE7',
  RELAX_BG: '#E8F5E9',
  PURPLE: '#7E57C2',
  SLATE: '#607D8B',
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
 * Sheets cannot install a custom font, and Sarabun is not one of the families
 * the API can set on an arbitrary file. Arial is what the existing header uses;
 * it renders Thai correctly everywhere. The .xlsx export is where the branded
 * Thai font lives (see export.service.ts).
 */
const FONT = 'Arial';

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

/** Header band: navy background, white bold text, centred, 35px tall. */
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
      updateDimensionProperties: {
        range: {
          sheetId: range.sheetId!,
          dimension: 'ROWS',
          startIndex: range.startRowIndex!,
          endIndex: range.startRowIndex! + 1,
        },
        properties: { pixelSize: 35 },
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
 * Every generated view reads _ข้อมูลคำนวณ, never the master directly, so the
 * derivations (is it overdue? how many days left? which pipeline stage?) exist
 * in exactly one place. The master's own row gate is column J: a row without a
 * รหัสงาน is not a task.
 */
function calcFormulas(): string[][] {
  const gate = `${M}!$J$2:$J=""`;
  const pass = (expr: string) => `=ARRAYFORMULA(IF(${gate},, ${expr}))`;
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

interface TabPlan {
  /** A1 ranges (without the sheet name) → the values to write there. */
  values: { range: string; rows: (string | number)[][] }[];
  requests: sheets_v4.Schema$Request[];
  /** Grid size the tab is created with. */
  rows: number;
  cols: number;
}

function buildDashboard(gid: number): TabPlan {
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
        backgroundColor: rgb(k.bg), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      fmt(grid(gid, 3, col, 4, col + 2), {
        backgroundColor: rgb(k.bg), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 24, bold: true, foregroundColor: rgb(k.color) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
      fmt(grid(gid, 4, col, 5, col + 2), {
        backgroundColor: rgb(k.bg), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 8, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      {
        updateBorders: {
          range: grid(gid, 2, col, 5, col + 2),
          top: { style: 'SOLID_MEDIUM', color: rgb(k.color) },
          bottom: { style: 'SOLID_MEDIUM', color: rgb(k.color) },
          left: { style: 'SOLID_MEDIUM', color: rgb(k.color) },
          right: { style: 'SOLID_MEDIUM', color: rgb(k.color) },
        },
      },
    );
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 3, endIndex: 4 },
      properties: { pixelSize: 46 },
      fields: 'pixelSize',
    },
  });

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

  requests.push(...widths(gid, [95, 150, 130, 120, 110, 120, 20, 190, 130, 130, 120, 100]));
  requests.push(...baseFormat(gid, 40, 14));
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
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(0, 1 + TYPES.length, 5) }],
              series: [{ series: src(0, 1 + TYPES.length, 6), targetAxis: 'LEFT_AXIS' }],
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
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(0, 31, 8) }],
              series: [{ series: src(0, 31, 9), targetAxis: 'BOTTOM_AXIS' }],
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

  const filter =
    `IF($B$2="ทั้งหมด", 1, IF($B$2="เร่งด่วน", (${CALC}!K2:K<=2), ` +
    `IF($B$2="เกินกำหนด", (${CALC}!M2:M=TRUE), (${CALC}!F2:F="รอดำเนินการ"))))`;
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
    cfFormula(gid, [grid(gid, 4, 0, 320, 9)], `=$B5="${URGENCIES[0]}"`, { backgroundColor: rgb(C.URGENT_BG) }),
    cfFormula(gid, [grid(gid, 4, 0, 320, 9)], `=$B5="${URGENCIES[1]}"`, { backgroundColor: rgb(C.SOON_BG) }),
    cfText([grid(gid, 4, 5, 320, 6)], 'TEXT_CONTAINS', 'เกิน', { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }),
    cfText([grid(gid, 4, 8, 320, 9)], 'TEXT_CONTAINS', '⚠️', { textFormat: { foregroundColor: rgb(C.WARNING), bold: true } }),
  );

  return { values, requests, rows: 320, cols: 9 };
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

  const where =
    `IF($B$2="", 1, ISNUMBER(SEARCH($B$2, ${CALC}!D2:D))) * ` +
    `IF($D$2="", 1, ISNUMBER(SEARCH($D$2, ${CALC}!E2:E))) * ` +
    `IF($F$2="", 1, (${CALC}!C2:C=$F$2)) * ` +
    `IF($H$2="", 1, (${CALC}!J2:J=$H$2)) * (${CALC}!A2:A<>"")`;
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
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'ตีกลับ', { textFormat: { foregroundColor: rgb(C.DANGER), bold: true } }),
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'เสร็จสมบูรณ์', { textFormat: { foregroundColor: rgb(C.SUCCESS) } }),
    cfText([grid(gid, 4, 2, 320, 3)], 'TEXT_CONTAINS', 'รอตรวจ', { textFormat: { foregroundColor: rgb(C.PURPLE), bold: true } }),
  );

  return { values, requests, rows: 320, cols: 9 };
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
  const monthNum = `MATCH($D$1, ${arr(THAI_MONTHS)}, 0)`;
  const firstOfMonth = `DATE($E$1, ${monthNum}, 1)`;
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

  return { values, requests, rows: 10, cols: 7 };
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

  // ---- 12-week trend ----
  values.push({ range: 'A4', rows: [['สัปดาห์', 'งานเข้า', 'งานเสร็จ', 'อัตราเสร็จ']] });
  requests.push(...headerFormat(grid(gid, 3, 0, 4, 4)));
  const monday = 'TODAY()-WEEKDAY(TODAY(),3)';
  const weekRows: string[][] = [];
  for (let i = 11; i >= 0; i--) {
    const start = `${monday}-${i * 7}`;
    weekRows.push([
      `=TEXT(${start}, "d mmm")`,
      `=COUNTIFS(${CALC}!$H$2:$H, ">="&${start}, ${CALC}!$H$2:$H, "<"&${start}+7)`,
      `=COUNTIFS(${CALC}!$I$2:$I, ">="&${start}, ${CALC}!$I$2:$I, "<"&${start}+7)`,
      `=IF($B${5 + (11 - i)}=0, 0, $C${5 + (11 - i)}/$B${5 + (11 - i)})`,
    ]);
  }
  values.push({ range: 'A5', rows: weekRows });
  requests.push(fmt(grid(gid, 4, 3, 16, 4), { numberFormat: { type: 'PERCENT', pattern: '0%' } }, 'numberFormat'));

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
      `="🏆 ทำงานเสร็จมากที่สุด: " & IFERROR(INDEX($K$5:$K, MATCH(MAX($L$5:$L), $L$5:$L, 0)) & " (" & MAX($L$5:$L) & " งาน)", "—") & ` +
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
            title: 'งานเข้า vs งานเสร็จ (12 สัปดาห์)',
            fontName: FONT,
            basicChart: {
              chartType: 'LINE',
              legendPosition: 'BOTTOM_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 16, 0) }],
              series: [
                { series: src(3, 16, 1), targetAxis: 'LEFT_AXIS' },
                { series: src(3, 16, 2), targetAxis: 'LEFT_AXIS' },
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
            title: 'อัตรางานเสร็จรายสัปดาห์',
            fontName: FONT,
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 16, 0) }],
              series: [{ series: src(3, 16, 3), targetAxis: 'LEFT_AXIS' }],
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
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'NO_LEGEND',
              headerCount: 1,
              domains: [{ domain: src(3, 4 + TYPES.length, 5) }],
              series: [{ series: src(3, 4 + TYPES.length, 6), targetAxis: 'BOTTOM_AXIS' }],
            },
          },
          position: anchor(36, 0, 450, 250),
        },
      },
    },
  ];
}

function buildWeekly(gid: number): TabPlan {
  const values: TabPlan['values'] = [];
  const requests: sheets_v4.Schema$Request[] = [];
  const monday = 'TODAY()-WEEKDAY(TODAY(),3)';

  values.push({
    range: 'A1',
    rows: [[`="📅 สรุปสัปดาห์  " & TEXT(${monday}, "d mmm") & " – " & TEXT(${monday}+6, "d mmm yyyy")`]],
  });
  requests.push(...titleFormat(grid(gid, 0, 0, 1, 8)));

  const cards: [string, string, string][] = [
    ['งานเข้าใหม่สัปดาห์นี้', `=COUNTIFS(${CALC}!$H$2:$H, ">="&${monday}, ${CALC}!$H$2:$H, "<"&${monday}+7)`, C.ACCENT],
    ['เสร็จในสัปดาห์นี้', `=COUNTIFS(${CALC}!$I$2:$I, ">="&${monday}, ${CALC}!$I$2:$I, "<"&${monday}+7)`, C.SUCCESS],
    ['ยังค้างอยู่ทั้งหมด', `=COUNTIF(${CALC}!$N$2:$N, TRUE)`, C.WARNING],
    ['เกินกำหนดตอนนี้', `=COUNTIF(${CALC}!$M$2:$M, TRUE)`, C.DANGER],
  ];
  cards.forEach((card, i) => {
    const col = i * 2;
    values.push({ range: `${colLetter(col)}3`, rows: [[card[0]]] });
    values.push({ range: `${colLetter(col)}4`, rows: [[card[1]]] });
    requests.push(
      { mergeCells: { range: grid(gid, 2, col, 3, col + 2), mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: grid(gid, 3, col, 4, col + 2), mergeType: 'MERGE_ALL' } },
      fmt(grid(gid, 2, col, 3, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER',
        textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.MUTED) },
      }, 'backgroundColor,horizontalAlignment,textFormat'),
      fmt(grid(gid, 3, col, 4, col + 2), {
        backgroundColor: rgb(C.NEUTRAL), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
        textFormat: { fontFamily: FONT, fontSize: 22, bold: true, foregroundColor: rgb(card[2]) },
      }, 'backgroundColor,horizontalAlignment,verticalAlignment,textFormat'),
    );
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 3, endIndex: 4 },
      properties: { pixelSize: 44 },
      fields: 'pixelSize',
    },
  });

  values.push({ range: 'A6', rows: [['✅ งานที่เสร็จในสัปดาห์นี้']] });
  values.push({ range: 'A7', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'ใช้เวลา (วัน)', 'เสร็จเมื่อ']] });
  values.push({
    range: 'A8',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `ROUND(${CALC}!U2:U, 1)`, `${CALC}!I2:I`],
      where: `(${CALC}!I2:I>=${monday}) * (${CALC}!I2:I<${monday}+7)`,
      sortKey: `${CALC}!I2:I`,
      ascending: false,
      limit: 15,
      empty: 'ยังไม่มีงานเสร็จในสัปดาห์นี้',
    })]],
  });
  requests.push(...sectionHeader(gid, 5, 0, 4, '✅ งานที่เสร็จในสัปดาห์นี้'));
  requests.push(...headerFormat(grid(gid, 6, 0, 7, 4)));
  requests.push(fmt(grid(gid, 7, 3, 23, 4), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));

  values.push({ range: 'F6', rows: [['🚧 คอขวด — ค้างนานเกิน 7 วัน']] });
  values.push({ range: 'F7', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'สถานะ', 'ค้างมา']] });
  values.push({
    range: 'F8',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!F2:F`, `${CALC}!V2:V`],
      where: `(${CALC}!V2:V<>"")`,
      sortKey: `${CALC}!U2:U`,
      ascending: false,
      limit: 15,
      empty: '✨ ไม่มีงานค้างนาน',
    })]],
  });
  requests.push(...sectionHeader(gid, 5, 5, 4, '🚧 คอขวด — ค้างนานเกิน 7 วัน'));
  requests.push(...headerFormat(grid(gid, 6, 5, 7, 9)));

  values.push({ range: 'A25', rows: [['⏳ ครบกำหนดสัปดาห์หน้า']] });
  values.push({ range: 'A26', rows: [['ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'ระดับ', 'สถานะ']] });
  values.push({
    range: 'A27',
    rows: [[viewFormula({
      columns: [`${CALC}!B2:B`, `${CALC}!E2:E`, `${CALC}!G2:G`, `${CALC}!J2:J`, `${CALC}!F2:F`],
      where: `(${CALC}!N2:N=TRUE) * (${CALC}!G2:G>=${monday}+7) * (${CALC}!G2:G<${monday}+14)`,
      sortKey: `${CALC}!G2:G`,
      limit: 15,
      empty: 'ไม่มีงานครบกำหนดสัปดาห์หน้า',
    })]],
  });
  requests.push(...sectionHeader(gid, 24, 0, 5, '⏳ ครบกำหนดสัปดาห์หน้า'));
  requests.push(...headerFormat(grid(gid, 25, 0, 26, 5)));
  requests.push(fmt(grid(gid, 26, 2, 42, 3), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } }, 'numberFormat'));

  requests.push(...widths(gid, [200, 130, 105, 130, 20, 190, 130, 100, 110]));
  requests.push(...baseFormat(gid, 45, 9));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  return { values, requests, rows: 45, cols: 9 };
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
    ['💬 สั่งงานแบบพิมพ์ธรรมดา', 'แท็กคนในกลุ่มแล้วพิมพ์งานกับกำหนดส่งได้เลย หนูจะเดาให้เองแล้วถามยืนยัน'],
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
  ];
  // Column A is a narrow gutter — labels go in B, prose in C.
  values.push({ range: 'B2', rows });

  requests.push(...widths(gid, [30, 210, 560]));
  requests.push(...baseFormat(gid, 30, 4));
  requests.push(
    fmt(grid(gid, 1, 1, 25, 2), {
      textFormat: { bold: true, fontFamily: FONT, fontSize: 11, foregroundColor: rgb(C.PRIMARY) },
      verticalAlignment: 'TOP',
    }, 'textFormat,verticalAlignment'),
    fmt(grid(gid, 1, 2, 25, 3), {
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
      textFormat: { bold: true, fontSize: 12, fontFamily: FONT, foregroundColor: rgb(C.PRIMARY) },
    }, 'backgroundColor,verticalAlignment,textFormat'),
  ];
}

/** Font + text colour for the whole tab, plus hidden gridlines for the views. */
function baseFormat(sheetId: number, rows: number, cols: number): sheets_v4.Schema$Request[] {
  return [
    fmt(grid(sheetId, 0, 0, rows, cols), {
      textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: rgb(C.TEXT) },
      verticalAlignment: 'MIDDLE',
    }, 'textFormat,verticalAlignment'),
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { hideGridlines: true } },
        fields: 'gridProperties.hideGridlines',
      },
    },
  ];
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
  opts: { force?: boolean } = {},
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
  const drops: sheets_v4.Schema$Request[] = existing
    .filter((s) => GENERATED_TABS.includes((s.properties?.title ?? '') as (typeof GENERATED_TABS)[number]))
    .map((s) => ({ deleteSheet: { sheetId: s.properties!.sheetId! } }));

  // Sizes have to be known up front — addSheet cannot be resized in the same batch.
  const plansBySize: Record<string, { rows: number; cols: number }> = {
    [TAB.DASH]: { rows: 40, cols: 14 },
    [TAB.PRIO]: { rows: 320, cols: 9 },
    [TAB.TRACK]: { rows: 320, cols: 9 },
    [TAB.TEAM]: { rows: 45, cols: 10 },
    [TAB.CAL]: { rows: 10, cols: 7 },
    [TAB.ANA]: { rows: 60, cols: 13 },
    [TAB.WEEK]: { rows: 45, cols: 9 },
    [TAB.HELP]: { rows: 30, cols: 4 },
    [TAB.CALC]: { rows: 2100, cols: CALC_HEADERS.length },
    [TAB.CONF]: { rows: 60, cols: 13 },
  };
  const adds: sheets_v4.Schema$Request[] = GENERATED_TABS.map((title) => {
    const size = plansBySize[title] ?? { rows: 100, cols: 12 };
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
  const plans: [string, TabPlan][] = [
    [TAB.CONF, buildConfig(gid(TAB.CONF))],
    [TAB.CALC, buildCalc(gid(TAB.CALC))],
    [TAB.DASH, buildDashboard(gid(TAB.DASH))],
    [TAB.PRIO, buildPriority(gid(TAB.PRIO))],
    [TAB.TRACK, buildTracker(gid(TAB.TRACK))],
    [TAB.TEAM, buildTeam(gid(TAB.TEAM))],
    [TAB.CAL, buildCalendar(gid(TAB.CAL))],
    [TAB.ANA, buildAnalytics(gid(TAB.ANA))],
    [TAB.WEEK, buildWeekly(gid(TAB.WEEK))],
    [TAB.HELP, buildHelp(gid(TAB.HELP))],
  ];

  const data: sheets_v4.Schema$ValueRange[] = [
    { range: `'${MASTER}'!${colLetter(MASTER_EXT.URGENCY)}1`, values: [EXT_HEADERS] },
  ];
  plans.forEach(([title, plan]) => {
    plan.values.forEach((v) => data.push({ range: `'${title}'!${v.range}`, values: v.rows }));
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // --- pass 3: formatting, charts, tab order, version stamp ---------------
  const requests: sheets_v4.Schema$Request[] = [];
  plans.forEach(([, plan]) => requests.push(...plan.requests));
  requests.push(...masterExtensionRequests(masterGid));
  requests.push(...dashboardCharts(gid(TAB.DASH), gid(TAB.CONF)));
  requests.push(...analyticsCharts(gid(TAB.ANA)));

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

import ExcelJS from 'exceljs';
import type { TaskItemStatus, TaskType } from '@nookeb/shared';

/**
 * ระบบตามงาน — Excel export (.xlsx).
 *
 * Pure + env-free (same shape as docx-builder / pdf-merge): the route resolves
 * names and dates, this file only lays out and styles the workbook. That keeps
 * it unit-testable without a DB, a LINE token, or an R2 client.
 *
 * ONE ROW PER ITEM, not per task. A 'multi' task's whole point is that each
 * รายการ has its own assignee, deadline and status — collapsing them into one
 * row would throw away exactly the columns the export exists for. 'single' and
 * 'recurring' have one implicit item, so they still produce one row each.
 */

export interface TaskExportRow {
  /** display title — "งาน — รายการ" for multi, plain task title otherwise */
  title: string;
  description: string | null;
  type: TaskType;
  /** effective deadline (item's own, else the task's), ISO */
  deadline: string | null;
  /** resolved display name of whoever created the task */
  createdBy: string;
  /** resolved display names of this item's assignees */
  assignees: string[];
  status: TaskItemStatus;
  createdAt: string;
  /** newest activity we can derive — see resolveUpdatedAt() in routes/tasks.ts */
  updatedAt: string | null;
}

const TYPE_LABEL: Record<TaskType, string> = {
  single: 'งานเดียว',
  multi: 'หลายรายการ',
  recurring: 'งานประจำ',
};

const STATUS_LABEL: Record<TaskItemStatus, string> = {
  pending: 'รอดำเนินการ',
  in_progress: 'กำลังทำ',
  done: 'เสร็จแล้ว',
  cancelled: 'ยกเลิก',
  submitted: 'รอตรวจ',
  rejected: 'ตีกลับ',
};

const BRAND_RED = 'FFB91C1C';
const ZEBRA_GREY = 'FFF9FAFB';
const BORDER_GREY = 'FFE5E7EB';

const COLUMNS: { header: string; key: keyof SheetRow; width: number }[] = [
  { header: 'ลำดับ', key: 'index', width: 8 },
  { header: 'ชื่องาน', key: 'title', width: 34 },
  { header: 'รายละเอียด', key: 'description', width: 40 },
  { header: 'ประเภท', key: 'type', width: 14 },
  { header: 'วันกำหนดส่ง', key: 'deadline', width: 18 },
  { header: 'ผู้สั่ง', key: 'createdBy', width: 20 },
  { header: 'ผู้รับผิดชอบ', key: 'assignees', width: 26 },
  { header: 'สถานะ', key: 'status', width: 14 },
  { header: 'วันที่สร้าง', key: 'createdAt', width: 18 },
  { header: 'อัปเดตล่าสุด', key: 'updatedAt', width: 18 },
];

interface SheetRow {
  index: number;
  title: string;
  description: string;
  type: string;
  deadline: Date | null;
  createdBy: string;
  assignees: string;
  status: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * ISO instant → a Date whose UTC fields read as Bangkok wall clock.
 *
 * Excel stores a date as a timezone-less serial number and renders it verbatim,
 * while exceljs serialises a JS Date from its UTC parts. Writing the raw instant
 * would therefore show a 09:00 Bangkok deadline as 02:00 to every reader. Adding
 * the fixed +07:00 (Thailand has no DST) makes the cell display the time the
 * user actually set — and keeps it a REAL date cell, so Excel's sort and date
 * filters still work. Writing a pre-formatted string would lose both.
 */
function toSheetDate(iso: string | null): Date | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + BANGKOK_OFFSET_MS);
}

export async function exportTasksToExcel(rows: TaskExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'หนูเก็บ (nookeb)';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('งานของฉัน', {
    views: [{ state: 'frozen', ySplit: 1 }], // header stays put while scrolling
  });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  rows.forEach((row, i) => {
    sheet.addRow({
      index: i + 1,
      title: row.title,
      description: row.description ?? '',
      type: TYPE_LABEL[row.type] ?? row.type,
      deadline: toSheetDate(row.deadline),
      createdBy: row.createdBy,
      assignees: row.assignees.join(', '),
      status: STATUS_LABEL[row.status] ?? row.status,
      createdAt: toSheetDate(row.createdAt),
      updatedAt: toSheetDate(row.updatedAt),
    } satisfies SheetRow);
  });

  // ---- header row ----
  const header = sheet.getRow(1);
  header.height = 22;
  header.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
    cell.border = {
      top: { style: 'thin', color: { argb: BORDER_GREY } },
      left: { style: 'thin', color: { argb: BORDER_GREY } },
      bottom: { style: 'thin', color: { argb: BORDER_GREY } },
      right: { style: 'thin', color: { argb: BORDER_GREY } },
    };
  });

  // ---- data rows: zebra + wrapping + date formats ----
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    row.font = { name: 'Calibri', size: 11 };
    row.alignment = { vertical: 'top', wrapText: true };
    // Zebra counts DATA rows, not sheet rows: row 2 is the first data row and
    // must be white, so the shading keys off (r - 2) being odd.
    if ((r - 2) % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_GREY } };
      });
    }
    row.getCell('index').alignment = { vertical: 'top', horizontal: 'center' };
    for (const key of ['deadline', 'createdAt', 'updatedAt'] as const) {
      row.getCell(key).numFmt = 'dd/mm/yyyy hh:mm';
    }
  }

  // Auto-filter over the full used range (header + data), so an empty export
  // still gets a filterable header rather than a broken A1:J1 range.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: COLUMNS.length },
  };

  // exceljs types this as ExcelJS.Buffer (an ArrayBuffer-alike) — Fastify wants
  // a Node Buffer to set Content-Length correctly.
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** `nookeb-tasks-20260722.xlsx` — Bangkok calendar day, never the server's. */
export function exportFilename(now: Date = new Date()): string {
  const bkk = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `nookeb-tasks-${bkk.getUTCFullYear()}${pad(bkk.getUTCMonth() + 1)}${pad(bkk.getUTCDate())}.xlsx`;
}

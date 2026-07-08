import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  LineRuleType,
  Paragraph,
  TextRun,
} from 'docx';

/**
 * Shared Thai document components for the convert-to-Word (.docx) builder.
 *
 * Everything here is layout vocabulary that multiple document templates reuse:
 * - the two page styles (general documents vs. official ระเบียบงานสารบรรณ style)
 * - Thai Buddhist Era date formatting + Thai digit conversion
 * - inline markdown mark parsing (**bold** / *italic* / `code`)
 * - paragraph builders: body text, headings, official-letter label lines
 *   (เรื่อง/เรียน/อ้างถึง…), signature blocks (ลงชื่อ…/(ชื่อ)/ตำแหน่ง…), and
 *   official body paragraphs (Thai-justified with the standard first-line indent)
 *
 * Pure module: no config/env imports, so unit tests run env-free.
 *
 * Style threading: builders read the module-level active style (set by
 * buildDocxFromMarkdown before the synchronous build phase). This is safe
 * because docx object construction never awaits — each build sets its style
 * and constructs the whole document tree before any other build can run.
 */

export const THAI_FONT = 'TH Sarabun New';
export const A4_WIDTH = 11906;
export const A4_HEIGHT = 16838;
export const FOOTER_SIZE = 24; // 12pt small print
export const FOOTER_COLOR = '595959';

/** ~2.5cm — the standard Thai official first-line paragraph indent. */
export const FIRST_LINE_INDENT = 1418;

export interface LineSpacing {
  line: number;
  lineRule: (typeof LineRuleType)[keyof typeof LineRuleType];
}

export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TemplateStyle {
  /** Body run size in half-points. */
  bodySize: number;
  /** H1..H6 run sizes in half-points. */
  headingSizes: readonly number[];
  /** Body line spacing. */
  line: LineSpacing;
  /** Page margins in twips. */
  margins: PageMargins;
  /** Official docs: "- n -" page-number footer, bottom center, from page 2. */
  officialPageNumbers: boolean;
}

/** General documents: 14pt TH Sarabun (visually ≈ 10-11pt), 2.5cm margins. */
export const DEFAULT_STYLE: TemplateStyle = {
  bodySize: 28,
  headingSizes: [44, 36, 32, 30, 28, 28],
  line: { line: 276, lineRule: LineRuleType.AUTO }, // 1.15
  margins: { top: 1417, right: 1417, bottom: 1417, left: 1417 },
  officialPageNumbers: false,
};

/**
 * Official Thai document style per ระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ:
 * TH Sarabun New 16pt body, single spacing, margins 3cm top / 2cm right /
 * 2.5cm bottom / 3cm left, page numbers bottom center (not on page 1).
 */
export const OFFICIAL_STYLE: TemplateStyle = {
  bodySize: 32, // 16pt
  headingSizes: [36, 32, 32, 32, 32, 32], // title 18pt, the rest 16pt bold
  line: { line: 240, lineRule: LineRuleType.AUTO }, // 1.0 exact
  margins: { top: 1701, right: 1134, bottom: 1417, left: 1701 },
  officialPageNumbers: true,
};

let activeStyle: TemplateStyle = DEFAULT_STYLE;

export function setActiveStyle(style: TemplateStyle): void {
  activeStyle = style;
}

export function getActiveStyle(): TemplateStyle {
  return activeStyle;
}

/** Usable width between the active style's margins (DXA). */
export function contentWidth(): number {
  return A4_WIDTH - activeStyle.margins.left - activeStyle.margins.right;
}

// ---------------------------------------------------------------------------
// Thai Buddhist Era dates / Thai digits
// ---------------------------------------------------------------------------

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/** '2569' → '๒๕๖๙' (Arabic digits → Thai digits, everything else untouched). */
export function toThaiDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => THAI_DIGITS[Number(d)] ?? d);
}

/**
 * Date → Thai Buddhist Era string, e.g. "9 กรกฎาคม 2569"
 * (or "๙ กรกฎาคม ๒๕๖๙" with thaiDigits).
 */
export function formatThaiBuddhistDate(date: Date, opts: { thaiDigits?: boolean } = {}): string {
  const s = `${date.getDate()} ${THAI_MONTHS[date.getMonth()]} ${date.getFullYear() + 543}`;
  return opts.thaiDigits ? toThaiDigits(s) : s;
}

// ---------------------------------------------------------------------------
// Inline marks
// ---------------------------------------------------------------------------

export interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
}

/** **bold** / *italic* / ***both*** / `code` (code renders plain) → runs. */
export function parseInlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  // Longest markers first so ** isn't consumed as two *.
  const re = /(\*\*\*|___)(.+?)\1|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true, italics: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], italics: true });
    else runs.push({ text: m[7] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((r) => r.text.length > 0);
}

// ---------------------------------------------------------------------------
// Run / paragraph builders
// ---------------------------------------------------------------------------

export function textRuns(
  text: string,
  extra: { bold?: boolean; size?: number; color?: string } = {},
): TextRun[] {
  return parseInlineRuns(text).map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold || extra.bold,
        italics: r.italics,
        color: extra.color,
        font: THAI_FONT,
        size: extra.size ?? activeStyle.bodySize,
      }),
  );
}

export function bodyParagraph(
  text: string,
  opts: {
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    size?: number;
    color?: string;
    bold?: boolean;
    after?: number;
  } = {},
): Paragraph {
  return new Paragraph({
    children: textRuns(text, { size: opts.size, color: opts.color, bold: opts.bold }),
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing: { after: opts.after ?? 120, ...activeStyle.line },
  });
}

const HEADING_BY_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

export function headingParagraph(level: number, text: string, centered: boolean): Paragraph {
  const idx = Math.min(Math.max(level, 1), 6) - 1;
  return new Paragraph({
    heading: HEADING_BY_LEVEL[idx],
    alignment: centered ? AlignmentType.CENTER : undefined,
    children: parseInlineRuns(text).map(
      (r) =>
        new TextRun({
          text: r.text,
          italics: r.italics,
          bold: true,
          // Heading styles default to blue Calibri sizing — force TH Sarabun
          // sizes and black so the output matches the (B/W) source document.
          color: '000000',
          font: THAI_FONT,
          size: activeStyle.headingSizes[idx],
        }),
    ),
    spacing: { before: 240, after: 120, ...activeStyle.line },
  });
}

/** Thin horizontal rule between zones (a bordered paragraph, not a table). */
export function horizontalRule(): Paragraph {
  return new Paragraph({
    children: [],
    spacing: { before: 60, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF' } },
  });
}

/** Paragraph with a bold lead phrase (ข้อ 1 / ระเบียบวาระที่ 1 / มติที่ประชุม …). */
export function boldLeadParagraph(
  lead: string,
  rest: string,
  opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {},
): Paragraph {
  return new Paragraph({
    children: [...textRuns(lead, { bold: true }), ...textRuns(rest)],
    alignment: opts.align,
    spacing: { before: 120, after: 80, ...activeStyle.line },
  });
}

// ---------------------------------------------------------------------------
// Official-letter label lines (เรื่อง / เรียน / อ้างถึง / …)
// ---------------------------------------------------------------------------

// Longest alternatives first — 'สิ่งที่ส่งมาด้วย' and 'วันที่' must win over 'ที่'.
// A space after the label is required, which keeps 'ที่อยู่ …' (address) out.
const LABEL_RE =
  /^(สิ่งที่ส่งมาด้วย|ส่วนราชการ|อ้างถึง|เขียนที่|เรื่อง|เรียน|วันที่|ที่)\s+(\S.*)$/;

export function isOfficialLabelLine(text: string): boolean {
  return LABEL_RE.test(text.trim());
}

/** "เรื่อง ขออนุมัติ…" → bold label + plain rest, on its own line. */
export function labelParagraph(text: string): Paragraph {
  const m = text.trim().match(LABEL_RE);
  if (!m) return bodyParagraph(text);
  return new Paragraph({
    children: [...textRuns(`${m[1]}  `, { bold: true }), ...textRuns(m[2] ?? '')],
    spacing: { after: 80, ...activeStyle.line },
  });
}

// ---------------------------------------------------------------------------
// Signature blocks
// ---------------------------------------------------------------------------

// Exact role words that stand alone under a signature line. Deliberately a
// closed list — prose sentences also start with ผู้เช่า/ผู้ขาย etc.
const SIGNATURE_ROLE =
  'ผู้(?:มอบอำนาจ|รับมอบอำนาจ|ให้เช่า|เช่า|ว่าจ้าง|รับจ้าง|ซื้อ|ขาย|รับเงิน|จ่ายเงิน|สมัคร|ค้ำประกัน|ตรวจสอบ|อนุมัติ|แจ้ง|รับงาน|จดรายงานการประชุม)|พยาน|ประธานที่ประชุม';

const SIGNATURE_RES: RegExp[] = [
  /^\(?ลง(?:ลายมือ)?ชื่อ\)?(?:[\s.…_]|$)/, // ลงชื่อ………… / (ลงชื่อ)
  /^\([^()]{2,60}\)(?:\s|$)/, // (นายสมชาย ใจดี)
  /^ตำแหน่ง(?:\s|\.)/, // ตำแหน่ง ผู้จัดการ
  new RegExp(`(?:\\.{4,}|_{4,})\\s*(?:${SIGNATURE_ROLE})\\s*$`), // ………ผู้เช่า
  new RegExp(`^(?:${SIGNATURE_ROLE})\\s*$`), // standalone role word
  /^(?:ประกาศ|ให้ไว้|สั่ง)\s+ณ\s+วันที่/, // ประกาศ ณ วันที่ …
];

export function isSignatureLine(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 120 && SIGNATURE_RES.some((re) => re.test(t));
}

/** Signature-zone line: centered, with breathing room above. */
export function signatureParagraph(text: string): Paragraph {
  return new Paragraph({
    children: textRuns(text),
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 40, ...activeStyle.line },
  });
}

// ---------------------------------------------------------------------------
// Official body paragraph
// ---------------------------------------------------------------------------

/** Thai-justified with the standard 2.5cm first-line indent. */
export function officialBodyParagraph(text: string): Paragraph {
  return new Paragraph({
    children: textRuns(text),
    alignment: AlignmentType.THAI_DISTRIBUTE,
    indent: { firstLine: FIRST_LINE_INDENT },
    spacing: { after: 60, ...activeStyle.line },
  });
}

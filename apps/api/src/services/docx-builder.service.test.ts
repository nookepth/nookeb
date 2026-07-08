import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_TEMPLATES,
  buildDocxFromMarkdown,
  computeColumnWidths,
  detectDocumentType,
  documentTypeDisplayName,
  formatThaiBuddhistDate,
  isNumericCell,
  isOfficialLabelLine,
  isSignatureLine,
  parseInlineRuns,
  parseMarkdownBlocks,
  toThaiDigits,
  type Block,
  type DocumentType,
} from './docx-builder.service';

test('parseMarkdownBlocks: headings, paragraphs, lists', () => {
  const blocks = parseMarkdownBlocks(
    '# หัวข้อใหญ่\n\nย่อหน้าแรก\nต่อบรรทัดเดียวกัน\n\n- ข้อแรก\n- ข้อสอง\n1. ลำดับหนึ่ง\n\n## หัวข้อรอง',
  );
  assert.deepEqual(blocks, [
    { kind: 'heading', level: 1, text: 'หัวข้อใหญ่' },
    { kind: 'paragraph', text: 'ย่อหน้าแรก ต่อบรรทัดเดียวกัน' },
    { kind: 'list-item', ordered: false, text: 'ข้อแรก' },
    { kind: 'list-item', ordered: false, text: 'ข้อสอง' },
    { kind: 'list-item', ordered: true, text: 'ลำดับหนึ่ง' },
    { kind: 'heading', level: 2, text: 'หัวข้อรอง' },
  ] satisfies Block[]);
});

test('parseMarkdownBlocks: pipe table with header separator', () => {
  const blocks = parseMarkdownBlocks('| ชื่อ | จำนวน |\n| --- | ---: |\n| ข้าว | 2 |\n| น้ำ | 5 |\n\nท้ายตาราง');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    kind: 'table',
    headerRow: true,
    rows: [
      ['ชื่อ', 'จำนวน'],
      ['ข้าว', '2'],
      ['น้ำ', '5'],
    ],
  });
  assert.deepEqual(blocks[1], { kind: 'paragraph', text: 'ท้ายตาราง' });
});

test('parseMarkdownBlocks: HTML table (Mistral OCR 3 emits these)', () => {
  const blocks = parseMarkdownBlocks(
    'ก่อนตาราง\n<table><tr><th>A</th><th>B&amp;C</th></tr>\n<tr><td>1</td><td>2</td></tr></table>\nหลังตาราง',
  );
  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: 'ก่อนตาราง' },
    {
      kind: 'table',
      headerRow: true,
      rows: [
        ['A', 'B&C'],
        ['1', '2'],
      ],
    },
    { kind: 'paragraph', text: 'หลังตาราง' },
  ] satisfies Block[]);
});

test('parseMarkdownBlocks: image refs are dropped, pipes without separator are prose', () => {
  const blocks = parseMarkdownBlocks('![img](fig1.png)\nราคา 10|20 บาท');
  assert.deepEqual(blocks, [{ kind: 'paragraph', text: 'ราคา 10|20 บาท' }] satisfies Block[]);
});

test('parseInlineRuns: bold / italic / bold-italic / code', () => {
  assert.deepEqual(parseInlineRuns('ปกติ **หนา** และ *เอียง* กับ ***ทั้งคู่*** และ `โค้ด`'), [
    { text: 'ปกติ ' },
    { text: 'หนา', bold: true },
    { text: ' และ ' },
    { text: 'เอียง', italics: true },
    { text: ' กับ ' },
    { text: 'ทั้งคู่', bold: true, italics: true },
    { text: ' และ ' },
    { text: 'โค้ด' },
  ]);
});

test('buildDocxFromMarkdown: produces a non-empty .docx (ZIP magic) with page breaks', async () => {
  const buf = await buildDocxFromMarkdown(['# หน้า 1\nข้อความ', '## หน้า 2\n| a | b |\n|---|---|\n| 1 | 2 |']);
  assert.ok(buf.length > 1000);
  // .docx is a ZIP container — PK\x03\x04
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
});

test('buildDocxFromMarkdown: empty input still yields a valid document', async () => {
  const buf = await buildDocxFromMarkdown(['']);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
});

// ---------------------------------------------------------------------------
// Document type detection
// ---------------------------------------------------------------------------

const THAI_INVOICE_MD = [
  '# ใบแจ้งหนี้',
  '## ว.อาร์.เอส.อพาร์ตเมนท์',
  'เลขที่ใบแจ้งหนี้ / Invoice No : 52141-53249',
  'ชื่อ / Name นาย ทดสอบ ระบบ',
  '<table><tr><th>รายการ / Description</th><th>จำนวน / Amount</th></tr>',
  '<tr><td>ค่าห้องพัก</td><td>3,000.00</td></tr>',
  '<tr><td>ค่าไฟฟ้า</td><td>1,360.75</td></tr>',
  '<tr><td>มูลค่ารวม / Amount</td><td>5,400.93</td></tr>',
  '<tr><td>ภาษีมูลค่าเพิ่ม / Vat</td><td>140.07</td></tr>',
  '<tr><td>รวมทั้งสิ้น / Total</td><td>5,541.00</td></tr></table>',
  'วันที่สุดท้ายที่ต้องชำระ 1 กรกฎาคม 2569',
].join('\n');

test('detectDocumentType: Thai invoice', () => {
  assert.equal(detectDocumentType(THAI_INVOICE_MD), 'invoice');
});

test('detectDocumentType: Thai rental contract', () => {
  const md =
    '# หนังสือสัญญาเช่าห้องพัก\nระหว่าง ผู้ให้เช่า กับ ผู้เช่า\nข้อ 1 ผู้เช่าตกลงเช่าห้องพัก\nข้อ 2 ชำระค่าเช่ารายเดือน\nลงลายมือชื่อ พยาน';
  assert.equal(detectDocumentType(md), 'contract');
});

test('detectDocumentType: "สัญญาเลขที่" inside an invoice does not flip it to contract', () => {
  assert.equal(detectDocumentType(THAI_INVOICE_MD + '\nสัญญาเลขที่ / Contract No : VR-CO-2308-0004'), 'invoice');
});

test('detectDocumentType: form with checkboxes and label:value lines', () => {
  const md = '# แบบฟอร์มคำร้อง\nชื่อ: สมชาย\nที่อยู่: กรุงเทพ\nโทร: 081\n☐ เห็นด้วย ☐ ไม่เห็นด้วย';
  assert.equal(detectDocumentType(md), 'form');
});

test('detectDocumentType: table-dominant page → table_heavy', () => {
  const md = 'สรุป\n| ก | ข |\n|---|---|\n| ข้อมูลยาวมากหนึ่ง | ข้อมูลยาวมากสอง |\n| ข้อมูลยาวมากสาม | ข้อมูลยาวมากสี่ |';
  assert.equal(detectDocumentType(md), 'table_heavy');
});

test('detectDocumentType: plain prose → generic', () => {
  assert.equal(detectDocumentType('# บันทึกช่วยจำ\nวันนี้อากาศดี ไปเดินเล่นที่สวน'), 'generic');
});

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

test('isNumericCell: amounts, meter readings, percents — but not prose', () => {
  for (const yes of ['3,000.00', '21524', '-1.5', '(140.07)', '99%', '400.00 บาท', ' 5 ']) {
    assert.equal(isNumericCell(yes), true, yes);
  }
  for (const no of ['ค่าห้องพัก', 'V309', '52141-53249', '', 'รวม 5 รายการ', '24/6/2569']) {
    assert.equal(isNumericCell(no), false, no);
  }
});

test('computeColumnWidths: proportional to content, sums to the content width', () => {
  const widths = computeColumnWidths(
    [
      ['รายการ / Description', 'จำนวน / Amount'],
      ['ค่าเฟอร์นิเจอร์รายเดือนแบบยาวมาก', '467.29'],
    ],
    2,
  );
  assert.equal(widths.length, 2);
  assert.equal(widths[0]! + widths[1]!, 9072);
  assert.ok(widths[0]! > widths[1]!, 'description column should be wider');
  assert.ok(widths.every((w) => w >= 600));
});

// ---------------------------------------------------------------------------
// Layout output (inspect the raw document.xml inside the zip)
// ---------------------------------------------------------------------------

async function docxXml(buf: Buffer): Promise<string> {
  // Minimal ZIP reader: locate word/document.xml via the central directory is
  // overkill — docx from Packer is stored with zlib deflate; use jszip-free
  // approach via the 'docx' peer 'jszip'? Not available. Instead unzip with
  // node:zlib on the raw local file entry.
  const name = Buffer.from('word/document.xml');
  let i = buf.indexOf(name);
  while (i !== -1) {
    const local = buf.lastIndexOf(Buffer.from('PK\x03\x04', 'latin1'), i);
    if (local !== -1) {
      const method = buf.readUInt16LE(local + 8);
      const compSize = buf.readUInt32LE(local + 18);
      const nameLen = buf.readUInt16LE(local + 26);
      const extraLen = buf.readUInt16LE(local + 28);
      const dataStart = local + 30 + nameLen + extraLen;
      if (i === local + 30) {
        const raw = buf.subarray(dataStart, compSize > 0 ? dataStart + compSize : undefined);
        const { inflateRawSync } = await import('node:zlib');
        return method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8');
      }
    }
    i = buf.indexOf(name, i + 1);
  }
  throw new Error('word/document.xml not found');
}

test('invoice layout: right-aligned amounts, bold total row, teal header, DXA widths', async () => {
  const buf = await buildDocxFromMarkdown([THAI_INVOICE_MD]);
  const xml = await docxXml(buf);
  // Header row: teal fill + white text
  assert.match(xml, /w:fill="0F766E"/);
  assert.match(xml, /w:val="FFFFFF"/);
  // Amounts right-aligned
  assert.match(xml, /<w:jc w:val="right"\/>/);
  // Grand-total row shaded
  assert.match(xml, /w:fill="E2EEEC"/);
  // DXA table width (not the Google-Docs-breaking percentage form)
  assert.match(xml, /<w:tblW w:type="dxa"/);
  assert.doesNotMatch(xml, /w:type="pct"/);
  // A4 + 2.5cm margins
  assert.match(xml, /w:top="1417"/);
  // Content preserved
  assert.ok(xml.includes('ค่าห้องพัก') && xml.includes('5,541.00'));
});

test('ordered lists use real decimal numbering (not bullets)', async () => {
  const buf = await buildDocxFromMarkdown(['1. หนึ่ง\n2. สอง']);
  const xml = await docxXml(buf);
  assert.match(xml, /<w:numPr>/);
});

// ---------------------------------------------------------------------------
// Thai shared components (Buddhist Era dates, label lines, signature lines)
// ---------------------------------------------------------------------------

test('formatThaiBuddhistDate: Arabic and Thai digit forms', () => {
  const d = new Date(2026, 6, 9); // 9 July 2026 CE = 2569 BE
  assert.equal(formatThaiBuddhistDate(d), '9 กรกฎาคม 2569');
  assert.equal(formatThaiBuddhistDate(d, { thaiDigits: true }), '๙ กรกฎาคม ๒๕๖๙');
});

test('toThaiDigits converts only Arabic digits', () => {
  assert.equal(toThaiDigits('ครั้งที่ 5/2569'), 'ครั้งที่ ๕/๒๕๖๙');
  assert.equal(toThaiDigits(120), '๑๒๐');
});

test('isOfficialLabelLine: เรื่อง/เรียน/ที่ labels yes — ที่อยู่ and prose no', () => {
  for (const yes of ['เรื่อง ขออนุมัติจัดซื้อ', 'เรียน อธิบดีกรมตัวอย่าง', 'ที่ ศธ 04001/123', 'สิ่งที่ส่งมาด้วย เอกสาร 1 ชุด', 'ส่วนราชการ กองคลัง']) {
    assert.equal(isOfficialLabelLine(yes), true, yes);
  }
  for (const no of ['ที่อยู่ 123 ถนนสุขุมวิท', 'เรื่องราวของฉัน', 'วันที่สุดท้ายที่ต้องชำระ 1 กรกฎาคม', 'ด้วยจังหวัดได้กำหนดจัดประชุม']) {
    assert.equal(isOfficialLabelLine(no), false, no);
  }
});

test('isSignatureLine: ลงชื่อ/(ชื่อ)/ตำแหน่ง/บรรทัดบทบาท yes — prose no', () => {
  for (const yes of [
    'ลงชื่อ.................................ผู้เช่า',
    '(นายสมชาย ใจดี)',
    '(ลงชื่อ) สมหญิง',
    'ตำแหน่ง ผู้จัดการฝ่ายบุคคล',
    'พยาน',
    'ประกาศ ณ วันที่ 9 กรกฎาคม 2569',
  ]) {
    assert.equal(isSignatureLine(yes), true, yes);
  }
  for (const no of [
    'เรียน ผู้จัดการ',
    'ผู้เช่าตกลงชำระค่าเช่าทุกเดือน',
    'ข้อ 1 ผู้ให้เช่าตกลงให้เช่าห้องพัก',
    'ตำแหน่งที่สมัคร พนักงานขาย',
    'ราคารวม 100 บาท',
  ]) {
    assert.equal(isSignatureLine(no), false, no);
  }
});

// ---------------------------------------------------------------------------
// New document type detection (registry)
// ---------------------------------------------------------------------------

const MEMO_MD = [
  '# บันทึกข้อความ',
  'ส่วนราชการ กองคลัง กรมตัวอย่าง โทร. 0 2123 4567',
  'ที่ กค 0401/123',
  'วันที่ 9 กรกฎาคม 2569',
  'เรื่อง ขออนุมัติจัดซื้อวัสดุสำนักงาน',
  'เรียน อธิบดีกรมตัวอย่าง',
  'ด้วยกองคลังมีความจำเป็นต้องจัดซื้อวัสดุสำนักงานเพื่อใช้ในราชการ',
  'จึงเรียนมาเพื่อโปรดพิจารณาอนุมัติ',
  '(นางสาวสมหญิง ตัวอย่าง)',
  'ตำแหน่ง ผู้อำนวยการกองคลัง',
].join('\n');

const GOV_LETTER_MD = [
  'ที่ ศธ 04001/ว 1234',
  'ศาลากลางจังหวัดเชียงใหม่ ถนนโชตนา',
  'วันที่ 9 กรกฎาคม 2569',
  'เรื่อง ขอเชิญประชุมคณะกรรมการ',
  'เรียน ผู้อำนวยการโรงเรียนตัวอย่างวิทยา',
  'อ้างถึง หนังสือจังหวัดเชียงใหม่ ด่วนที่สุด',
  'สิ่งที่ส่งมาด้วย กำหนดการประชุม 1 ชุด',
  'ด้วยจังหวัดเชียงใหม่ได้กำหนดจัดประชุมคณะกรรมการระดับจังหวัด',
  'จึงเรียนมาเพื่อโปรดเข้าร่วมประชุมตามวันเวลาดังกล่าว',
  'ขอแสดงความนับถือ',
  '(นายทดสอบ ระบบดี)',
].join('\n');

const ANNOUNCEMENT_MD = [
  '# ประกาศโรงเรียนตัวอย่างวิทยา',
  'เรื่อง รับสมัครครูอัตราจ้าง',
  '',
  'ด้วยโรงเรียนตัวอย่างวิทยามีความประสงค์จะรับสมัครบุคคลเพื่อจ้างเป็นครูอัตราจ้าง',
  '',
  'จึงประกาศให้ทราบโดยทั่วกัน',
  '',
  'ประกาศ ณ วันที่ 9 กรกฎาคม พ.ศ. 2569',
  '(นายทดสอบ ประกาศดี)',
].join('\n');

const MINUTES_MD = [
  '# รายงานการประชุมคณะกรรมการบริหาร ครั้งที่ 5/2569',
  'ณ ห้องประชุมใหญ่ อาคารสำนักงาน',
  '',
  'ผู้มาประชุม',
  '1. นายหนึ่ง สองสาม ประธาน',
  '2. นางสี่ ห้าหก กรรมการ',
  '',
  'เริ่มประชุมเวลา 09.30 น.',
  '',
  'ระเบียบวาระที่ 1 เรื่องที่ประธานแจ้งให้ที่ประชุมทราบ',
  'ประธานแจ้งผลการดำเนินงานไตรมาสที่ผ่านมา',
  'มติที่ประชุม รับทราบ',
  '',
  'เลิกประชุมเวลา 12.00 น.',
].join('\n');

const CERTIFICATE_MD = [
  '# หนังสือรับรองการทำงาน',
  'บริษัท ตัวอย่าง จำกัด ขอรับรองว่า นายสมชาย ใจดี เป็นพนักงานของบริษัทจริง',
  'ให้ไว้ ณ วันที่ 9 กรกฎาคม 2569',
  '(นายผู้จัดการ ใหญ่)',
].join('\n');

const POA_MD = [
  '# หนังสือมอบอำนาจ',
  'เขียนที่ บ้านเลขที่ 99 กรุงเทพมหานคร',
  'ข้าพเจ้า นายสมชาย ใจดี ขอมอบอำนาจให้ นางสาวสมศรี มีสุข เป็นผู้ดำเนินการแทน',
  'ลงชื่อ....................ผู้มอบอำนาจ',
  'ลงชื่อ....................ผู้รับมอบอำนาจ',
  'ลงชื่อ....................พยาน',
].join('\n');

const RECEIPT_MD = [
  '# ใบเสร็จรับเงิน',
  'เลขที่ 001/2569',
  'ได้รับเงินจาก นายสมชาย ใจดี',
  '| รายการ | จำนวนเงิน |',
  '|---|---|',
  '| ค่าบริการ | 1,500.00 |',
  '| รวมทั้งสิ้น | 1,500.00 |',
  '',
  'ลงชื่อ..........ผู้รับเงิน',
].join('\n');

const WORK_ORDER_MD = [
  '# ใบสั่งงาน',
  'เลขที่งาน WO-2569-001',
  'ผู้แจ้ง: ฝ่ายขาย',
  'รายละเอียดงาน ซ่อมเครื่องปรับอากาศห้องประชุม',
  'กำหนดเสร็จ 15 กรกฎาคม 2569',
].join('\n');

const JOB_APPLICATION_MD = [
  '# ใบสมัครงาน',
  'ตำแหน่งที่สมัคร พนักงานขาย',
  'ชื่อ-นามสกุล: สมชาย ใจดี',
  'เงินเดือนที่ต้องการ: 18,000 บาท',
  'ประวัติการศึกษา: ปริญญาตรี บริหารธุรกิจ',
].join('\n');

const PERSONAL_LETTER_MD = [
  'กรุงเทพมหานคร',
  '9 กรกฎาคม 2569',
  '',
  'ถึง แม่ที่เคารพ',
  '',
  'ลูกสบายดี ทำงานที่กรุงเทพฯ เรียบร้อยดี อากาศช่วงนี้ฝนตกบ่อย',
  '',
  'ด้วยความเคารพอย่างสูง',
  'สมชาย',
].join('\n');

const REPORT_MD = [
  '# รายงานผลการดำเนินงานประจำปี 2569',
  '## บทที่ 1 บทนำ',
  'รายงานฉบับนี้จัดทำขึ้นเพื่อสรุปผลการดำเนินงานตลอดปีงบประมาณ',
  '## บทที่ 2 ผลการดำเนินงาน',
  'ผลการดำเนินงานเป็นไปตามแผนที่วางไว้ทุกไตรมาส',
  '## บทที่ 3 สรุปและข้อเสนอแนะ',
  'ควรขยายผลโครงการในปีถัดไป',
].join('\n');

const SCHEDULE_MD = [
  '# ตารางเวรประจำเดือนกรกฎาคม 2569',
  '| วัน | เวรเช้า | เวรบ่าย |',
  '|---|---|---|',
  '| จันทร์ | สมชาย | สมหญิง |',
  '| อังคาร | สมศรี | สมปอง |',
].join('\n');

const DETECTION_SAMPLES: Array<[DocumentType, string]> = [
  ['memo', MEMO_MD],
  ['gov_letter', GOV_LETTER_MD],
  ['announcement', ANNOUNCEMENT_MD],
  ['meeting_minutes', MINUTES_MD],
  ['certificate', CERTIFICATE_MD],
  ['power_of_attorney', POA_MD],
  ['receipt', RECEIPT_MD],
  ['work_order', WORK_ORDER_MD],
  ['job_application', JOB_APPLICATION_MD],
  ['personal_letter', PERSONAL_LETTER_MD],
  ['report', REPORT_MD],
  ['schedule', SCHEDULE_MD],
];

for (const [expected, md] of DETECTION_SAMPLES) {
  test(`detectDocumentType: ${expected}`, () => {
    assert.equal(detectDocumentType(md), expected);
  });
}

test('detection priority: ใบเสร็จรับเงิน is receipt, not invoice (both match)', () => {
  assert.equal(detectDocumentType(RECEIPT_MD), 'receipt');
  // …while an ใบแจ้งหนี้ stays an invoice.
  assert.equal(detectDocumentType(THAI_INVOICE_MD), 'invoice');
});

test('detection priority: หนังสือมอบอำนาจ is POA even though contract keywords match', () => {
  assert.equal(detectDocumentType(POA_MD), 'power_of_attorney');
});

test('detection priority: บันทึกข้อความ beats หนังสือราชการ signals in the same doc', () => {
  assert.equal(detectDocumentType(MEMO_MD), 'memo');
});

test('detection: ประกาศ mentioned mid-prose does not become an announcement', () => {
  assert.equal(detectDocumentType('# บันทึกประจำวัน\nวันนี้มีการประกาศผลรางวัลที่โรงเรียน สนุกมาก'), 'generic');
});

test('detection: รายงานการประชุม is minutes, not report', () => {
  assert.equal(detectDocumentType(MINUTES_MD), 'meeting_minutes');
});

test('registry: 17 templates, unique types, Thai display names', () => {
  assert.equal(DOCUMENT_TEMPLATES.length, 17);
  const types = DOCUMENT_TEMPLATES.map((t) => t.type);
  assert.equal(new Set(types).size, types.length);
  for (const t of DOCUMENT_TEMPLATES) {
    assert.ok(t.displayName.length > 0, t.type);
  }
  assert.equal(documentTypeDisplayName('memo'), 'บันทึกข้อความ');
  assert.equal(documentTypeDisplayName('gov_letter'), 'หนังสือราชการ');
});

// ---------------------------------------------------------------------------
// New layout output
// ---------------------------------------------------------------------------

test('official style (memo): งานสารบรรณ margins, 16pt runs, page-number footer from page 2', async () => {
  const buf = await buildDocxFromMarkdown([MEMO_MD, 'หน้า 2 เนื้อหาต่อ']);
  const xml = await docxXml(buf);
  // 3cm top/left, 2cm right, 2.5cm bottom
  assert.match(xml, /w:top="1701"/);
  assert.match(xml, /w:left="1701"/);
  assert.match(xml, /w:right="1134"/);
  // Every body run at 16pt (32 half-points)
  assert.match(xml, /w:sz w:val="32"/);
  // Page numbers: footer present, first page differs
  assert.match(xml, /w:footerReference/);
  assert.match(xml, /<w:titlePg\/>/);
  // Labels styled + kept as their own paragraphs
  assert.ok(xml.includes('เรื่อง') && xml.includes('เรียน'));
  // Title centered, body Thai-justified with the official first-line indent
  assert.match(xml, /w:val="center"/);
  assert.match(xml, /w:val="thaiDistribute"/);
  assert.match(xml, /w:firstLine="1418"/);
  // Signature zone rendered
  assert.ok(xml.includes('(นางสาวสมหญิง ตัวอย่าง)'));
});

test('gov_letter layout: label lines split out of merged paragraphs and bolded', async () => {
  const blocks = parseMarkdownBlocks(GOV_LETTER_MD);
  const labelTexts = blocks.filter((b) => b.kind === 'paragraph').map((b) => (b as { text: string }).text);
  // เรื่อง / เรียน / อ้างถึง / สิ่งที่ส่งมาด้วย each stay a single-line paragraph
  assert.ok(labelTexts.some((t) => t.startsWith('เรื่อง ')));
  assert.ok(labelTexts.some((t) => t.startsWith('เรียน ')));
  assert.ok(labelTexts.some((t) => t.startsWith('อ้างถึง ')));
  assert.ok(labelTexts.some((t) => t.startsWith('สิ่งที่ส่งมาด้วย ')));
  const xml = await docxXml(await buildDocxFromMarkdown([GOV_LETTER_MD]));
  assert.match(xml, /<w:b\/>/);
  assert.ok(xml.includes('ขอแสดงความนับถือ'));
});

test('announcement layout: ประกาศ ณ วันที่ + name line render in the centered signature zone', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([ANNOUNCEMENT_MD]));
  assert.ok(xml.includes('ประกาศ ณ วันที่ 9 กรกฎาคม พ.ศ. 2569'));
  assert.ok(xml.includes('(นายทดสอบ ประกาศดี)'));
  assert.match(xml, /w:val="center"/);
});

test('meeting minutes layout: วาระ/มติ lead phrases are bold', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([MINUTES_MD]));
  assert.ok(xml.includes('ระเบียบวาระที่ 1'));
  assert.ok(xml.includes('มติที่ประชุม'));
  assert.match(xml, /<w:b\/>/);
  // attendee list uses real numbering
  assert.match(xml, /<w:numPr>/);
});

test('receipt layout: rich line-item table + centered ผู้รับเงิน signature', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([RECEIPT_MD]));
  assert.match(xml, /w:fill="0F766E"/); // teal header
  assert.match(xml, /<w:jc w:val="right"\/>/); // amounts right-aligned
  assert.ok(xml.includes('ลงชื่อ..........ผู้รับเงิน'));
  assert.match(xml, /w:val="center"/);
});

test('personal letter layout: place/date and closing right-aligned, body indented', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([PERSONAL_LETTER_MD]));
  assert.match(xml, /w:val="right"/);
  assert.match(xml, /w:firstLine="1418"/);
  assert.ok(xml.includes('ด้วยความเคารพอย่างสูง'));
});

test('schedule layout: centered title over a real Word table', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([SCHEDULE_MD]));
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /w:val="center"/);
  assert.ok(xml.includes('เวรเช้า'));
});

test('job application layout: bold field labels', async () => {
  const xml = await docxXml(await buildDocxFromMarkdown([JOB_APPLICATION_MD]));
  assert.ok(xml.includes('ชื่อ-นามสกุล:'));
  assert.match(xml, /<w:b\/>/);
});

test('graceful degradation: incomplete official docs still produce valid .docx', async () => {
  for (const [pages, type] of [
    [['# บันทึกข้อความ'], 'memo'],
    [[''], 'gov_letter'],
    [['ข้อความเดี่ยว'], 'power_of_attorney'],
  ] as Array<[string[], DocumentType]>) {
    const buf = await buildDocxFromMarkdown(pages, type);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', type);
  }
});

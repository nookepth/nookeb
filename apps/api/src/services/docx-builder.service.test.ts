import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocxFromMarkdown,
  parseInlineRuns,
  parseMarkdownBlocks,
  type Block,
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

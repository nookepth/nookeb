/**
 * 01_utils.gs — ตัวช่วยกลาง: วันที่, สไตล์, แถบนำทาง, id
 */

/** now ในเขตเวลาไทย (Date object ปกติ — Apps Script project ตั้ง TZ เป็น Asia/Bangkok อยู่แล้ว) */
function now_() { return new Date(); }

/** "DD/MM/YYYY HH:mm" (รูปแบบเดียวกับที่ sheetsWorker เขียน) */
function formatWhen_(d) {
  if (!d) return '';
  return Utilities.formatDate(d, CFG.TZ, 'dd/MM/yyyy HH:mm');
}

/** "DD/MM HH:mm" สั้น ๆ สำหรับบรรทัด log */
function formatShort_(d) {
  return Utilities.formatDate(d, CFG.TZ, 'dd/MM HH:mm');
}

/** วันแบบ yyyy-MM-dd ใช้ dedupe รายวัน */
function dayKey_(d) {
  return Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
}

/**
 * แปลงค่าเซลล์ deadline → Date หรือ null
 * รับได้ทั้ง Date จริง (แถวที่สร้างจากฟอร์ม) และข้อความ "DD/MM/YYYY[ HH:mm]" จาก sync
 */
function parseWhen_(v) {
  if (v instanceof Date) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  var m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]),
                   m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function newLocalId_() {
  return CFG.LOCAL_ID_PREFIX + Utilities.getUuid().slice(0, 8);
}

/** ------- สไตล์ ------- */

/** หัวตาราง: พื้นน้ำเงินเข้ม ตัวหนังสือขาว หนา สูง 35px */
function styleHeader_(range) {
  range.setBackground(CFG.COLORS.PRIMARY)
    .setFontColor(CFG.COLORS.HEADER_TEXT)
    .setFontFamily(CFG.FONT)
    .setFontWeight('bold')
    .setFontSize(11)
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center')
    .setWrap(true);
  range.getSheet().setRowHeight(range.getRow(), 35);
}

/** หัวข้อ section (แถบสีอ่อน ตัวเข้ม) */
function styleSection_(range, title) {
  range.merge()
    .setValue(title)
    .setBackground(CFG.COLORS.NEUTRAL)
    .setFontColor(CFG.COLORS.PRIMARY)
    .setFontFamily(CFG.FONT)
    .setFontWeight('bold')
    .setFontSize(13)
    .setVerticalAlignment('middle');
  range.getSheet().setRowHeight(range.getRow(), 32);
}

/** พื้นฐานทั้งชีต: ฟอนต์ Sarabun, สีตัวอักษร, ตัดเส้น grid ที่ไม่จำเป็น */
function styleSheetBase_(sh, hideGridlines) {
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns())
    .setFontFamily(CFG.FONT).setFontColor(CFG.COLORS.TEXT).setFontSize(10)
    .setVerticalAlignment('middle');
  if (hideGridlines) sh.setHiddenGridlines(true);
}

/** เส้นขอบบางสีเทาด้านใน */
function innerBorders_(range) {
  range.setBorder(null, null, null, null, true, true, CFG.COLORS.BORDER,
    SpreadsheetApp.BorderStyle.SOLID);
}

/**
 * แถบนำทาง row 1 ของทุกชีต — ลิงก์ #gid ไปทุกชีตหลัก
 * เรียกหลังจากสร้างชีตครบแล้วเท่านั้น (ต้องรู้ gid)
 */
function buildNavBar_(sh) {
  var ss = ss_();
  sh.setRowHeight(1, 34);
  var n = CFG.NAV.length;
  var band = sh.getRange(1, 1, 1, Math.max(n, sh.getMaxColumns() >= n ? n : n));
  band.setBackground(CFG.COLORS.PRIMARY);
  for (var i = 0; i < n; i++) {
    var name = CFG.NAV[i];
    var target = ss.getSheetByName(name);
    var cell = sh.getRange(1, i + 1);
    if (!target) { cell.setValue(name); continue; }
    var label = (name === CFG.SHEETS.MASTER) ? '📝 งานของฉัน' : name;
    var isSelf = (target.getName() === sh.getName());
    var rt = SpreadsheetApp.newRichTextValue()
      .setText(label)
      .setLinkUrl(isSelf ? null : '#gid=' + target.getSheetId())
      .setTextStyle(SpreadsheetApp.newTextStyle()
        .setForegroundColor(isSelf ? '#9FC1E8' : CFG.COLORS.HEADER_TEXT)
        .setBold(true).setUnderline(false).setFontFamily(CFG.FONT).setFontSize(9)
        .build())
      .build();
    cell.setRichTextValue(rt).setHorizontalAlignment('center').setVerticalAlignment('middle');
  }
  // เติมสีปลายแถบให้เต็มความกว้างที่ใช้จริง
  if (sh.getMaxColumns() > n) {
    sh.getRange(1, n + 1, 1, sh.getMaxColumns() - n).setBackground(CFG.COLORS.PRIMARY);
  }
}

/** สร้าง/ล้างชีต: คืน sheet เปล่าชื่อนั้น (คงตำแหน่งเดิมถ้ามีอยู่แล้ว) */
function resetSheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (sh) {
    sh.getCharts().forEach(function (c) { sh.removeChart(c); });
    sh.clear();
    sh.setConditionalFormatRules([]);
    sh.getDataRange().clearDataValidations();
  } else {
    sh = ss.insertSheet(name);
  }
  return sh;
}

/** ตัดข้อความยาว */
function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** escape สำหรับใส่ในสูตรที่เป็น string literal */
function q_(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

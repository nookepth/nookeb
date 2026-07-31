/**
 * 06_form.gs — 📋 สั่งงาน (ฟอร์มเพิ่มงานในชีต)
 *
 * ⚠️ ข้อจำกัดที่ต้องรู้: งานที่สร้างจากฟอร์มนี้อยู่ "ในสเปรดชีตเท่านั้น"
 * ไม่ได้ถูกส่งเข้า LINE/ระบบหนูเก็บ (sync เป็นทางเดียว: หนูเก็บ → ชีต)
 * งานฟอร์มได้รหัส LOCAL-xxxx ซึ่ง sync ไม่รู้จัก จึงไม่มีวันถูกเขียนทับ
 */

var FORM = {
  TITLE: 'C5', DESC: 'C6', TYPE: 'C7', DATE: 'C8', TIME: 'D8',
  ASSIGNEE: 'C9', URGENCY: 'C10',
  URG_BOXES: ['D10', 'E10', 'F10', 'G10'],
  LINK: 'C12', NOTE: 'C13',
  SUBMIT: 'B15', MSG: 'C16',
};

function buildFormSheet_() {
  var sh = resetSheet_(CFG.SHEETS.FORM);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(1);

  sh.getRange('B2:G2').merge().setValue('📋 สั่งงานใหม่')
    .setFontSize(16).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.getRange('B3:G3').merge().setValue(
    'งานจากฟอร์มนี้บันทึกลงตาราง "งานของฉัน" ในชีตเท่านั้น (ไม่ส่งแจ้งเตือนเข้า LINE) · ช่องที่มี * จำเป็นต้องกรอก')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  var labels = [
    [5, 'ชื่องาน *'], [6, 'รายละเอียด'], [7, 'ประเภท'], [8, 'วันกำหนดส่ง'],
    [9, 'ผู้รับผิดชอบ *'], [10, 'ความเร่งด่วน'], [12, '🔗 ลิงก์/ไฟล์แนบ'], [13, '📝 หมายเหตุ'],
  ];
  labels.forEach(function (l) {
    sh.getRange(l[0], 2).setValue(l[1]).setFontWeight('bold').setHorizontalAlignment('right')
      .setFontColor(CFG.COLORS.PRIMARY);
    sh.setRowHeight(l[0], 30);
  });

  // ช่องกรอก
  var inputBg = '#FFFFFF';
  function inputCell(a1, wide) {
    var rng = wide ? sh.getRange(a1 + ':' + 'E' + a1.slice(1)).merge() : sh.getRange(a1);
    rng.setBackground(inputBg)
      .setBorder(true, true, true, true, false, false, CFG.COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    return rng;
  }
  inputCell(FORM.TITLE, true);
  inputCell(FORM.DESC, true).setWrap(true);
  sh.setRowHeight(6, 44);
  inputCell(FORM.TYPE, false).setValue(CFG.TYPES[0]).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('TypeList'), true).setAllowInvalid(false).build());
  inputCell(FORM.DATE, false).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('ดับเบิลคลิกเพื่อเลือกวันที่').build())
    .setNumberFormat('dd/mm/yyyy');
  sh.getRange(FORM.TIME).setValue('18:00').setBackground(inputBg)
    .setBorder(true, true, true, true, false, false, CFG.COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID)
    .setHorizontalAlignment('center').setNote('เวลา (HH:mm) — ไม่กรอก = 18:00');
  sh.getRange('E8').setValue('← วันที่ | เวลา').setFontSize(9).setFontColor(CFG.COLORS.MUTED);
  inputCell(FORM.ASSIGNEE, false).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('People'), true).setAllowInvalid(true).build())
    .setNote('เลือกจากรายชื่อ หรือพิมพ์หลายคนคั่นด้วย , ได้');

  // ปุ่มความเร่งด่วน: checkbox 4 ช่องสีตามระดับ — ติ๊กแล้วสคริปต์เลือกให้และติ๊กออกเอง
  sh.getRange(FORM.URGENCY).setValue(CFG.DEFAULT_URGENCY).setFontWeight('bold')
    .setHorizontalAlignment('center').setBackground(CFG.COLORS.OK_BG)
    .setBorder(true, true, true, true, false, false, CFG.COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  var urgBg = [CFG.COLORS.URGENT_BG, CFG.COLORS.SOON_BG, CFG.COLORS.OK_BG, CFG.COLORS.RELAX_BG];
  FORM.URG_BOXES.forEach(function (a1, i) {
    sh.getRange(a1).insertCheckboxes().setBackground(urgBg[i]).setHorizontalAlignment('center')
      .setNote(CFG.URGENCIES[i]);
  });
  sh.getRange(11, 4, 1, 4).setValues([['ด่วนมาก', 'ด่วน', 'ปกติ', 'ไม่รีบ']])
    .setFontSize(8).setHorizontalAlignment('center').setFontColor(CFG.COLORS.MUTED);

  inputCell(FORM.LINK, true).setNote('วางลิงก์ไฟล์/เอกสารที่เกี่ยวข้อง');
  inputCell(FORM.NOTE, true);

  // ปุ่มส่ง
  sh.getRange(FORM.SUBMIT).insertCheckboxes().setHorizontalAlignment('center')
    .setBackground(CFG.COLORS.SUCCESS).setNote('ติ๊กเพื่อบันทึกงาน');
  sh.getRange('C15:E15').merge().setValue('✅ ติ๊กช่องซ้ายเพื่อ "ส่งงาน" — ระบบจะบันทึกลงตารางให้ทันที')
    .setFontWeight('bold').setFontColor(CFG.COLORS.SUCCESS);
  sh.getRange(FORM.MSG + ':E16').merge().setFontSize(10);

  [30, 120, 170, 80, 80, 80, 80].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/** onEdit: ติ๊กปุ่มความเร่งด่วน → เซ็ตค่า + ติ๊กออก */
function handleUrgencyButton_(sh, a1) {
  var i = FORM.URG_BOXES.indexOf(a1);
  if (i < 0) return false;
  if (sh.getRange(a1).getValue() === true) {
    var urgBg = [CFG.COLORS.URGENT_BG, CFG.COLORS.SOON_BG, CFG.COLORS.OK_BG, CFG.COLORS.RELAX_BG];
    sh.getRange(FORM.URGENCY).setValue(CFG.URGENCIES[i]).setBackground(urgBg[i]);
    sh.getRange(a1).setValue(false);
  }
  return true;
}

/** onEdit: ติ๊กปุ่มส่ง → บันทึกงานลง master */
function submitFormTask_() {
  var sh = sheet_(CFG.SHEETS.FORM);
  sh.getRange(FORM.SUBMIT).setValue(false);

  var title = String(sh.getRange(FORM.TITLE).getValue()).trim();
  var assignee = String(sh.getRange(FORM.ASSIGNEE).getValue()).trim();
  var setMsg = function (text, color) {
    sh.getRange(FORM.MSG).setValue(text).setFontColor(color).setFontWeight('bold');
  };
  if (!title) { setMsg('⚠️ กรอกชื่องานก่อนน้า', CFG.COLORS.DANGER); return; }
  if (!assignee) { setMsg('⚠️ เลือกผู้รับผิดชอบก่อนน้า', CFG.COLORS.DANGER); return; }

  // ประกอบกำหนดส่ง: วันที่ + เวลา (ว่าง = ไม่มีกำหนด)
  var deadlineStr = '';
  var dateV = sh.getRange(FORM.DATE).getValue();
  if (dateV instanceof Date) {
    var timeV = String(sh.getRange(FORM.TIME).getValue() || '18:00').trim();
    var tm = /^(\d{1,2}):(\d{2})$/.exec(timeV);
    var d = new Date(dateV.getFullYear(), dateV.getMonth(), dateV.getDate(),
                     tm ? Number(tm[1]) : 18, tm ? Number(tm[2]) : 0, 0);
    deadlineStr = formatWhen_(d);
  }

  var master = sheet_(CFG.SHEETS.MASTER);
  var lastRow = master.getLastRow();
  var C = CFG.MASTER.COL;
  var nowD = now_();
  var row = new Array(CFG.MASTER.LAST_COL).fill('');
  row[C.ORDER - 1] = lastRow;              // ตำแหน่งใต้ header (sync ใช้ convention เดียวกัน)
  row[C.TITLE - 1] = title;
  row[C.DESC - 1] = String(sh.getRange(FORM.DESC).getValue()).trim();
  row[C.TYPE - 1] = String(sh.getRange(FORM.TYPE).getValue()) || CFG.TYPES[0];
  row[C.DEADLINE - 1] = deadlineStr;
  row[C.CREATOR - 1] = (Session.getActiveUser().getEmail() || 'ฟอร์มในชีต');
  row[C.ASSIGNEE - 1] = assignee;
  row[C.STATUS - 1] = 'รอดำเนินการ';
  row[C.UPDATED - 1] = formatWhen_(nowD);
  row[C.TASK_ID - 1] = newLocalId_();
  row[C.URGENCY - 1] = String(sh.getRange(FORM.URGENCY).getValue()) || CFG.DEFAULT_URGENCY;
  row[C.REMIND - 1] = 0;
  row[C.LINK - 1] = String(sh.getRange(FORM.LINK).getValue()).trim();
  row[C.NOTE - 1] = String(sh.getRange(FORM.NOTE).getValue()).trim();
  row[C.LOG - 1] = formatShort_(nowD) + '  📋 สร้างงานจากฟอร์ม';

  master.getRange(lastRow + 1, 1, 1, CFG.MASTER.LAST_COL).setValues([row]);

  // ล้างฟอร์ม + ยืนยัน
  [FORM.TITLE, FORM.DESC, FORM.DATE, FORM.LINK, FORM.NOTE].forEach(function (a1) {
    var rng = sh.getRange(a1);
    (rng.isPartOfMerge() ? rng.getMergedRanges()[0] : rng).clearContent();
  });
  setMsg('✅ บันทึก "' + truncate_(title, 40) + '" ให้ ' + assignee + ' เรียบร้อยน้า (' + formatShort_(nowD) + ')',
    CFG.COLORS.SUCCESS);
  SpreadsheetApp.getActive().toast('บันทึกงานใหม่แล้วน้า ✓', '📋', 4);
  runChangeEngine(); // อัปเดต snapshot ทันทีให้ทุก view เห็น
}

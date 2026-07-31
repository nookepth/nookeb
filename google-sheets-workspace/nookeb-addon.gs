/**
 * หนูเก็บ — สคริปต์เสริม (ติดตั้งครั้งเดียว, ไม่บังคับ)
 * =====================================================
 *
 * ชีตทั้งหมดถูกสร้างและอัปเกรดจากฝั่งเซิร์ฟเวอร์ (sheets-workspace.service.ts)
 * ด้วย "สูตร" ล้วน ๆ — ทุกหน้ารายงานทำงานได้เองโดยไม่ต้องติดตั้งอะไรเลย
 *
 * ไฟล์นี้เพิ่มเฉพาะ 3 อย่างที่สูตรทำไม่ได้:
 *   1. ปุ่ม "ส่งงาน" ในแท็บ 📋 สั่งงาน            → submitForm()
 *   2. ปุ่มเลือกความเร่งด่วน (คลิกแล้วไฮไลต์)      → onEdit()
 *   3. ตรวจงานเกินกำหนดทุกเช้า 07:00              → checkOverdue()
 *
 * ⚠️ ห้ามติดตั้งไฟล์ชุดเก่า (00_config.gs … 09_weekly.gs) พร้อมกับไฟล์นี้
 *    ชุดนั้นสร้างแท็บเองซึ่งจะชนกับแท็บที่เซิร์ฟเวอร์สร้าง — ดู README.md
 *
 * วิธีติดตั้ง: ส่วนขยาย → Apps Script → วางไฟล์นี้ → บันทึก → รัน installTriggers()
 */

// =====================================================================
// ค่าคงที่ — ต้องตรงกับ sheets-workspace.service.ts เป๊ะ ๆ
// =====================================================================

var MASTER = 'งานของฉัน';
var FORM_TAB = '📋 สั่งงาน';
var DASH_TAB = '📊 ภาพรวม';

/**
 * สัญญาคอลัมน์ของแท็บ งานของฉัน (1-based)
 *
 * A–J  = ระบบ sync เป็นเจ้าของ เขียนทับทุกครั้งที่งานเปลี่ยน
 * K–R  = workspace   (K ความเร่งด่วน และ N หมายเหตุ เป็นของผู้ใช้)
 * S    = ว่าง — สคริปต์นี้ใช้เก็บผลตรวจเกินกำหนด
 */
var COL = {
  SEQ: 1,        // A ลำดับ
  TITLE: 2,      // B ชื่องาน
  DETAIL: 3,     // C รายละเอียด
  TYPE: 4,       // D ประเภท
  DEADLINE: 5,   // E วันกำหนดส่ง (ข้อความ DD/MM/YYYY HH:mm)
  FROM: 6,       // F ผู้สั่ง
  ASSIGNEE: 7,   // G ผู้รับผิดชอบ
  STATUS: 8,     // H สถานะ
  UPDATED: 9,    // I อัปเดตล่าสุด
  TASK_ID: 10,   // J รหัสงาน  ← กุญแจของ sync ห้ามแตะ
  URGENCY: 11,   // K ความเร่งด่วน (ของผู้ใช้)
  PROGRESS: 12,  // L ความคืบหน้า (worker เขียน — ห้ามเขียนทับ)
  LINKS: 13,     // M ลิงก์      (worker เขียน)
  NOTE: 14,      // N หมายเหตุ   (ของผู้ใช้)
  LOG: 15,       // O ประวัติสถานะ (worker เขียน)
  OVERDUE: 19,   // S เตือนเกินกำหนด ← คอลัมน์ของสคริปต์นี้ (ดูหมายเหตุด้านล่าง)
};

/**
 * ทำไมตัวนับเตือนถึงอยู่คอลัมน์ S ไม่ใช่ L
 *
 * L คือ 📊 ความคืบหน้า ซึ่ง worker เขียนใหม่ทุกครั้งที่ sync — เขียนตัวนับลงไป
 * จะโดนทับทันทีในรอบถัดไป และยังทำให้แถบความคืบหน้าเพี้ยนด้วย
 * S อยู่นอกช่วง A–R ทั้งของ sync และของ workspace จึงปลอดภัยถาวร
 */

var STATUS_DONE = 'เสร็จแล้ว';
var STATUS_CLOSED = ['เสร็จแล้ว', 'ยกเลิก', 'ลบแล้ว'];

var URGENCIES = ['🔴 ด่วนมาก', '🟠 ด่วน', '🟡 ปกติ', '🟢 ไม่รีบ'];
var DEFAULT_URGENCY = '🟡 ปกติ';

/** เซลล์ในแท็บ 📋 สั่งงาน (รวมแถบเมนูแถว 1 แล้ว) */
var FORM = {
  TITLE: 'C5',
  DETAIL: 'C6',
  TYPE: 'C7',
  ASSIGNEE: 'C8',
  DUE: 'C9',
  LINKS: 'C10',
  NOTE: 'C11',
  URGENCY_BUTTONS: 'C12:F12',
  URGENCY_VALUE: 'C13',
  COMMAND: 'A17',
  SUBMIT: 'C19',
};

var TZ = 'Asia/Bangkok';

// =====================================================================
// เมนู + ทริกเกอร์
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🐭 หนูเก็บ')
    .addItem('📤 ส่งงานจากฟอร์ม', 'submitForm')
    .addItem('🔄 รีเฟรชภาพรวม', 'refreshDashboard')
    .addItem('⏰ ตรวจงานเกินกำหนดเดี๋ยวนี้', 'checkOverdue')
    .addSeparator()
    .addItem('⚙️ ติดตั้ง/ต่ออายุทริกเกอร์', 'installTriggers')
    .addToUi();
}

/**
 * ติดตั้งทริกเกอร์แบบ idempotent — ลบของเดิมที่ชื่อซ้ำก่อนเสมอ
 * รันซ้ำกี่รอบก็ได้ จะไม่เกิดทริกเกอร์ซ้อน (สาเหตุคลาสสิกของการเตือนซ้ำ)
 */
function installTriggers() {
  var ss = SpreadsheetApp.getActive();
  var wanted = ['checkOverdue', 'onEdit'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (wanted.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('checkOverdue').timeBased().atHour(7).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('onEdit').forSpreadsheet(ss).onEdit().create();

  SpreadsheetApp.getUi().alert('ติดตั้งเรียบร้อยแล้วน้า ✅\n\n· ตรวจงานเกินกำหนดทุกวัน 07:00\n· ปุ่มความเร่งด่วนในแท็บ 📋 สั่งงาน ใช้ได้แล้ว');
}

// =====================================================================
// 1. แปลงวันที่ไทย
// =====================================================================

/**
 * "20/12/2026 01:00" (หรือ 20/12/2569 แบบ พ.ศ.) → Date ที่ตัดเวลาออกแล้ว
 *
 * รับ Date จริงมาก็ได้ เพราะคอลัมน์ E เป็นข้อความ แต่ P/Q/R เป็น date จริง
 * ปีเกิน 2500 ถือเป็น พ.ศ. แล้วลบ 543 — ปีคริสต์ศักราชจริงไม่มีทางเกิน 2500
 * ในบริบทนี้ จึงแยกได้ปลอดภัย
 */
function parseThaiDate(dateStr) {
  if (!dateStr && dateStr !== 0) return null;

  if (Object.prototype.toString.call(dateStr) === '[object Date]') {
    if (isNaN(dateStr.getTime())) return null;
    return new Date(dateStr.getFullYear(), dateStr.getMonth(), dateStr.getDate());
  }

  var str = String(dateStr).trim();
  var match = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;

  var d = parseInt(match[1], 10);
  var m = parseInt(match[2], 10);
  var y = parseInt(match[3], 10);
  if (y > 2500) y -= 543;

  var out = new Date(y, m - 1, d);
  // ปฏิเสธวันที่ล้น เช่น 31/02 ที่ JS จะเลื่อนเป็น 03/03 ให้เงียบ ๆ
  if (out.getDate() !== d || out.getMonth() !== m - 1) return null;
  return out;
}

function startOfToday_() {
  var now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// =====================================================================
// 2. ปุ่มความเร่งด่วน (onEdit)
// =====================================================================

/**
 * คลิกปุ่มความเร่งด่วน → ไฮไลต์ปุ่มที่เลือก, คืนสีปุ่มอื่น, เก็บค่าลงเซลล์ C13
 *
 * onEdit ยิงเฉพาะตอน "คน" แก้ชีต — การเขียนผ่าน Sheets API (ตัว sync เอง)
 * ไม่ยิง onEdit จึงไม่มีทางวนลูปกับ worker
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== FORM_TAB) return;

  var buttons = sheet.getRange(FORM.URGENCY_BUTTONS);
  var row = e.range.getRow();
  var col = e.range.getColumn();
  if (row !== buttons.getRow()) return;
  if (col < buttons.getColumn() || col >= buttons.getColumn() + buttons.getNumColumns()) return;

  var index = col - buttons.getColumn();
  var chosen = URGENCIES[index];
  if (!chosen) return;

  // ผู้ใช้ "คลิก" ปุ่มโดยพิมพ์อะไรก็ได้ลงไป — คืนข้อความเดิมทันทีเพื่อให้
  // ปุ่มยังอ่านออก แล้วค่อยไฮไลต์
  sheet.getRange(buttons.getRow(), col).setValue(chosen);
  sheet.getRange(FORM.URGENCY_VALUE).setValue(chosen);
  highlightUrgency_(sheet, index);
}

function highlightUrgency_(sheet, activeIndex) {
  var buttons = sheet.getRange(FORM.URGENCY_BUTTONS);
  var fills = ['#FFEBEE', '#FFF3E0', '#FFFDE7', '#F1F8E9'];
  for (var i = 0; i < buttons.getNumColumns(); i++) {
    var cell = sheet.getRange(buttons.getRow(), buttons.getColumn() + i);
    cell.setBackground(i === activeIndex ? fills[i] : '#FFFFFF');
    cell.setFontWeight(i === activeIndex ? 'bold' : 'normal');
  }
}

// =====================================================================
// 3. ส่งงานจากฟอร์ม
// =====================================================================

/**
 * เพิ่มงานจากฟอร์มลงแท็บ งานของฉัน
 *
 * ⚠️ อ่านให้ครบก่อนใช้ — sync เป็น "ทางเดียว" (หนูเก็บ → ชีต)
 * แถวที่สร้างจากฟอร์มนี้เป็น "งานเฉพาะในชีต" เท่านั้น:
 *   · ได้รหัส LOCAL-… เพื่อให้ทุกหน้ารายงานมองเห็น (ตัวกรองใช้ J<>"")
 *   · sync หาแถวด้วย UUID จริง จึงไม่มีวันเขียนทับหรือลบแถวนี้
 *   · แต่ระบบหนูเก็บใน LINE **ไม่รู้จักงานนี้** ไม่มีการเตือน ไม่มีปุ่มรับงาน
 *
 * ถ้าอยากได้งานจริงที่เตือนได้ ให้ใช้คำสั่งที่ฟอร์มสร้างไว้ให้ในเซลล์ A17
 * คัดลอกไปวางในแชท LINE แทน — เส้นทางนั้นสร้างงานผ่านระบบจริง
 */
function submitForm() {
  var ss = SpreadsheetApp.getActive();
  var form = ss.getSheetByName(FORM_TAB);
  if (!form) throw new Error('ไม่พบแท็บ ' + FORM_TAB);

  var title = String(form.getRange(FORM.TITLE).getValue()).trim();
  var assignee = String(form.getRange(FORM.ASSIGNEE).getValue()).trim();
  if (!title || !assignee) {
    SpreadsheetApp.getUi().alert('กรอก "ชื่องาน" และ "ผู้รับผิดชอบ" ก่อนน้า');
    return;
  }

  appendToMaster({
    title: title,
    detail: String(form.getRange(FORM.DETAIL).getValue()).trim(),
    type: String(form.getRange(FORM.TYPE).getValue()).trim() || 'งานเดียว',
    assignee: assignee,
    due: form.getRange(FORM.DUE).getValue(),
    links: String(form.getRange(FORM.LINKS).getValue()).trim(),
    note: String(form.getRange(FORM.NOTE).getValue()).trim(),
    urgency: String(form.getRange(FORM.URGENCY_VALUE).getValue()).trim() || DEFAULT_URGENCY,
  });

  clearForm_(form);
  SpreadsheetApp.getUi().alert(
    '✅ เพิ่มลงชีตแล้วน้า\n\n' +
    'งานนี้อยู่ในชีตอย่างเดียว (รหัส LOCAL-…)\n' +
    'ถ้าอยากให้หนูเตือนใน LINE ด้วย ให้คัดลอกคำสั่งในช่อง A17 ไปวางในแชทน้า'
  );
}

/**
 * เขียนแถวใหม่ต่อท้ายตาราง เริ่มที่คอลัมน์ B ตามที่ตกลงไว้ —
 * A (ลำดับ) เติมทีหลังจากเลขแถวจริง เพื่อไม่ให้ชนกับเลขที่ sync ใช้
 */
function appendToMaster(task) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(MASTER);
  if (!sheet) throw new Error('ไม่พบแท็บ ' + MASTER);

  var row = nextEmptyRow_(sheet);
  var now = new Date();
  var stamp = Utilities.formatDate(now, TZ, 'dd/MM/yyyy HH:mm');
  var due = parseThaiDate(task.due);

  // B–J ในการเขียนครั้งเดียว (A เติมแยก เพราะเป็นเลขลำดับของแถวนั้น)
  sheet.getRange(row, COL.TITLE, 1, COL.TASK_ID - COL.TITLE + 1).setValues([[
    task.title,
    task.detail,
    task.type,
    due ? Utilities.formatDate(due, TZ, 'dd/MM/yyyy') + ' 18:00' : '',
    'ฟอร์มในชีต',
    task.assignee,
    'รอดำเนินการ',
    stamp,
    'LOCAL-' + Utilities.getUuid().slice(0, 8),
  ]]);
  sheet.getRange(row, COL.SEQ).setValue(row - 1);

  sheet.getRange(row, COL.URGENCY).setValue(task.urgency);
  if (task.links) sheet.getRange(row, COL.LINKS).setValue(task.links);
  if (task.note) sheet.getRange(row, COL.NOTE).setValue(task.note);
  sheet.getRange(row, COL.LOG).setValue(
    Utilities.formatDate(now, TZ, 'dd/MM HH:mm') + '  เริ่มติดตาม: รอดำเนินการ'
  );

  return row;
}

/**
 * แถวว่างถัดไป วัดจากคอลัมน์ B ไม่ใช่ getLastRow()
 *
 * getLastRow() นับคอลัมน์ที่มีสูตร spill อยู่ด้วย และคอลัมน์ K–R มีการจัดรูปแบบ
 * ลงไปถึงแถว 1000 — ใช้ B ซึ่งมีค่าเฉพาะแถวที่เป็นงานจริงจึงแม่นกว่า
 */
function nextEmptyRow_(sheet) {
  var values = sheet.getRange(2, COL.TITLE, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() !== '') return i + 3; // +2 ชดเชย header, +1 แถวถัดไป
  }
  return 2;
}

function clearForm_(form) {
  [FORM.TITLE, FORM.DETAIL, FORM.TYPE, FORM.ASSIGNEE, FORM.DUE, FORM.LINKS, FORM.NOTE]
    .forEach(function (a1) { form.getRange(a1).clearContent(); });
  form.getRange(FORM.URGENCY_VALUE).setValue(DEFAULT_URGENCY);
  highlightUrgency_(form, 2); // กลับไปที่ 🟡 ปกติ
}

// =====================================================================
// 4. ตรวจงานเกินกำหนดทุกเช้า
// =====================================================================

/**
 * สแกนทั้งตาราง เทียบกำหนดส่งกับวันนี้ แล้วบันทึกผลลงคอลัมน์ S
 *
 * เขียนทีเดียวจบด้วย setValues แทนการ setValue ทีละแถว — ชีตที่มีงานหลักร้อย
 * แถวจะช้ามากถ้ายิงทีละเซลล์ และ Apps Script มีเพดานเวลา 6 นาที
 */
function checkOverdue() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(MASTER);
  if (!sheet) return;

  var lastRow = nextEmptyRow_(sheet) - 1;
  if (lastRow < 2) return;

  var rows = lastRow - 1;
  var deadlines = sheet.getRange(2, COL.DEADLINE, rows, 1).getValues();
  var statuses = sheet.getRange(2, COL.STATUS, rows, 1).getValues();
  var current = sheet.getRange(2, COL.OVERDUE, rows, 1).getValues();

  var today = startOfToday_();
  var stamp = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');
  var out = [];
  var flagged = 0;

  for (var i = 0; i < rows; i++) {
    var status = String(statuses[i][0]).trim();
    var due = parseThaiDate(deadlines[i][0]);
    var isOverdue = due !== null && due < today && STATUS_CLOSED.indexOf(status) === -1;

    if (!isOverdue) {
      // งานที่เสร็จหรือยังไม่ถึงกำหนด — ล้างธงเดิมทิ้ง เพื่อไม่ให้ค้างหลอกตา
      out.push(['']);
      continue;
    }

    var previous = String(current[i][0]);
    var seen = previous.match(/^(\d+)/);
    var count = (seen ? parseInt(seen[1], 10) : 0) + 1;
    out.push([count + ' ครั้ง · ล่าสุด ' + stamp]);
    flagged++;
  }

  sheet.getRange(2, COL.OVERDUE, rows, 1).setValues(out);
  sheet.getRange(1, COL.OVERDUE).setValue('⏰ เตือนเกินกำหนด');
  return flagged;
}

// =====================================================================
// 5. รีเฟรชภาพรวม
// =====================================================================

/**
 * บังคับให้สูตรที่ขึ้นกับ NOW() คำนวณใหม่
 *
 * Google Sheets คิดสูตร volatile ใหม่เองอยู่แล้ว แต่จะช้าเป็นนาที เมนูนี้มีไว้
 * ให้กดแล้วเห็นผลทันทีตอนอยากดูตัวเลขล่าสุด — แตะเซลล์ว่างนอกพื้นที่ใช้งาน
 * เพื่อ dirty ทั้งกราฟการคำนวณ แล้วลบทิ้ง
 */
function refreshDashboard() {
  var ss = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(DASH_TAB);
  if (!dash) return;

  var poke = dash.getRange(dash.getMaxRows(), dash.getMaxColumns());
  poke.setValue(new Date().getTime());
  SpreadsheetApp.flush();
  poke.clearContent();
  SpreadsheetApp.flush();
}

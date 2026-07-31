/**
 * 02_setup.gs — ตัวติดตั้งหลัก
 *
 * รันครั้งเดียว: เมนู 🐭 หนูเก็บ → "🛠️ ติดตั้ง/ซ่อมระบบทั้งหมด"
 * ปลอดภัยต่อการรันซ้ำ (idempotent) — สร้างใหม่เฉพาะชีตของระบบ ไม่แตะข้อมูล A–J
 * ของแท็บ "งานของฉัน" ที่ sync ของหนูเก็บเป็นเจ้าของ
 */

function setupWorkspace() {
  var ss = ss_();
  ss.setSpreadsheetLocale(CFG.LOCALE);
  ss.setSpreadsheetTimeZone(CFG.TZ);

  if (!sheet_(CFG.SHEETS.MASTER)) {
    throw new Error('ไม่พบแท็บ "' + CFG.SHEETS.MASTER + '" — เปิดสคริปต์นี้ในสเปรดชีตที่หนูเก็บ sync ให้ก่อนน้า');
  }

  buildConfigSheet_();
  enhanceMasterSheet_();
  buildSnapshotSheet_();
  buildCalcSheet_();

  buildDashboard_();
  buildPriorityView_();
  buildStatusTracker_();
  buildTeamReport_();
  buildCalendarSheet_();
  buildAnalyticsSheet_();
  buildFormSheet_();
  buildWeeklySheet_();

  // แถบนำทาง (ต้องมาหลังทุกชีตถูกสร้าง — ใช้ gid)
  [CFG.SHEETS.DASH, CFG.SHEETS.PRIO, CFG.SHEETS.TRACK, CFG.SHEETS.TEAM,
   CFG.SHEETS.CAL, CFG.SHEETS.ANA, CFG.SHEETS.FORM, CFG.SHEETS.WEEKLY]
    .forEach(function (n) { buildNavBar_(sheet_(n)); });

  // จัดลำดับแท็บ + ซ่อนชีตภายใน
  orderTabs_();
  [CFG.SHEETS.CALC, CFG.SHEETS.SNAP, CFG.SHEETS.CONF].forEach(function (n) {
    var sh = sheet_(n); if (sh) sh.hideSheet();
  });

  // สแนปช็อตรอบแรก + คนในทีม + กราฟ + ปฏิทินเดือนนี้
  runChangeEngine();
  refreshPeopleList_();
  buildDashboardCharts_();
  refreshAnalytics();
  renderCalendar();

  ss.setActiveSheet(sheet_(CFG.SHEETS.DASH));
  SpreadsheetApp.getActive().toast('ติดตั้งเรียบร้อยน้า ✓ อย่าลืมกดเมนู "ติดตั้งทริกเกอร์อัตโนมัติ" ด้วย', '🐭 หนูเก็บ', 8);
}

function orderTabs_() {
  var ss = ss_();
  var order = [CFG.SHEETS.DASH, CFG.SHEETS.MASTER, CFG.SHEETS.PRIO, CFG.SHEETS.TRACK,
               CFG.SHEETS.TEAM, CFG.SHEETS.CAL, CFG.SHEETS.ANA, CFG.SHEETS.FORM,
               CFG.SHEETS.WEEKLY, CFG.SHEETS.CALC, CFG.SHEETS.SNAP, CFG.SHEETS.CONF];
  order.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
}

/* ============================== _CONFIG ============================== */

function buildConfigSheet_() {
  // เก็บรายชื่อคนที่พิมพ์เพิ่มเองไว้ก่อนล้างชีต — รันซ้ำต้องไม่ทำรายชื่อหาย
  var old = sheet_(CFG.SHEETS.CONF);
  var keepPeople = old
    ? old.getRange('A2:A60').getValues().filter(function (r) { return String(r[0]).trim(); })
    : [];
  var sh = resetSheet_(CFG.SHEETS.CONF);
  sh.getRange('A1:D1').setValues([['คนในทีม', 'ประเภทงาน', 'สถานะ', 'ความเร่งด่วน']]).setFontWeight('bold');
  if (keepPeople.length) sh.getRange(2, 1, keepPeople.length, 1).setValues(keepPeople);
  sh.getRange(2, 2, CFG.TYPES.length, 1).setValues(CFG.TYPES.map(function (t) { return [t]; }));
  sh.getRange(2, 3, CFG.STATUSES.length, 1).setValues(CFG.STATUSES.map(function (s) { return [s]; }));
  sh.getRange(2, 4, CFG.URGENCIES.length, 1).setValues(CFG.URGENCIES.map(function (u) { return [u]; }));

  var ss = ss_();
  ss.setNamedRange('People', sh.getRange('A2:A60'));
  ss.setNamedRange('TypeList', sh.getRange(2, 2, CFG.TYPES.length, 1));
  ss.setNamedRange('StatusList', sh.getRange(2, 3, CFG.STATUSES.length, 1));
  ss.setNamedRange('UrgencyList', sh.getRange(2, 4, CFG.URGENCIES.length, 1));
}

/** รวมรายชื่อผู้รับผิดชอบจาก master → _CONFIG!A (ไม่ลบชื่อที่พิมพ์เพิ่มเอง) */
function refreshPeopleList_() {
  var conf = sheet_(CFG.SHEETS.CONF);
  var master = sheet_(CFG.SHEETS.MASTER);
  var last = master.getLastRow();
  var existing = conf.getRange('A2:A60').getValues().map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v; });
  var seen = {};
  existing.forEach(function (n) { seen[n] = true; });
  if (last >= 2) {
    master.getRange(2, CFG.MASTER.COL.ASSIGNEE, last - 1, 1).getValues().forEach(function (r) {
      String(r[0] || '').split(',').forEach(function (n) {
        n = n.trim();
        if (n && !seen[n]) { seen[n] = true; existing.push(n); }
      });
    });
  }
  conf.getRange('A2:A60').clearContent();
  if (existing.length) {
    conf.getRange(2, 1, existing.length, 1).setValues(existing.map(function (n) { return [n]; }));
  }
}

/* ============================ MASTER (K–O) ============================ */

function enhanceMasterSheet_() {
  var sh = sheet_(CFG.SHEETS.MASTER);
  var C = CFG.MASTER.COL;
  if (sh.getMaxColumns() < CFG.MASTER.LAST_COL) {
    sh.insertColumnsAfter(sh.getMaxColumns(), CFG.MASTER.LAST_COL - sh.getMaxColumns());
  }

  // หัวคอลัมน์ส่วนขยาย K–O (คัดลอกฟอร์แมตหัวเดิมของ sync มาให้กลมกลืน)
  var headers = [['🚦 ความเร่งด่วน', '🔔 เตือนครั้งที่', '🔗 ไฟล์แนบ/ลิงก์', '📝 หมายเหตุ', '🕐 ประวัติสถานะ']];
  sh.getRange(1, C.TASK_ID).copyTo(sh.getRange(1, C.URGENCY, 1, 5), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sh.getRange(1, C.URGENCY, 1, 5).setValues(headers).setFontFamily(CFG.FONT).setWrap(true);

  sh.setFrozenRows(1);
  if (!sh.getFilter()) sh.getRange(1, 1, Math.max(sh.getLastRow(), 2), CFG.MASTER.LAST_COL).createFilter();

  // ความกว้างคอลัมน์ให้อ่านสบาย
  var widths = [55, 220, 260, 95, 130, 110, 150, 100, 130, 40, 110, 85, 160, 160, 260];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  // dropdown — สถานะ/ประเภทใช้ค่าตรงกับ sync เป๊ะ ๆ (ไม่ strict เผื่อค่าจากระบบ)
  var rows = 998;
  sh.getRange(2, C.URGENCY, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('UrgencyList'), true).setAllowInvalid(false).build());
  sh.getRange(2, C.STATUS, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('StatusList'), true).setAllowInvalid(true).build());
  sh.getRange(2, C.TYPE, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('TypeList'), true).setAllowInvalid(true).build());
  sh.getRange(2, C.ASSIGNEE, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(ss_().getRangeByName('People'), true).setAllowInvalid(true).build());

  // ฟอนต์+จัดวางส่วนขยาย
  sh.getRange(2, C.URGENCY, rows, 5).setFontFamily(CFG.FONT).setVerticalAlignment('middle');
  sh.getRange(2, C.URGENCY, rows, 1).setHorizontalAlignment('center');
  sh.getRange(2, C.REMIND, rows, 1).setHorizontalAlignment('center');
  sh.getRange(2, C.LOG, rows, 1).setWrap(true).setFontSize(8).setFontColor(CFG.COLORS.MUTED);

  applyMasterConditionalFormats_(sh);
  ss_().setNamedRange('MasterTaskIds', sh.getRange('J2:J'));
}

/**
 * CF บน master — เฉพาะที่ไม่ตีกับสีพื้น A–J ของ sync:
 *  - คอลัมน์ E (กำหนดส่ง): ตัวหนังสือแดงหนาเมื่อเลยกำหนดและยังไม่จบ (สีตัวอักษร ไม่ใช่พื้น)
 *  - คอลัมน์ K: พื้นอ่อนตามระดับความเร่งด่วน
 *  - คอลัมน์ L: แดงหนาเมื่อเตือน ≥ 3 ครั้ง
 */
function applyMasterConditionalFormats_(sh) {
  var rules = [];
  var overdueFormula =
    '=AND($J2<>"", IFERROR(VLOOKUP($J2, INDIRECT("\'_CALC\'!$A:$O"), 15, FALSE), FALSE)=TRUE)';
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(overdueFormula)
    .setFontColor(CFG.COLORS.DANGER).setBold(true)
    .setRanges([sh.getRange('E2:E1000')]).build());

  var urgBg = [CFG.COLORS.URGENT_BG, CFG.COLORS.SOON_BG, CFG.COLORS.OK_BG, CFG.COLORS.RELAX_BG];
  CFG.URGENCIES.forEach(function (u, i) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(u).setBackground(urgBg[i])
      .setRanges([sh.getRange('K2:K1000')]).build());
  });

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThanOrEqualTo(3)
    .setFontColor(CFG.COLORS.DANGER).setBold(true)
    .setRanges([sh.getRange('L2:L1000')]).build());

  sh.setConditionalFormatRules(rules);
}

/* ============================= _SNAPSHOT ============================= */

/**
 * _SNAPSHOT — ความจำของเครื่องยนต์ตรวจจับการเปลี่ยนแปลง
 *  A รหัสงาน | B สถานะล่าสุดที่เห็น | C เปลี่ยนสถานะล่าสุดเมื่อ | D เห็นครั้งแรกเมื่อ
 *  E เสร็จเมื่อ | F เตือนล่าสุดวันที่ (dedupe รายวัน)
 *  คอลัมน์ H–K: ประวัติรายวันสำหรับกราฟแนวโน้ม (วันที่, งานค้าง, เกินกำหนด, เสร็จสะสม)
 */
function buildSnapshotSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(CFG.SHEETS.SNAP);
  if (sh) return; // ห้ามล้าง — เก็บประวัติสะสม
  sh = ss.insertSheet(CFG.SHEETS.SNAP);
  sh.getRange('A1:F1').setValues([['รหัสงาน', 'สถานะ', 'เปลี่ยนล่าสุด', 'เห็นครั้งแรก', 'เสร็จเมื่อ', 'เตือนล่าสุด']]).setFontWeight('bold');
  sh.getRange('H1:K1').setValues([['วันที่', 'งานค้าง', 'เกินกำหนด', 'เสร็จสะสม']]).setFontWeight('bold');
}

/* =============================== _CALC =============================== */

/**
 * _CALC — ชั้นข้อมูลที่ทุก view อ่าน: แปลงข้อความวันที่ → date จริง,
 * คำนวณ วันคงเหลือ/เกินกำหนด/อันดับความด่วน/ป้ายนับถอยหลัง/สายพานสถานะ ฯลฯ
 * เป็นสูตร ARRAYFORMULA ล้วน ๆ → สดตลอดเวลา ไม่ต้องกดรีเฟรช
 */
function buildCalcSheet_() {
  var sh = resetSheet_(CFG.SHEETS.CALC);
  var M = "'" + CFG.SHEETS.MASTER + "'";
  var openList = '{' + CFG.OPEN_STATUSES.map(q_).join(';') + '}';
  var urgList = '{' + CFG.URGENCIES.map(q_).join(';') + '}';

  sh.getRange('A1:Y1').setValues([[
    'รหัสงาน', 'ชื่องาน', 'ประเภท', 'กำหนดส่ง(ดิบ)', 'กำหนดส่ง(วันที่)', 'ผู้สั่ง', 'ผู้รับผิดชอบ',
    'สถานะ', 'อัปเดต(ดิบ)', 'ความเร่งด่วน', 'เตือน', 'ลิงก์', 'หมายเหตุ',
    'วันคงเหลือ', 'เกินกำหนด', 'ยังไม่จบ', 'อันดับด่วน',
    'เห็นครั้งแรก', 'เสร็จเมื่อ', 'เปลี่ยนล่าสุด', 'อัปเดต(วันที่)',
    'นับถอยหลัง', 'มิเตอร์', 'ค้างนาน', 'สายพาน',
  ]]).setFontWeight('bold');

  // ตัวแปลงข้อความ "DD/MM/YYYY HH:mm" → date (รับ Date จริงจากฟอร์มด้วย)
  var PARSE = function (col) {
    return 'ARRAYFORMULA(MAP(' + col + ', LAMBDA(v, IF(v="",, IF(ISNUMBER(v), v, ' +
      'IFERROR(DATE(VALUE(MID(v,7,4)), VALUE(MID(v,4,2)), VALUE(LEFT(v,2))) + ' +
      'IFERROR(TIME(VALUE(MID(v,12,2)), VALUE(MID(v,15,2)), 0), 0),))))))';
  };

  var f = {};
  f.A = '=ARRAYFORMULA(' + M + '!J2:J)';
  f.B = '=ARRAYFORMULA(' + M + '!B2:B)';
  f.C = '=ARRAYFORMULA(' + M + '!D2:D)';
  f.D = '=ARRAYFORMULA(' + M + '!E2:E)';
  f.E = '=' + PARSE('D2:D');
  f.F = '=ARRAYFORMULA(' + M + '!F2:F)';
  f.G = '=ARRAYFORMULA(' + M + '!G2:G)';
  f.H = '=ARRAYFORMULA(' + M + '!H2:H)';
  f.I = '=ARRAYFORMULA(' + M + '!I2:I)';
  f.J = '=ARRAYFORMULA(' + M + '!K2:K)';
  f.K = '=ARRAYFORMULA(' + M + '!L2:L)';
  f.L = '=ARRAYFORMULA(' + M + '!M2:M)';
  f.M = '=ARRAYFORMULA(' + M + '!N2:N)';
  f.N = '=ARRAYFORMULA(IF(A2:A="",, IF(E2:E="",, E2:E - NOW())))';
  f.O = '=ARRAYFORMULA(IF(A2:A="",, IF((E2:E<>"") * (E2:E < NOW()) * ISNUMBER(MATCH(H2:H, ' + openList + ', 0)), TRUE, FALSE)))';
  f.P = '=ARRAYFORMULA(IF(A2:A="",, IF(ISNUMBER(MATCH(H2:H, ' + openList + ', 0)), TRUE, FALSE)))';
  f.Q = '=ARRAYFORMULA(IF(A2:A="",, IFERROR(MATCH(J2:J, ' + urgList + ', 0), 3)))';
  f.R = '=ARRAYFORMULA(IF(A2:A="",, IFERROR(VLOOKUP(A2:A, _SNAPSHOT!A:F, 4, FALSE),)))';
  f.S = '=ARRAYFORMULA(IF(A2:A="",, IFERROR(VLOOKUP(A2:A, _SNAPSHOT!A:F, 5, FALSE),)))';
  f.T = '=ARRAYFORMULA(IF(A2:A="",, IFERROR(VLOOKUP(A2:A, _SNAPSHOT!A:F, 3, FALSE),)))';
  f.U = '=' + PARSE('I2:I');
  f.V = '=ARRAYFORMULA(IF(A2:A="",, IF(P2:P=FALSE, "—", IF(E2:E="", "ไม่มีกำหนด", ' +
        'IF(N2:N<0, "⏰ เกิน " & ROUNDUP(-N2:N, 0) & " วัน", ' +
        'IF(N2:N<1, "🔥 ครบกำหนดวันนี้!", "เหลือ " & ROUNDDOWN(N2:N, 0) & " วัน"))))))';
  f.W = '=ARRAYFORMULA(IF(A2:A="",, REPT("▓", 6 - Q2:Q) & REPT("░", Q2:Q - 1)))';
  f.X = '=ARRAYFORMULA(IF(A2:A="",, IF(P2:P=FALSE, "", IF(T2:T="", "", ' +
        'IF((NOW() - T2:T) > ' + CFG.STUCK_DAYS + ', "⚠️ ค้าง " & ROUNDDOWN(NOW() - T2:T, 0) & " วัน", "")))))';
  f.Y = '=ARRAYFORMULA(IF(A2:A="",, IFS(' +
        'H2:H="รอดำเนินการ", "●┄○┄○┄○┄○  มอบหมายแล้ว", ' +
        'H2:H="กำลังทำ",     "●━●━◐┄○┄○  กำลังทำ", ' +
        'H2:H="รอตรวจ",      "●━●━●━◐┄○  ส่งงานแล้ว รอตรวจ", ' +
        'H2:H="เสร็จแล้ว",   "●━●━●━●━●  เสร็จสมบูรณ์", ' +
        'H2:H="ตีกลับ",      "●━●━●━✖┄○  ตีกลับ แก้ไขใหม่", ' +
        'H2:H="ยกเลิก",      "○┄○┄○┄○┄○  ยกเลิก", ' +
        'H2:H="ลบแล้ว",      "○┄○┄○┄○┄○  ลบแล้ว", ' +
        'TRUE, H2:H)))';

  Object.keys(f).forEach(function (col) { sh.getRange(col + '2').setFormula(f[col]); });
  sh.getRange('E2:E').setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange('R2:U').setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange('N2:N').setNumberFormat('0.0');
  ss_().setNamedRange('CalcTable', sh.getRange('A2:Y'));
}

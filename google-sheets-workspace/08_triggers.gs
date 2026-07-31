/**
 * 08_triggers.gs — เมนู + ทริกเกอร์ทั้งหมด
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🐭 หนูเก็บ')
    .addItem('🛠️ ติดตั้ง/ซ่อมระบบทั้งหมด', 'setupWorkspace')
    .addItem('⚡ ติดตั้งทริกเกอร์อัตโนมัติ (ครั้งเดียว)', 'installTriggers')
    .addSeparator()
    .addItem('🔄 รีเฟรชหน้าหลัก + กราฟ', 'refreshDashboard')
    .addItem('🗓️ วาดปฏิทินใหม่', 'renderCalendar')
    .addItem('📈 รีเฟรชหน้าวิเคราะห์', 'refreshAnalytics')
    .addItem('📅 สร้างสรุปสัปดาห์ตอนนี้', 'buildWeeklyReport')
    .addItem('🔔 ตรวจงานเกินกำหนดตอนนี้', 'dailySweep')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('↕️ เรียงตารางงานของฉัน')
      .addItem('ตามกำหนดส่ง (ใกล้สุดขึ้นก่อน)', 'sortMasterByDeadline')
      .addItem('ตามความเร่งด่วน', 'sortMasterByUrgency')
      .addItem('ตามผู้รับผิดชอบ', 'sortMasterByAssignee'))
    .addToUi();
}

/**
 * ติดตั้งทริกเกอร์ (รันครั้งเดียวจากเมนู — ต้องกดอนุญาตสิทธิ์):
 *  - onChange: จับการเขียนจาก sync ของหนูเก็บ (API ไม่ยิง onEdit) → เครื่องยนต์บันทึกประวัติ
 *  - รายวัน 07:00: เตือนงานเกินกำหนด + เก็บสถิติแนวโน้ม
 *  - จันทร์ 08:00: สรุปรายสัปดาห์อัตโนมัติ
 */
function installTriggers() {
  var ss = ss_();
  var mine = ['onChangeHandler', 'dailySweep', 'buildWeeklyReport'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onChangeHandler').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('dailySweep').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('buildWeeklyReport').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  SpreadsheetApp.getActive().toast('ติดตั้งทริกเกอร์ครบแล้วน้า ✓ (onChange + รายวัน 07:00 + จันทร์ 08:00)', '⚡', 6);
}

/**
 * onChange (installable) — ยิงทุกการเปลี่ยนแปลงรวมถึงจาก Sheets API
 * กันถี่เกิน: วิ่งเครื่องยนต์อย่างมากทุก 20 วินาที (พายุ sync หลายงานติดกัน
 * จะถูกเก็บตกในรอบถัดไปอยู่ดี เพราะเครื่องยนต์เทียบทั้งตารางเสมอ)
 */
function onChangeHandler(e) {
  var props = PropertiesService.getDocumentProperties();
  var lastRun = Number(props.getProperty('engineLastRun') || 0);
  if (Date.now() - lastRun < 20000) return;
  props.setProperty('engineLastRun', String(Date.now()));
  runChangeEngine();
}

/** onEdit (simple trigger) — ปุ่ม checkbox ต่าง ๆ + เก็บ log ทันใจเมื่อคนแก้สถานะเอง */
function onEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var name = sh.getName();
  var a1 = e.range.getA1Notation();

  if (name === CFG.SHEETS.FORM) {
    if (handleUrgencyButton_(sh, a1)) return;
    if (a1 === FORM.SUBMIT && e.range.getValue() === true) { submitFormTask_(); return; }
    return;
  }

  if (name === CFG.SHEETS.CAL) {
    if (a1 === 'A2' && e.range.getValue() === true) { e.range.setValue(false); calShiftMonth_(-1); return; }
    if (a1 === 'D2' && e.range.getValue() === true) { e.range.setValue(false); calShiftMonth_(1); return; }
    if (a1 === 'B2' || a1 === 'C2') { renderCalendar(); return; }
    return;
  }

  if (name === CFG.SHEETS.MASTER) {
    // คนแก้สถานะ/เพิ่มงานเองในตาราง → บันทึกประวัติทันทีไม่ต้องรอ onChange
    var col = e.range.getColumn();
    if (col === CFG.MASTER.COL.STATUS || col === CFG.MASTER.COL.TITLE) {
      PropertiesService.getDocumentProperties().setProperty('engineLastRun', String(Date.now()));
      runChangeEngine();
    }
  }
}

/** รีเฟรชหน้าหลัก: รายชื่อคน + สร้างกราฟใหม่ (สูตร KPI สดอยู่แล้ว) */
function refreshDashboard() {
  refreshPeopleList_();
  buildDashboardCharts_();
  SpreadsheetApp.getActive().toast('หน้าหลักอัปเดตแล้วน้า ✓', '📊', 3);
}

/**
 * 09_weekly.gs — 📅 สรุปรายสัปดาห์ (อัตโนมัติทุกจันทร์ 08:00 หรือกดจากเมนู)
 * บล็อกใหม่แทรกไว้บนสุดเสมอ — เปิดชีตมาเจอสัปดาห์ล่าสุดก่อน
 */

function buildWeeklySheet_() {
  var sh = resetSheet_(CFG.SHEETS.WEEKLY);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(3);
  sh.getRange('A2:H2').merge().setValue('📅 สรุปรายสัปดาห์ — รายงานอัตโนมัติทุกเช้าวันจันทร์')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.setColumnWidth(1, 30);
  [180, 90, 200, 160, 140, 140, 140].forEach(function (w, i) { sh.setColumnWidth(i + 2, w); });
}

function buildWeeklyReport() {
  runChangeEngine();
  var sh = sheet_(CFG.SHEETS.WEEKLY);
  var snap = sheet_(CFG.SHEETS.SNAP);
  var master = sheet_(CFG.SHEETS.MASTER);
  if (!sh || !snap || !master) return;
  var C = CFG.MASTER.COL;
  var nowD = now_();

  // หน้าต่างสัปดาห์ที่แล้ว: จันทร์ก่อนหน้า → อาทิตย์
  var thisMon = weekStart_(nowD);
  var lastMon = new Date(thisMon); lastMon.setDate(lastMon.getDate() - 7);
  var lastSun = new Date(thisMon); lastSun.setDate(lastSun.getDate() - 1);
  var inWindow = function (d) { return d instanceof Date && d >= lastMon && d < thisMon; };

  // snapshot: สร้าง/เสร็จในสัปดาห์
  var sLast = snap.getLastRow();
  var sRows = sLast >= 2 ? snap.getRange(2, 1, sLast - 1, 6).getValues() : [];
  var created = 0, doneIds = {};
  sRows.forEach(function (r) {
    if (!r[0]) return;
    if (inWindow(r[3])) created++;
    if (inWindow(r[4])) doneIds[r[0]] = true;
  });

  // master: สถานะปัจจุบัน + คอขวด + กำหนดส่งสัปดาห์นี้
  var last = master.getLastRow();
  var rows = last >= 2 ? master.getRange(2, 1, last - 1, CFG.MASTER.LAST_COL).getValues() : [];
  var open = 0, overdue = 0, doneBy = {}, stuck = [], upcoming = [];
  var nextMon = new Date(thisMon); nextMon.setDate(nextMon.getDate() + 7);
  var lastChangeById = {};
  sRows.forEach(function (r) { if (r[0]) lastChangeById[r[0]] = r[2]; });

  rows.forEach(function (r) {
    var title = String(r[C.TITLE - 1]);
    if (!title) return;
    var status = String(r[C.STATUS - 1]);
    var id = String(r[C.TASK_ID - 1]);
    var dl = parseWhen_(r[C.DEADLINE - 1]);
    var assignee = String(r[C.ASSIGNEE - 1] || '');

    if (doneIds[id]) {
      assignee.split(',').forEach(function (p) {
        p = p.trim(); if (p) doneBy[p] = (doneBy[p] || 0) + 1;
      });
    }
    if (CFG.OPEN_STATUSES.indexOf(status) < 0) return;
    open++;
    if (dl && dl < nowD) overdue++;
    var lc = lastChangeById[id];
    if (lc instanceof Date && (nowD - lc) / 86400000 > CFG.STUCK_DAYS) {
      stuck.push('• ' + truncate_(title, 34) + ' — ค้าง "' + status + '" ' + Math.floor((nowD - lc) / 86400000) + ' วัน (' + truncate_(assignee, 16) + ')');
    }
    if (dl && dl >= thisMon && dl < nextMon) {
      upcoming.push('• ' + Utilities.formatDate(dl, CFG.TZ, 'EEE d') + ' — ' + truncate_(title, 34) + ' (' + truncate_(assignee, 16) + ')');
    }
  });

  var doneList = Object.keys(doneBy).sort(function (a, b) { return doneBy[b] - doneBy[a]; });
  var doneWeek = Object.keys(doneIds).length;
  var top = doneList.length ? '🏆 ' + doneList[0] + ' (' + doneBy[doneList[0]] + ' งาน)' : '—';

  var title2 = '🗓️ สัปดาห์ ' + Utilities.formatDate(lastMon, CFG.TZ, 'd MMM') + ' – ' +
               Utilities.formatDate(lastSun, CFG.TZ, 'd MMM yyyy');
  var lines = [
    ['', title2, '', '', '', '', '', ''],
    ['', 'งานเข้าใหม่', created + ' งาน', 'เสร็จในสัปดาห์', doneWeek + ' งาน', 'ดาวประจำสัปดาห์', top, ''],
    ['', 'งานค้างตอนนี้', open + ' งาน', 'เกินกำหนดตอนนี้', overdue + ' งาน', 'อัตราเสร็จ',
      (created ? Math.round(doneWeek / created * 100) + '%' : '—'), ''],
    ['', '🚧 คอขวด (ค้างสถานะเดิมเกิน ' + CFG.STUCK_DAYS + ' วัน)', '', '', '', '', '', ''],
    ['', stuck.length ? stuck.slice(0, 5).join('\n') : '✨ ไม่มีงานค้างนาน — เยี่ยมมากน้า', '', '', '', '', '', ''],
    ['', '⏳ ครบกำหนดสัปดาห์นี้', '', '', '', '', '', ''],
    ['', upcoming.length ? upcoming.slice(0, 6).join('\n') : 'ไม่มีงานครบกำหนดสัปดาห์นี้', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
  ];

  var START = 4;
  sh.insertRowsBefore(START, lines.length);
  sh.getRange(START, 1, lines.length, 8).setValues(lines).setFontFamily(CFG.FONT).setFontSize(10)
    .setVerticalAlignment('top').setWrap(true);
  sh.getRange(START, 2, 1, 6).merge().setFontSize(13).setFontWeight('bold')
    .setFontColor('#FFFFFF').setBackground(CFG.COLORS.PRIMARY).setVerticalAlignment('middle');
  sh.setRowHeight(START, 32);
  sh.getRange(START + 1, 2, 2, 6).setBackground(CFG.COLORS.NEUTRAL);
  [START + 1, START + 2].forEach(function (rr) {
    sh.getRange(rr, 3).setFontWeight('bold').setFontColor(CFG.COLORS.ACCENT);
    sh.getRange(rr, 5).setFontWeight('bold').setFontColor(CFG.COLORS.DANGER);
    sh.getRange(rr, 7).setFontWeight('bold').setFontColor(CFG.COLORS.SUCCESS);
  });
  [START + 3, START + 5].forEach(function (rr) {
    sh.getRange(rr, 2, 1, 6).merge().setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY)
      .setBackground('#E8EEF6');
  });
  [START + 4, START + 6].forEach(function (rr) {
    sh.getRange(rr, 2, 1, 6).merge();
    sh.setRowHeight(rr, Math.max(24, 16 * (String(sh.getRange(rr, 2).getValue()).split('\n').length + 1)));
  });
  SpreadsheetApp.getActive().toast('สรุปสัปดาห์พร้อมแล้วน้า ✓', '📅', 4);
}

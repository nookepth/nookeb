/**
 * 04_calendar.gs — 🗓️ ปฏิทินรายเดือน
 * สร้างกริดด้วยสคริปต์ (ไม่ใช่สูตร) → กด ◀ ▶ หรือเปลี่ยนเดือน/ปีแล้วระบบวาดใหม่
 * แต่ละช่อง: เลขวันที่ + งาน (ชื่อ + ผู้รับ) ลิงก์คลิกไปแถวจริงในชีตงานของฉัน
 * พื้นหลังช่อง = ระดับความเร่งด่วนสูงสุดของงานวันนั้น
 */

var THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                   'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

function buildCalendarSheet_() {
  var sh = resetSheet_(CFG.SHEETS.CAL);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(4);

  // แถวควบคุม — A2/D2 เป็น checkbox ทำหน้าที่ปุ่ม ◀ ▶ (ติ๊กแล้วสคริปต์เลื่อนเดือน + ติ๊กออกให้เอง)
  sh.getRange('A2').insertCheckboxes().setHorizontalAlignment('center').setNote('◀ เดือนก่อนหน้า');
  var nowD = now_();
  sh.getRange('B2').setValue(THAI_MONTHS[nowD.getMonth()]).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(THAI_MONTHS, true).setAllowInvalid(false).build())
    .setFontSize(13).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#E3F2FD');
  var years = [];
  for (var y = nowD.getFullYear() - 1; y <= nowD.getFullYear() + 2; y++) years.push(String(y));
  sh.getRange('C2').setValue(String(nowD.getFullYear())).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(years, true).setAllowInvalid(false).build())
    .setFontSize(13).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#E3F2FD');
  sh.getRange('D2').insertCheckboxes().setHorizontalAlignment('center').setNote('▶ เดือนถัดไป');
  sh.getRange('E2:G2').merge().setValue('← ติ๊ก ◀/▶ เพื่อเลื่อนเดือน หรือเลือกเดือน/ปีเองก็ได้น้า')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  // คำอธิบายสี
  sh.getRange('A3:G3').merge().setValue('🔴 ด่วนมาก   🟠 ด่วน   🟡 ปกติ   🟢 ไม่รีบ   ✓ เสร็จแล้ว (เทา)   กรอบน้ำเงิน = วันนี้')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  // หัวตารางวัน
  var days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  sh.getRange(4, 1, 1, 7).setValues([days]);
  styleHeader_(sh.getRange(4, 1, 1, 7));
  for (var c = 1; c <= 7; c++) sh.setColumnWidth(c, 165);
}

/** อ่านสถานะเดือน/ปีจากเซลล์ควบคุม */
function calMonthYear_() {
  var sh = sheet_(CFG.SHEETS.CAL);
  var m = THAI_MONTHS.indexOf(String(sh.getRange('B2').getValue()));
  var y = Number(sh.getRange('C2').getValue());
  if (m < 0 || !y) { var d = now_(); m = d.getMonth(); y = d.getFullYear(); }
  return { month: m, year: y };
}

/** เลื่อนเดือน +1 / -1 แล้ววาดใหม่ (เรียกจาก onEdit เมื่อติ๊ก ◀ ▶) */
function calShiftMonth_(delta) {
  var sh = sheet_(CFG.SHEETS.CAL);
  var st = calMonthYear_();
  var d = new Date(st.year, st.month + delta, 1);
  sh.getRange('B2').setValue(THAI_MONTHS[d.getMonth()]);
  sh.getRange('C2').setValue(String(d.getFullYear()));
  renderCalendar();
}

/** วาดปฏิทินเดือนที่เลือก (เมนู + onEdit เรียก) */
function renderCalendar() {
  var sh = sheet_(CFG.SHEETS.CAL);
  if (!sh) return;
  var st = calMonthYear_();
  var first = new Date(st.year, st.month, 1);
  var daysInMonth = new Date(st.year, st.month + 1, 0).getDate();
  var startDow = first.getDay(); // 0 = อาทิตย์

  // งานของเดือนนี้ จัดกลุ่มตามวันที่ (อ่านตรงจาก master — ตำแหน่งแถวจริงใช้ทำลิงก์)
  var master = sheet_(CFG.SHEETS.MASTER);
  var masterGid = master.getSheetId();
  var last = master.getLastRow();
  var byDay = {}; // day → [{title, assignee, urgency, done, row}]
  if (last >= 2) {
    var vals = master.getRange(2, 1, last - 1, CFG.MASTER.LAST_COL).getValues();
    vals.forEach(function (r, i) {
      var status = String(r[CFG.MASTER.COL.STATUS - 1]);
      if (!String(r[CFG.MASTER.COL.TITLE - 1]) || status === 'ลบแล้ว' || status === 'ยกเลิก') return;
      var dl = parseWhen_(r[CFG.MASTER.COL.DEADLINE - 1]);
      if (!dl || dl.getFullYear() !== st.year || dl.getMonth() !== st.month) return;
      var day = dl.getDate();
      (byDay[day] = byDay[day] || []).push({
        title: String(r[CFG.MASTER.COL.TITLE - 1]),
        assignee: String(r[CFG.MASTER.COL.ASSIGNEE - 1] || '').split(',')[0].trim(),
        urgency: String(r[CFG.MASTER.COL.URGENCY - 1] || CFG.DEFAULT_URGENCY),
        done: status === 'เสร็จแล้ว',
        row: i + 2,
      });
    });
  }

  var URG_BG = {};
  URG_BG[CFG.URGENCIES[0]] = CFG.COLORS.URGENT_BG;
  URG_BG[CFG.URGENCIES[1]] = CFG.COLORS.SOON_BG;
  URG_BG[CFG.URGENCIES[2]] = CFG.COLORS.OK_BG;
  URG_BG[CFG.URGENCIES[3]] = CFG.COLORS.RELAX_BG;
  var urgRank = function (u) { var i = CFG.URGENCIES.indexOf(u); return i < 0 ? 2 : i; };

  var GRID_TOP = 5, WEEKS = 6;
  var grid = sh.getRange(GRID_TOP, 1, WEEKS, 7);
  grid.clearContent().setBackground('#FFFFFF')
    .setBorder(true, true, true, true, true, true, CFG.COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  for (var w = 0; w < WEEKS; w++) sh.setRowHeight(GRID_TOP + w, 96);

  var today = now_();
  var isThisMonth = (today.getFullYear() === st.year && today.getMonth() === st.month);

  for (var day = 1; day <= daysInMonth; day++) {
    var idx = startDow + day - 1;
    var cell = sh.getRange(GRID_TOP + Math.floor(idx / 7), (idx % 7) + 1);
    var tasks = (byDay[day] || []).sort(function (a, b) { return urgRank(a.urgency) - urgRank(b.urgency); });

    var lines = [String(day)];
    var openTasks = tasks.filter(function (t) { return !t.done; });
    tasks.slice(0, CFG.CAL_MAX_PER_DAY).forEach(function (t) {
      var mark = t.done ? '✓ ' : t.urgency.slice(0, 2) + ' ';
      lines.push(mark + truncate_(t.title, 18) + (t.assignee ? ' (' + truncate_(t.assignee, 8) + ')' : ''));
    });
    if (tasks.length > CFG.CAL_MAX_PER_DAY) lines.push('+ อีก ' + (tasks.length - CFG.CAL_MAX_PER_DAY) + ' งาน');

    var text = lines.join('\n');
    var rtb = SpreadsheetApp.newRichTextValue().setText(text)
      .setTextStyle(0, String(day).length, SpreadsheetApp.newTextStyle()
        .setBold(true).setFontSize(12).setForegroundColor(CFG.COLORS.PRIMARY).build());
    // ลิงก์แต่ละบรรทัดงาน → แถวจริงใน "งานของฉัน"
    var pos = String(day).length + 1;
    tasks.slice(0, CFG.CAL_MAX_PER_DAY).forEach(function (t, i2) {
      var lineLen = lines[i2 + 1].length;
      rtb.setLinkUrl(pos, pos + lineLen, '#gid=' + masterGid + '&range=B' + t.row);
      if (t.done) {
        rtb.setTextStyle(pos, pos + lineLen, SpreadsheetApp.newTextStyle()
          .setForegroundColor('#9E9E9E').setStrikethrough(true).setFontSize(8).setUnderline(false).build());
      } else {
        rtb.setTextStyle(pos, pos + lineLen, SpreadsheetApp.newTextStyle()
          .setForegroundColor(CFG.COLORS.TEXT).setFontSize(8).setUnderline(false).build());
      }
      pos += lineLen + 1;
    });
    cell.setRichTextValue(rtb.build()).setVerticalAlignment('top').setWrap(true);

    if (openTasks.length) {
      cell.setBackground(URG_BG[openTasks[0].urgency] || CFG.COLORS.OK_BG);
    }
    if (isThisMonth && day === today.getDate()) {
      cell.setBorder(true, true, true, true, null, null, CFG.COLORS.ACCENT, SpreadsheetApp.BorderStyle.SOLID_THICK);
    }
  }

  // ปิดช่องนอกเดือนเป็นสีเทาอ่อน
  for (var i3 = 0; i3 < startDow; i3++) {
    sh.getRange(GRID_TOP, i3 + 1).setBackground(CFG.COLORS.NEUTRAL);
  }
  for (var i4 = startDow + daysInMonth; i4 < WEEKS * 7; i4++) {
    sh.getRange(GRID_TOP + Math.floor(i4 / 7), (i4 % 7) + 1).setBackground(CFG.COLORS.NEUTRAL);
  }
  SpreadsheetApp.getActive().toast('ปฏิทิน ' + THAI_MONTHS[st.month] + ' ' + st.year + ' พร้อมแล้วน้า ✓', '🗓️', 3);
}

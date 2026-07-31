/**
 * 03_views.gs — หน้ามอง: 📊 หน้าหลัก, ⚡ ความสำคัญ, 🔄 ติดตามสถานะ, 👥 รายงานทีม
 * ทุกหน้าเป็นสูตรล้วน (อ่านจาก _CALC) → อัปเดตสดโดยไม่ต้องกดปุ่ม
 */

/* ============================ 📊 DASHBOARD ============================ */

function buildDashboard_() {
  var sh = resetSheet_(CFG.SHEETS.DASH);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(1);
  if (sh.getMaxColumns() < 36) sh.insertColumnsAfter(sh.getMaxColumns(), 36 - sh.getMaxColumns());
  if (sh.getMaxRows() < 60) sh.insertRowsAfter(sh.getMaxRows(), 60 - sh.getMaxRows());

  // ทักทาย + วันเวลา (ตั้ง Recalculation = ทุกนาที ใน File → Settings เพื่อให้เวลาเดิน)
  sh.getRange('A2:N2').merge().setFormula(
    '="👋 " & IFS(HOUR(NOW())<12, "สวัสดีตอนเช้า", HOUR(NOW())<17, "สวัสดีตอนบ่าย", TRUE, "สวัสดีตอนเย็น")' +
    ' & "น้า — วัน" & TEXT(NOW(), "dddd ที่ d mmmm yyyy") & "  ⏰ " & TEXT(NOW(), "HH:mm") & " น."')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.setRowHeight(2, 40);

  // ---------- KPI cards (แถว 4–6, การ์ดละ 2 คอลัมน์) ----------
  var CALC = "'" + CFG.SHEETS.CALC + "'";
  var kpis = [
    ['📦 งานทั้งหมด', '=COUNTIFS(' + CALC + '!A2:A, "<>", ' + CALC + '!H2:H, "<>ลบแล้ว")', CFG.COLORS.PRIMARY, '#E8EEF6'],
    ['⏸️ รอดำเนินการ', '=COUNTIF(' + CALC + '!H2:H, "รอดำเนินการ")', '#607D8B', '#ECEFF1'],
    ['🔵 กำลังทำ', '=COUNTIF(' + CALC + '!H2:H, "กำลังทำ")', CFG.COLORS.ACCENT, '#E3F2FD'],
    ['🟣 รอตรวจ', '=COUNTIF(' + CALC + '!H2:H, "รอตรวจ")', '#7E57C2', '#EDE7F6'],
    ['✅ เสร็จแล้ว', '=COUNTIF(' + CALC + '!H2:H, "เสร็จแล้ว")', CFG.COLORS.SUCCESS, '#E8F5E9'],
    ['⏰ เกินกำหนด', '=COUNTIF(' + CALC + '!O2:O, TRUE)', CFG.COLORS.DANGER, CFG.COLORS.URGENT_BG],
  ];
  sh.setRowHeight(4, 24).setRowHeight(5, 46).setRowHeight(6, 22);
  kpis.forEach(function (k, i) {
    var col = 1 + i * 2;
    var label = sh.getRange(4, col, 1, 2).merge();
    var num = sh.getRange(5, col, 1, 2).merge();
    var foot = sh.getRange(6, col, 1, 2).merge();
    label.setValue(k[0]).setFontSize(10).setFontColor(CFG.COLORS.MUTED)
      .setHorizontalAlignment('center').setBackground(k[3]);
    num.setFormula(k[1]).setFontSize(26).setFontWeight('bold').setFontColor(k[2])
      .setHorizontalAlignment('center').setBackground(k[3]);
    foot.setValue('รายการ').setFontSize(8).setFontColor(CFG.COLORS.MUTED)
      .setHorizontalAlignment('center').setBackground(k[3]);
    sh.getRange(4, col, 3, 2).setBorder(true, true, true, true, false, false, k[2], SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });

  // ---------- งานด่วนมาก / เกินกำหนด ----------
  styleSection_(sh.getRange('A8:F8'), '🚨 งานด่วนมาก & เกินกำหนด');
  sh.getRange('A9:F9').setValues([['ระดับ', 'ชื่องาน', 'ผู้รับผิดชอบ', 'นับถอยหลัง', 'สถานะ', 'คอขวด']]);
  styleHeader_(sh.getRange('A9:F9'));
  sh.getRange('A10').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(' +
    '{' + CALC + '!J2:J, ' + CALC + '!B2:B, ' + CALC + '!G2:G, ' + CALC + '!V2:V, ' + CALC + '!H2:H, ' + CALC + '!X2:X, IF(' + CALC + '!E2:E="", 9E+99, ' + CALC + '!E2:E)}, ' +
    '(' + CALC + '!P2:P=TRUE) * ((' + CALC + '!Q2:Q=1) + (' + CALC + '!O2:O=TRUE))' +
    '), 7, TRUE), 6, 6), "🎉 ไม่มีงานด่วนหรือเกินกำหนดตอนนี้")');
  sh.getRange('A10:F15').setFontSize(10);
  sh.getRange('B10:B15').setWrap(true);

  // ---------- TOP 5 ใกล้ถึงกำหนด ----------
  styleSection_(sh.getRange('H8:N8'), '⏳ ใกล้ถึงกำหนดส่ง 5 อันดับ');
  sh.getRange('H9:L9').setValues([['ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'นับถอยหลัง', 'ระดับ']]);
  styleHeader_(sh.getRange('H9:L9'));
  sh.getRange('H10').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(' +
    '{' + CALC + '!B2:B, ' + CALC + '!G2:G, ' + CALC + '!D2:D, ' + CALC + '!V2:V, ' + CALC + '!J2:J, ' + CALC + '!E2:E}, ' +
    '(' + CALC + '!P2:P=TRUE) * (' + CALC + '!E2:E<>"")' +
    '), 6, TRUE), 5, 5), "ไม่มีงานที่ตั้งกำหนดส่งไว้")');
  sh.getRange('H10:L14').setFontSize(10);
  sh.getRange('H10:H14').setWrap(true);

  // ---------- ความเคลื่อนไหวล่าสุด ----------
  styleSection_(sh.getRange('A17:F17'), '🕐 ความเคลื่อนไหวล่าสุด');
  sh.getRange('A18:C18').setValues([['เวลา', 'งาน', 'สถานะ']]);
  styleHeader_(sh.getRange('A18:C18'));
  sh.getRange('A19').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(' +
    '{' + CALC + '!I2:I, ' + CALC + '!B2:B, ' + CALC + '!H2:H, ' + CALC + '!U2:U}, ' +
    '(' + CALC + '!A2:A<>"") * (' + CALC + '!U2:U<>"")' +
    '), 4, FALSE), 10, 3), "ยังไม่มีความเคลื่อนไหว")');
  sh.getRange('A19:C28').setFontSize(9);
  sh.getRange('B19:B28').setWrap(true);

  // ---------- พื้นที่รวมยอดสำหรับกราฟ (ซ่อนไว้ที่คอลัมน์ AA เป็นต้นไป) ----------
  var agg = [
    ['AA1', 'สถานะ'], ['AB1', 'จำนวน'],
    ['AD1', 'ประเภท'], ['AE1', 'จำนวน'],
    ['AG1', 'สมาชิก'], ['AH1', 'งานค้าง'],
  ];
  agg.forEach(function (a) { sh.getRange(a[0]).setValue(a[1]); });
  var visStatuses = ['รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'ตีกลับ', 'ยกเลิก'];
  visStatuses.forEach(function (s, i) {
    sh.getRange(2 + i, 27).setValue(s);                       // AA
    sh.getRange(2 + i, 28).setFormula('=COUNTIF(' + CALC + '!H2:H, ' + q_(s) + ')'); // AB
  });
  CFG.TYPES.forEach(function (t, i) {
    sh.getRange(2 + i, 30).setValue(t);                       // AD
    sh.getRange(2 + i, 31).setFormula('=COUNTIF(' + CALC + '!C2:C, ' + q_(t) + ')'); // AE
  });
  sh.getRange('AG2').setFormula('=ARRAYFORMULA(IF(People="",, People))');
  sh.getRange('AH2').setFormula(
    '=MAP(People, LAMBDA(p, IF(p="",, SUMPRODUCT(' +
    'ISNUMBER(SEARCH(p, ' + CALC + '!$G$2:$G$1000)) * (' + CALC + '!$P$2:$P$1000=TRUE) * (' + CALC + '!$A$2:$A$1000<>"")))))');
  sh.hideColumns(27, 10); // AA–AJ

  // ความกว้าง
  [70, 70, 70, 70, 70, 70, 24, 200, 130, 120, 110, 95, 70, 70].forEach(function (w, i) {
    sh.setColumnWidth(i + 1, w);
  });
  sh.setColumnWidth(2, 200); sh.setColumnWidth(4, 110);
}

/** กราฟ 3 ตัวบนหน้าหลัก — เรียกหลัง buildDashboard_() */
function buildDashboardCharts_() {
  var sh = sheet_(CFG.SHEETS.DASH);
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });

  var statusColors = ['#90A4AE', '#2196F3', '#7E57C2', '#4CAF50', '#F44336', '#BDBDBD'];

  sh.insertChart(sh.newChart().asPieChart()
    .addRange(sh.getRange('AA1:AB7'))
    .setOption('title', 'สัดส่วนสถานะงาน')
    .setOption('pieHole', 0.55)
    .setOption('colors', statusColors)
    .setOption('legend', { position: 'right' })
    .setOption('fontName', CFG.FONT)
    .setOption('width', 420).setOption('height', 260)
    .setPosition(17, 5, 0, 0).build());

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(sh.getRange('AD1:AE' + (1 + CFG.TYPES.length)))
    .setOption('title', 'งานแยกตามประเภท')
    .setOption('colors', [CFG.COLORS.ACCENT])
    .setOption('legend', { position: 'none' })
    .setOption('fontName', CFG.FONT)
    .setOption('width', 420).setOption('height', 260)
    .setPosition(17, 9, 0, 0).build());

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.BAR)
    .addRange(sh.getRange('AG1:AH31'))
    .setOption('title', 'งานค้างต่อคน')
    .setOption('colors', [CFG.COLORS.WARNING])
    .setOption('legend', { position: 'none' })
    .setOption('fontName', CFG.FONT)
    .setOption('width', 420).setOption('height', 300)
    .setPosition(31, 5, 0, 0).build());
}

/* =========================== ⚡ PRIORITY VIEW =========================== */

function buildPriorityView_() {
  var sh = resetSheet_(CFG.SHEETS.PRIO);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(5);
  var CALC = "'" + CFG.SHEETS.CALC + "'";

  sh.getRange('A2:I2').merge().setValue('⚡ จัดลำดับความสำคัญ — ด่วนมาก + ใกล้กำหนดขึ้นก่อนเสมอ (เรียงอัตโนมัติ)')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.getRange('A3').setValue('แสดง:').setFontWeight('bold').setHorizontalAlignment('right');
  var filterCell = sh.getRange('B3');
  filterCell.setValue('ทั้งหมด').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['ทั้งหมด', 'เร่งด่วน', 'เกินกำหนด', 'รอรับ'], true).setAllowInvalid(false).build())
    .setBackground('#E3F2FD').setFontWeight('bold').setHorizontalAlignment('center')
    .setBorder(true, true, true, true, false, false, CFG.COLORS.ACCENT, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('C3:F3').merge().setValue('เร่งด่วน = 🔴+🟠 · รอรับ = ยังไม่มีคนกดรับงาน')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  var headers = ['มิเตอร์', 'ระดับ', 'ชื่องาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง', 'นับถอยหลัง', '🔔 เตือนแล้ว', 'สถานะ', 'คอขวด'];
  sh.getRange(5, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh.getRange(5, 1, 1, headers.length));

  var cond =
    'IF($B$3="ทั้งหมด", 1, IF($B$3="เร่งด่วน", (' + CALC + '!Q2:Q<=2), ' +
    'IF($B$3="เกินกำหนด", (' + CALC + '!O2:O=TRUE), (' + CALC + '!H2:H="รอดำเนินการ"))))';
  sh.getRange('A6').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(' +
    '{' + CALC + '!W2:W, ' + CALC + '!J2:J, ' + CALC + '!B2:B, ' + CALC + '!G2:G, ' + CALC + '!D2:D, ' +
    CALC + '!V2:V, ' + CALC + '!K2:K, ' + CALC + '!H2:H, ' + CALC + '!X2:X, ' +
    CALC + '!Q2:Q, IF(' + CALC + '!E2:E="", 9E+99, ' + CALC + '!E2:E)}, ' +
    '(' + CALC + '!P2:P=TRUE) * ' + cond +
    '), 10, TRUE, 11, TRUE), 500, 9), "🎉 ไม่มีงานในหมวดนี้")');

  sh.getRange('A6:I500').setFontSize(10);
  sh.getRange('C6:C500').setWrap(true);
  sh.getRange('A6:A500').setFontFamily('Roboto Mono').setFontColor(CFG.COLORS.ACCENT);
  sh.getRange('G6:G500').setHorizontalAlignment('center');
  [90, 100, 240, 150, 120, 130, 90, 100, 110].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  for (var r = 6; r <= 40; r++) sh.setRowHeight(r, 26);

  // ไฮไลต์แถวตามระดับ + เกินกำหนด
  var rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B6="🔴 ด่วนมาก"').setBackground(CFG.COLORS.URGENT_BG)
      .setRanges([sh.getRange('A6:I500')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B6="🟠 ด่วน"').setBackground(CFG.COLORS.SOON_BG)
      .setRanges([sh.getRange('A6:I500')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('เกิน').setFontColor(CFG.COLORS.DANGER).setBold(true)
      .setRanges([sh.getRange('F6:F500')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('⚠️').setFontColor(CFG.COLORS.WARNING).setBold(true)
      .setRanges([sh.getRange('I6:I500')]).build(),
  ];
  sh.setConditionalFormatRules(rules);
}

/* ========================== 🔄 STATUS TRACKER ========================== */

function buildStatusTracker_() {
  var sh = resetSheet_(CFG.SHEETS.TRACK);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(5);
  var CALC = "'" + CFG.SHEETS.CALC + "'";

  sh.getRange('A2:I2').merge().setValue('🔄 ติดตามสถานะ — มอบหมาย → รับงาน → กำลังทำ → ส่งงาน → ตรวจ → เสร็จ / ตีกลับ')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);

  // ตัวกรอง (เว้นว่าง = ทั้งหมด)
  var filters = [['A3', 'ผู้สั่ง:', 'B3'], ['C3', 'ผู้รับ:', 'D3'], ['E3', 'ประเภท:', 'F3'], ['G3', 'ระดับด่วน:', 'H3']];
  filters.forEach(function (f) {
    sh.getRange(f[0]).setValue(f[1]).setFontWeight('bold').setHorizontalAlignment('right').setFontSize(9);
    sh.getRange(f[2]).setBackground('#E3F2FD')
      .setBorder(true, true, true, true, false, false, CFG.COLORS.ACCENT, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.getRange('D3').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss_().getRangeByName('People'), true).setAllowInvalid(true).build());
  sh.getRange('F3').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss_().getRangeByName('TypeList'), true).setAllowInvalid(true).build());
  sh.getRange('H3').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss_().getRangeByName('UrgencyList'), true).setAllowInvalid(true).build());
  sh.getRange('I3').setValue('เรียงตาม:').setFontWeight('bold').setHorizontalAlignment('right').setFontSize(9);
  sh.getRange('J3').setValue('กำหนดส่ง').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['กำหนดส่ง', 'สถานะ', 'ชื่องาน', 'ผู้รับผิดชอบ'], true).setAllowInvalid(false).build())
    .setBackground('#E3F2FD').setFontWeight('bold')
    .setBorder(true, true, true, true, false, false, CFG.COLORS.ACCENT, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A4:J4').merge().setValue('เว้นตัวกรองว่าง = แสดงทั้งหมด · พิมพ์บางส่วนของชื่อได้')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  var headers = ['ชื่องาน', 'ประเภท', 'สายพานสถานะ', 'ผู้สั่ง', 'ผู้รับผิดชอบ', 'กำหนดส่ง', '🔗 ลิงก์', '📝 หมายเหตุ/เหตุผลตีกลับ', 'อัปเดตล่าสุด'];
  sh.getRange(5, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh.getRange(5, 1, 1, headers.length));

  var cond =
    'IF($B$3="", 1, ISNUMBER(SEARCH($B$3, ' + CALC + '!F2:F))) * ' +
    'IF($D$3="", 1, ISNUMBER(SEARCH($D$3, ' + CALC + '!G2:G))) * ' +
    'IF($F$3="", 1, (' + CALC + '!C2:C=$F$3)) * ' +
    'IF($H$3="", 1, (' + CALC + '!J2:J=$H$3)) * ' +
    '(' + CALC + '!H2:H<>"ลบแล้ว") * (' + CALC + '!A2:A<>"")';
  sh.getRange('A6').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(' +
    '{' + CALC + '!B2:B, ' + CALC + '!C2:C, ' + CALC + '!Y2:Y, ' + CALC + '!F2:F, ' + CALC + '!G2:G, ' +
    CALC + '!D2:D, ' + CALC + '!L2:L, ' + CALC + '!M2:M, ' + CALC + '!I2:I, ' +
    'IF(' + CALC + '!E2:E="", 9E+99, ' + CALC + '!E2:E)}, ' + cond + '), ' +
    'IFS($J$3="สถานะ", 3, $J$3="ชื่องาน", 1, $J$3="ผู้รับผิดชอบ", 5, TRUE, 10), TRUE), 500, 9), ' +
    '"ไม่พบงานตามตัวกรองนี้")');

  sh.getRange('A6:I500').setFontSize(10);
  sh.getRange('A6:A500').setWrap(true);
  sh.getRange('C6:C500').setFontFamily('Roboto Mono').setFontSize(9);
  sh.getRange('H6:H500').setWrap(true);
  [220, 90, 210, 110, 140, 120, 140, 200, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('ตีกลับ')
      .setFontColor(CFG.COLORS.DANGER).setBold(true).setRanges([sh.getRange('C6:C500')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('เสร็จสมบูรณ์')
      .setFontColor(CFG.COLORS.SUCCESS).setRanges([sh.getRange('C6:C500')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('รอตรวจ')
      .setFontColor('#7E57C2').setBold(true).setRanges([sh.getRange('C6:C500')]).build(),
  ];
  sh.setConditionalFormatRules(rules);
}

/* ============================ 👥 TEAM REPORT ============================ */

function buildTeamReport_() {
  var sh = resetSheet_(CFG.SHEETS.TEAM);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(4);
  var CALC = "'" + CFG.SHEETS.CALC + "'";

  sh.getRange('A2:K2').merge().setValue('👥 รายงานทีม — ใครรับงานเท่าไหร่ ใครล้นมือ ใครว่าง (อัปเดตสดจากงานทั้งหมด)')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.getRange('A3:K3').merge().setValue(
    'รอตรวจ = ส่งงานกลับมาแล้วรอเจ้าของงานตรวจ · ตีกลับ = ถูกตีกลับให้แก้ · ภาระงานค้าง = งานที่ยังไม่จบทั้งหมดของคนนั้น')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  var headers = ['สมาชิก', 'ได้รับทั้งหมด', 'รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'ตีกลับ', 'เสร็จแล้ว', 'เกินกำหนด', '% สำเร็จ', 'ภาระงานค้าง', 'ภาพรวม'];
  sh.getRange(4, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh.getRange(4, 1, 1, headers.length));

  var R = '$2:$1000';
  var G = CALC + '!$G' + R, H = CALC + '!$H' + R, O = CALC + '!$O' + R, A = CALC + '!$A' + R;
  function count(extra) {
    return 'SUMPRODUCT(ISNUMBER(SEARCH($A5, ' + G + ')) * (' + A + '<>"") * ' + extra + ')';
  }
  var rowFormulas = [
    '=IFERROR(IF(INDEX(People, ROW()-4)="",, INDEX(People, ROW()-4)),)',
    '=IF($A5="",, ' + count('(' + H + '<>"ลบแล้ว")') + ')',
    '=IF($A5="",, ' + count('(' + H + '="รอดำเนินการ")') + ')',
    '=IF($A5="",, ' + count('(' + H + '="กำลังทำ")') + ')',
    '=IF($A5="",, ' + count('(' + H + '="รอตรวจ")') + ')',
    '=IF($A5="",, ' + count('(' + H + '="ตีกลับ")') + ')',
    '=IF($A5="",, ' + count('(' + H + '="เสร็จแล้ว")') + ')',
    '=IF($A5="",, ' + count('(' + O + '=TRUE)') + ')',
    '=IF(OR($A5="", $B5=0),, $G5/$B5)',
    '=IF($A5="",, $C5+$D5+$E5+$F5)',
    '=IF($A5="",, SPARKLINE({$G5, $J5}, {"charttype","bar"; "color1","' + CFG.COLORS.SUCCESS + '"; "color2","' + CFG.COLORS.ACCENT + '"; "max", MAX($B5, 1)}))',
  ];
  // เติมสูตร 30 แถว (แถว 5–34) — แถวที่ไม่มีชื่อคนจะว่างเอง
  var block = [];
  for (var r = 5; r <= 34; r++) {
    block.push(rowFormulas.map(function (f) { return f.replace(/5(?![0-9])/g, String(r)); }));
  }
  sh.getRange(5, 1, block.length, rowFormulas.length).setFormulas(block);

  sh.getRange('I5:I34').setNumberFormat('0%');
  sh.getRange('B5:J34').setHorizontalAlignment('center');
  sh.getRange('A5:A34').setFontWeight('bold');
  [150, 100, 100, 90, 80, 80, 90, 95, 85, 105, 140].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  for (var r2 = 5; r2 <= 34; r2++) sh.setRowHeight(r2, 28);
  innerBorders_(sh.getRange('A4:K34'));

  // heatmap: ภาระงานค้าง (ขาว→ส้ม→แดง) และ % สำเร็จ (แดง→เขียว)
  var rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#FFFFFF', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMidpointWithValue('#FFE0B2', SpreadsheetApp.InterpolationType.NUMBER, '3')
      .setGradientMaxpointWithValue('#EF9A9A', SpreadsheetApp.InterpolationType.NUMBER, '8')
      .setRanges([sh.getRange('J5:J34')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#FFCDD2', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMidpointWithValue('#FFF9C4', SpreadsheetApp.InterpolationType.NUMBER, '0.5')
      .setGradientMaxpointWithValue('#C8E6C9', SpreadsheetApp.InterpolationType.NUMBER, '1')
      .setRanges([sh.getRange('I5:I34')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setFontColor(CFG.COLORS.DANGER).setBold(true)
      .setRanges([sh.getRange('H5:H34')]).build(),
  ];
  sh.setConditionalFormatRules(rules);
}

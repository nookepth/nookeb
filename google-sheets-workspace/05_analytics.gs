/**
 * 05_analytics.gs — 📈 วิเคราะห์
 * ใช้ความจำของ _SNAPSHOT (เห็นครั้งแรก/เสร็จเมื่อ + ประวัติรายวัน) มาสรุปแนวโน้ม
 * ตาราง refresh ด้วยสคริปต์ · กราฟสร้างครั้งเดียวชี้ช่วงเซลล์คงที่
 */

var ANA = {
  WEEKS: 12,
  WEEK_TBL: { r: 5, c: 1 },   // A5  สัปดาห์|เข้า|เสร็จ|อัตรา
  TYPE_TBL: { r: 5, c: 6 },   // F5  ประเภท|เฉลี่ยวัน|จำนวนเสร็จ|ทั้งหมด
  PPL_TBL: { r: 5, c: 11 },   // K5  สมาชิก|เสร็จ|เฉลี่ยวัน
  HIST_TBL: { r: 5, c: 15 },  // O5  วันที่|งานค้าง|เกินกำหนด
  HIST_ROWS: 30,
};

function buildAnalyticsSheet_() {
  var sh = resetSheet_(CFG.SHEETS.ANA);
  styleSheetBase_(sh, true);
  sh.setFrozenRows(1);
  if (sh.getMaxRows() < 80) sh.insertRowsAfter(sh.getMaxRows(), 80 - sh.getMaxRows());
  if (sh.getMaxColumns() < 18) sh.insertColumnsAfter(sh.getMaxColumns(), 18 - sh.getMaxColumns());

  sh.getRange('A2:N2').merge().setValue('📈 วิเคราะห์ — แนวโน้มงานเข้า/งานเสร็จ ความเร็วของทีม และอัตรางานเกินกำหนด')
    .setFontSize(14).setFontWeight('bold').setFontColor(CFG.COLORS.PRIMARY);
  sh.getRange('A3:N3').merge().setValue(
    'ข้อมูลแนวโน้มนับจากวันที่ระบบเริ่มเห็นงานแต่ละชิ้น (เริ่มสะสมตั้งแต่วันติดตั้ง) · กดเมนู 🐭 → รีเฟรชวิเคราะห์ เพื่ออัปเดตตาราง')
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  sh.getRange(4, 1, 1, 4).setValues([['สัปดาห์', 'งานเข้า', 'งานเสร็จ', 'อัตราเสร็จ']]);
  sh.getRange(4, 6, 1, 4).setValues([['ประเภท', 'เฉลี่ย (วัน)', 'เสร็จ (งาน)', 'ทั้งหมด']]);
  sh.getRange(4, 11, 1, 3).setValues([['สมาชิก', 'เสร็จ (งาน)', 'เฉลี่ย (วัน)']]);
  sh.getRange(4, 15, 1, 3).setValues([['วันที่', 'งานค้าง', 'เกินกำหนด']]);
  [sh.getRange(4, 1, 1, 4), sh.getRange(4, 6, 1, 4), sh.getRange(4, 11, 1, 3), sh.getRange(4, 15, 1, 3)]
    .forEach(styleHeader_);

  [110, 70, 70, 80, 24, 110, 90, 90, 80, 24, 130, 85, 90, 24, 90, 75, 85].forEach(function (w, i) {
    sh.setColumnWidth(i + 1, w);
  });
  sh.getRange('D5:D16').setNumberFormat('0%');

  buildAnalyticsCharts_(sh);
}

function buildAnalyticsCharts_(sh) {
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(4, 1, 1 + ANA.WEEKS, 3))
    .setOption('title', 'งานเข้า vs งานเสร็จ (รายสัปดาห์)')
    .setOption('colors', [CFG.COLORS.ACCENT, CFG.COLORS.SUCCESS])
    .setOption('curveType', 'function').setOption('fontName', CFG.FONT)
    .setOption('legend', { position: 'bottom' })
    .setOption('width', 440).setOption('height', 280)
    .setPosition(19, 1, 0, 0).build());

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(sh.getRange(4, 1, 1 + ANA.WEEKS, 1))
    .addRange(sh.getRange(4, 4, 1 + ANA.WEEKS, 1))
    .setOption('title', 'อัตราเสร็จรายสัปดาห์ (%)')
    .setOption('colors', [CFG.COLORS.SUCCESS]).setOption('fontName', CFG.FONT)
    .setOption('legend', { position: 'none' })
    .setOption('vAxis', { format: 'percent' })
    .setOption('width', 440).setOption('height', 280)
    .setPosition(19, 6, 0, 0).build());

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.BAR)
    .addRange(sh.getRange(4, 6, 1 + CFG.TYPES.length, 2))
    .setOption('title', 'เวลาเฉลี่ยกว่างานจะเสร็จ แยกตามประเภท (วัน)')
    .setOption('colors', ['#7E57C2']).setOption('fontName', CFG.FONT)
    .setOption('legend', { position: 'none' })
    .setOption('width', 440).setOption('height', 240)
    .setPosition(34, 1, 0, 0).build());

  sh.insertChart(sh.newChart().asPieChart()
    .addRange(sh.getRange(4, 6, 1 + CFG.TYPES.length, 1))
    .addRange(sh.getRange(4, 9, 1 + CFG.TYPES.length, 1))
    .setOption('title', 'สัดส่วนงานตามประเภท')
    .setOption('pieHole', 0.55).setOption('fontName', CFG.FONT)
    .setOption('colors', [CFG.COLORS.ACCENT, CFG.COLORS.WARNING, '#7E57C2'])
    .setOption('width', 440).setOption('height', 240)
    .setPosition(34, 6, 0, 0).build());

  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(4, 15, 1 + ANA.HIST_ROWS, 3))
    .setOption('title', 'งานค้าง & เกินกำหนด (รายวัน 30 วันล่าสุด)')
    .setOption('colors', [CFG.COLORS.ACCENT, CFG.COLORS.DANGER])
    .setOption('fontName', CFG.FONT).setOption('legend', { position: 'bottom' })
    .setOption('width', 440).setOption('height', 260)
    .setPosition(49, 1, 0, 0).build());
}

/** วันจันทร์ของสัปดาห์ที่ d อยู่ */
function weekStart_(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var dow = (x.getDay() + 6) % 7; // จันทร์ = 0
  x.setDate(x.getDate() - dow);
  return x;
}

/** เติมตารางวิเคราะห์ทั้งหมดจาก _SNAPSHOT + master */
function refreshAnalytics() {
  var sh = sheet_(CFG.SHEETS.ANA);
  var snap = sheet_(CFG.SHEETS.SNAP);
  if (!sh || !snap) return;

  // --- อ่าน snapshot: id → {firstSeen, doneAt} ---
  var sLast = snap.getLastRow();
  var snapRows = sLast >= 2 ? snap.getRange(2, 1, sLast - 1, 6).getValues() : [];
  var byId = {};
  snapRows.forEach(function (r) {
    if (r[0]) byId[r[0]] = { firstSeen: r[3] instanceof Date ? r[3] : null, doneAt: r[4] instanceof Date ? r[4] : null };
  });

  // --- อ่าน master: id → {type, assignees} ---
  var master = sheet_(CFG.SHEETS.MASTER);
  var mLast = master.getLastRow();
  var mRows = mLast >= 2 ? master.getRange(2, 1, mLast - 1, CFG.MASTER.LAST_COL).getValues() : [];
  var meta = {};
  mRows.forEach(function (r) {
    var id = String(r[CFG.MASTER.COL.TASK_ID - 1]);
    if (id) meta[id] = {
      type: String(r[CFG.MASTER.COL.TYPE - 1] || ''),
      assignees: String(r[CFG.MASTER.COL.ASSIGNEE - 1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      status: String(r[CFG.MASTER.COL.STATUS - 1] || ''),
    };
  });

  // --- ตารางรายสัปดาห์ ---
  var weeks = []; // เก่า→ใหม่
  var mon = weekStart_(now_());
  for (var i = ANA.WEEKS - 1; i >= 0; i--) {
    var start = new Date(mon); start.setDate(start.getDate() - 7 * i);
    weeks.push(start);
  }
  var wkKey = function (d) { return dayKey_(weekStart_(d)); };
  var inCount = {}, doneCount = {};
  Object.keys(byId).forEach(function (id) {
    var s = byId[id];
    if (s.firstSeen) inCount[wkKey(s.firstSeen)] = (inCount[wkKey(s.firstSeen)] || 0) + 1;
    if (s.doneAt) doneCount[wkKey(s.doneAt)] = (doneCount[wkKey(s.doneAt)] || 0) + 1;
  });
  var weekTable = weeks.map(function (w) {
    var k = dayKey_(w);
    var cin = inCount[k] || 0, cdone = doneCount[k] || 0;
    return [Utilities.formatDate(w, CFG.TZ, 'd MMM'), cin, cdone, cin ? cdone / cin : (cdone ? 1 : 0)];
  });
  sh.getRange(ANA.WEEK_TBL.r, ANA.WEEK_TBL.c, ANA.WEEKS, 4).setValues(weekTable);

  // --- ต่อประเภท: เวลาเฉลี่ย + จำนวน ---
  var typeAgg = {};
  CFG.TYPES.forEach(function (t) { typeAgg[t] = { sum: 0, n: 0, total: 0 }; });
  Object.keys(meta).forEach(function (id) {
    var t = typeAgg[meta[id].type];
    if (!t) return;
    t.total++;
    var s = byId[id];
    if (s && s.firstSeen && s.doneAt) {
      t.sum += (s.doneAt - s.firstSeen) / 86400000;
      t.n++;
    }
  });
  sh.getRange(ANA.TYPE_TBL.r, ANA.TYPE_TBL.c, CFG.TYPES.length, 4).setValues(
    CFG.TYPES.map(function (tp) {
      var t = typeAgg[tp];
      return [tp, t.n ? Math.round(t.sum / t.n * 10) / 10 : 0, t.n, t.total];
    }));

  // --- ต่อคน: ใครเสร็จเร็ว/ช้า ---
  var ppl = {};
  Object.keys(meta).forEach(function (id) {
    var s = byId[id];
    if (!s || !s.firstSeen || !s.doneAt) return;
    var days = (s.doneAt - s.firstSeen) / 86400000;
    meta[id].assignees.forEach(function (p) {
      (ppl[p] = ppl[p] || { sum: 0, n: 0 }).sum += days;
      ppl[p].n++;
    });
  });
  var pplRows = Object.keys(ppl).map(function (p) {
    return [p, ppl[p].n, Math.round(ppl[p].sum / ppl[p].n * 10) / 10];
  }).sort(function (a, b) { return a[2] - b[2]; }).slice(0, 30);
  sh.getRange(ANA.PPL_TBL.r, ANA.PPL_TBL.c, 30, 3).clearContent();
  if (pplRows.length) sh.getRange(ANA.PPL_TBL.r, ANA.PPL_TBL.c, pplRows.length, 3).setValues(pplRows);
  var fastLine = pplRows.length >= 2
    ? '🏆 เร็วสุด: ' + pplRows[0][0] + ' (' + pplRows[0][2] + ' วัน)   ·   🐢 ใช้เวลามากสุด: ' +
      pplRows[pplRows.length - 1][0] + ' (' + pplRows[pplRows.length - 1][2] + ' วัน)'
    : 'ยังมีข้อมูลงานเสร็จไม่พอสรุปความเร็วรายคนน้า';
  sh.getRange(ANA.PPL_TBL.r + 31, ANA.PPL_TBL.c, 1, 3).merge().setValue(fastLine)
    .setFontSize(9).setFontColor(CFG.COLORS.MUTED);

  // --- ประวัติรายวัน (จาก dailySweep) ---
  var hLast = snap.getLastRow();
  var hist = [];
  if (hLast >= 2) {
    var hVals = snap.getRange(2, 8, hLast - 1, 4).getValues()
      .filter(function (r) { return r[0]; });
    hist = hVals.slice(-ANA.HIST_ROWS).map(function (r) {
      return [r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'd MMM') : String(r[0]), r[1], r[2]];
    });
  }
  sh.getRange(ANA.HIST_TBL.r, ANA.HIST_TBL.c, ANA.HIST_ROWS, 3).clearContent();
  if (hist.length) sh.getRange(ANA.HIST_TBL.r, ANA.HIST_TBL.c, hist.length, 3).setValues(hist);
}

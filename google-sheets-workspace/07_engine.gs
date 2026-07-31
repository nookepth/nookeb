/**
 * 07_engine.gs — เครื่องยนต์ตรวจจับการเปลี่ยนแปลง + งานประจำวัน + มาโครเรียงลำดับ
 *
 * ทำไมไม่ใช้ onEdit เฉย ๆ: การเขียนจากระบบ sync ของหนูเก็บมาทาง Sheets API
 * ซึ่ง "ไม่" ยิง onEdit — จึงต้องใช้ onChange + เทียบกับสแนปช็อตครั้งก่อน (_SNAPSHOT)
 * เพื่อรู้ว่าแถวไหนสถานะเปลี่ยน แล้วค่อยบันทึกประวัติ/ประทับเวลา
 */

/**
 * สแกน master เทียบ _SNAPSHOT:
 *  - แถวใหม่ที่ไม่มีรหัสงาน (คนพิมพ์เพิ่มเองในตาราง) → แจกรหัส LOCAL, ใส่สถานะ/เวลาเริ่มต้น
 *  - งานใหม่ (รหัสที่ไม่เคยเห็น) → จำเวลา "เห็นครั้งแรก" (ฐานของกราฟแนวโน้ม)
 *  - สถานะเปลี่ยน → ต่อบรรทัดใน 🕐 ประวัติสถานะ + จำเวลาเปลี่ยน (ฐานของตัวจับคอขวด)
 *  - ความเร่งด่วนว่าง → เติมค่าเริ่มต้น 🟡 ปกติ
 */
function runChangeEngine() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // มีรอบอื่นกำลังวิ่งอยู่ — รอบหน้าเก็บตก
  try {
    var master = sheet_(CFG.SHEETS.MASTER);
    var snap = sheet_(CFG.SHEETS.SNAP);
    if (!master || !snap) return;
    var C = CFG.MASTER.COL;
    var nowD = now_();

    var last = master.getLastRow();
    var rows = last >= 2 ? master.getRange(2, 1, last - 1, CFG.MASTER.LAST_COL).getValues() : [];

    // snapshot เดิม → map
    var sLast = snap.getLastRow();
    var sRows = sLast >= 2 ? snap.getRange(2, 1, sLast - 1, 6).getValues() : [];
    var byId = {};
    sRows.forEach(function (r) {
      if (r[0]) byId[r[0]] = { status: String(r[1]), lastChange: r[2], firstSeen: r[3], doneAt: r[4], lastRemind: String(r[5] || '') };
    });

    var cellWrites = []; // {row, col, value}
    rows.forEach(function (r, i) {
      var rowNo = i + 2;
      var title = String(r[C.TITLE - 1] || '').trim();
      if (!title) return;
      var id = String(r[C.TASK_ID - 1] || '').trim();
      var status = String(r[C.STATUS - 1] || '').trim();

      // แถวที่คนพิมพ์เพิ่มเองโดยตรง — เซ็ตให้ครบเหมือนงานจากฟอร์ม
      if (!id) {
        id = newLocalId_();
        cellWrites.push({ row: rowNo, col: C.TASK_ID, value: id });
        if (!status) {
          status = 'รอดำเนินการ';
          cellWrites.push({ row: rowNo, col: C.STATUS, value: status });
        }
        if (!String(r[C.UPDATED - 1])) cellWrites.push({ row: rowNo, col: C.UPDATED, value: formatWhen_(nowD) });
        var log0 = String(r[C.LOG - 1] || '');
        cellWrites.push({ row: rowNo, col: C.LOG, value: appendLog_(log0, '✏️ เพิ่มงานในตาราง') });
      }
      if (!String(r[C.URGENCY - 1])) {
        cellWrites.push({ row: rowNo, col: C.URGENCY, value: CFG.DEFAULT_URGENCY });
      }

      var s = byId[id];
      if (!s) {
        // งานที่เพิ่งเห็นครั้งแรก (รวมงานที่ sync เพิ่งเพิ่มเข้ามา) — ไม่เขียน log กันสแปมรอบติดตั้ง
        byId[id] = { status: status, lastChange: nowD, firstSeen: nowD,
                     doneAt: status === 'เสร็จแล้ว' ? nowD : '', lastRemind: '' };
        return;
      }
      if (s.status !== status && status) {
        var logCell = String(r[C.LOG - 1] || '');
        cellWrites.push({
          row: rowNo, col: C.LOG,
          value: appendLog_(logCell, (s.status || '—') + ' → ' + status),
        });
        s.status = status;
        s.lastChange = nowD;
        if (status === 'เสร็จแล้ว' && !s.doneAt) s.doneAt = nowD;
      }
    });

    cellWrites.forEach(function (w) { master.getRange(w.row, w.col).setValue(w.value); });

    // เขียน snapshot กลับ (คอลัมน์ A–F เท่านั้น — ห้ามแตะ H–K ที่เป็นประวัติรายวัน)
    var ids = Object.keys(byId);
    if (sLast >= 2) snap.getRange(2, 1, sLast - 1, 6).clearContent();
    if (ids.length) {
      snap.getRange(2, 1, ids.length, 6).setValues(ids.map(function (id2) {
        var s2 = byId[id2];
        return [id2, s2.status, s2.lastChange, s2.firstSeen, s2.doneAt || '', s2.lastRemind || ''];
      }));
    }
  } finally {
    lock.releaseLock();
  }
}

/** ต่อบรรทัด log ใหม่ไว้บนสุด เก็บไม่เกิน 12 บรรทัดกันเซลล์บวม */
function appendLog_(existing, event) {
  var line = formatShort_(now_()) + '  ' + event;
  var lines = [line].concat(String(existing || '').split('\n').filter(Boolean));
  return lines.slice(0, 12).join('\n');
}

/**
 * งานประจำวัน (ทริกเกอร์ 07:00): เตือนงานเกินกำหนด + เก็บสถิติ + รีเฟรชรายงาน
 *  - งานยังไม่จบที่เลยกำหนด → เตือนครั้งที่ +1 (วันละครั้งเดียวต่อ 1 งาน) + จด log
 *  - บันทึกประวัติรายวันลง _SNAPSHOT!H:K (ฐานของกราฟแนวโน้มเกินกำหนด)
 *  - รีเฟรชรายชื่อคน + ตารางวิเคราะห์
 */
function dailySweep() {
  runChangeEngine();

  var master = sheet_(CFG.SHEETS.MASTER);
  var snap = sheet_(CFG.SHEETS.SNAP);
  var C = CFG.MASTER.COL;
  var nowD = now_();
  var todayK = dayKey_(nowD);

  var last = master.getLastRow();
  var rows = last >= 2 ? master.getRange(2, 1, last - 1, CFG.MASTER.LAST_COL).getValues() : [];

  var sLast = snap.getLastRow();
  var sRows = sLast >= 2 ? snap.getRange(2, 1, sLast - 1, 6).getValues() : [];
  var snapIndex = {}; // id → snapshot sheet row
  sRows.forEach(function (r, i) { if (r[0]) snapIndex[r[0]] = i + 2; });

  var open = 0, overdue = 0, doneTotal = 0, reminded = 0;
  rows.forEach(function (r, i) {
    var status = String(r[C.STATUS - 1] || '');
    if (!String(r[C.TITLE - 1])) return;
    if (status === 'เสร็จแล้ว') { doneTotal++; return; }
    if (CFG.OPEN_STATUSES.indexOf(status) < 0) return;
    open++;
    var dl = parseWhen_(r[C.DEADLINE - 1]);
    if (!dl || dl >= nowD) return;
    overdue++;

    var id = String(r[C.TASK_ID - 1]);
    var sRowNo = snapIndex[id];
    var lastRemind = sRowNo ? String(snap.getRange(sRowNo, 6).getValue() || '') : '';
    if (lastRemind === todayK) return; // วันนี้เตือนไปแล้ว

    var count = Number(r[C.REMIND - 1] || 0) + 1;
    master.getRange(i + 2, C.REMIND).setValue(count);
    master.getRange(i + 2, C.LOG).setValue(
      appendLog_(String(r[C.LOG - 1] || ''), '🔔 เตือนครั้งที่ ' + count + ' — เกินกำหนดส่ง'));
    if (sRowNo) snap.getRange(sRowNo, 6).setValue(todayK);
    reminded++;
  });

  // ประวัติรายวัน (แถวของวันนี้มีแล้ว → เขียนทับ)
  var hLast = snap.getLastRow();
  var histRow = hLast + 1;
  for (var rr = 2; rr <= hLast; rr++) {
    var v = snap.getRange(rr, 8).getValue();
    if (v instanceof Date && dayKey_(v) === todayK) { histRow = rr; break; }
    if (!v && rr > 2) { histRow = rr; break; }
  }
  snap.getRange(histRow, 8, 1, 4).setValues([[nowD, open, overdue, doneTotal]]);

  refreshPeopleList_();
  refreshAnalytics();
  SpreadsheetApp.getActive().toast(
    'ตรวจแล้วน้า: ค้าง ' + open + ' · เกินกำหนด ' + overdue + ' · เตือนเพิ่ม ' + reminded + ' งาน', '🔔', 6);
}

/* ------------------------- มาโครเรียงลำดับ ------------------------- */
/**
 * เรียงแถวจริงใน master (A–O ทั้งแถวเลื่อนพร้อมกัน — sync หาแถวด้วยรหัสงาน
 * จึงไม่หลง) แล้วประทับ ลำดับ ใหม่ตามตำแหน่ง
 * หมายเหตุ: ถ้า sync เขียนแทรกพอดีวินาทีเดียวกันอาจมีแถวซ้ำชั่วคราว — รอบ sync
 * ถัดไปของงานนั้นจะซ่อมตัวเอง (upsert ด้วยรหัสงาน)
 */
function sortMasterBy_(cmp) {
  var master = sheet_(CFG.SHEETS.MASTER);
  var last = master.getLastRow();
  if (last < 3) return;
  var rng = master.getRange(2, 1, last - 1, CFG.MASTER.LAST_COL);
  var rows = rng.getValues().filter(function (r) { return String(r[CFG.MASTER.COL.TITLE - 1]); });
  rows.sort(cmp);
  rows.forEach(function (r, i) { r[CFG.MASTER.COL.ORDER - 1] = i + 1; });
  rng.clearContent();
  master.getRange(2, 1, rows.length, CFG.MASTER.LAST_COL).setValues(rows);
  SpreadsheetApp.getActive().toast('เรียงลำดับให้แล้วน้า ✓', '📝', 3);
}

function sortMasterByDeadline() {
  var C = CFG.MASTER.COL;
  sortMasterBy_(function (a, b) {
    var da = parseWhen_(a[C.DEADLINE - 1]), db = parseWhen_(b[C.DEADLINE - 1]);
    return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
  });
}

function sortMasterByUrgency() {
  var C = CFG.MASTER.COL;
  sortMasterBy_(function (a, b) {
    var ra = CFG.URGENCIES.indexOf(String(a[C.URGENCY - 1])), rb = CFG.URGENCIES.indexOf(String(b[C.URGENCY - 1]));
    ra = ra < 0 ? 2 : ra; rb = rb < 0 ? 2 : rb;
    if (ra !== rb) return ra - rb;
    var da = parseWhen_(a[C.DEADLINE - 1]), db = parseWhen_(b[C.DEADLINE - 1]);
    return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
  });
}

function sortMasterByAssignee() {
  var C = CFG.MASTER.COL;
  sortMasterBy_(function (a, b) {
    return String(a[C.ASSIGNEE - 1]).localeCompare(String(b[C.ASSIGNEE - 1]), 'th');
  });
}

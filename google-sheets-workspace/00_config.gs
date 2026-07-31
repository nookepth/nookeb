/**
 * 00_config.gs — ค่าคงที่ทั้งระบบ (หนูเก็บ Task Workspace)
 *
 * ⚠️ สัญญากับระบบ sync ของหนูเก็บ (sheetsWorker):
 *   - แท็บ "งานของฉัน" คอลัมน์ A–J เป็นของ sync ห้ามระบบนี้เขียนทับ
 *     (ยกเว้นกรณีเดียว: แจก LOCAL id ให้แถวที่สร้างเองในชีต — sync ไม่รู้จัก id นั้น
 *     จึงไม่มีวันชนกัน)
 *   - sync หาแถวจากคอลัมน์ J (รหัสงาน, ซ่อนอยู่) — ห้ามลบ/ย้ายคอลัมน์นี้เด็ดขาด
 *   - sync ทาสีพื้นหลัง A–J ตามสถานะทุกครั้งที่ sync — เราจึงตกแต่งเฉพาะ K เป็นต้นไป
 *   - วันที่จาก sync เป็น "ข้อความ" รูปแบบ DD/MM/YYYY HH:mm (เวลาไทย) ไม่ใช่ date จริง
 */

var CFG = {
  TZ: 'Asia/Bangkok',
  LOCALE: 'th_TH',
  FONT: 'Sarabun',

  SHEETS: {
    MASTER: 'งานของฉัน',
    DASH: '📊 หน้าหลัก',
    PRIO: '⚡ ความสำคัญ',
    TRACK: '🔄 ติดตามสถานะ',
    TEAM: '👥 รายงานทีม',
    CAL: '🗓️ ปฏิทิน',
    ANA: '📈 วิเคราะห์',
    FORM: '📋 สั่งงาน',
    WEEKLY: '📅 สรุปรายสัปดาห์',
    CALC: '_CALC',
    SNAP: '_SNAPSHOT',
    CONF: '_CONFIG',
  },

  // ลำดับปุ่มในแถบนำทาง (row 1 ของทุกชีต)
  NAV: ['📊 หน้าหลัก', 'งานของฉัน', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
        '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📋 สั่งงาน', '📅 สรุปรายสัปดาห์'],

  COLORS: {
    PRIMARY: '#1B4F8A',   // deep navy
    ACCENT: '#2196F3',
    SUCCESS: '#4CAF50',
    WARNING: '#FF9800',
    DANGER: '#F44336',
    NEUTRAL: '#F5F7FA',
    HEADER_TEXT: '#FFFFFF',
    ROW_ALT: '#F0F4F8',
    BORDER: '#D5DCE4',
    TEXT: '#1F2937',
    MUTED: '#6B7280',
    URGENT_BG: '#FDECEA',
    SOON_BG: '#FFF3E0',
    OK_BG: '#FFFDE7',
    RELAX_BG: '#E8F5E9',
  },

  // สถานะต้องสะกดตรงกับที่ sheetsWorker เขียนทุกตัวอักษร
  STATUSES: ['รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'ตีกลับ', 'ยกเลิก', 'ลบแล้ว'],
  OPEN_STATUSES: ['รอดำเนินการ', 'กำลังทำ', 'รอตรวจ', 'ตีกลับ'],
  TYPES: ['งานเดียว', 'หลายรายการ', 'งานประจำ'],
  URGENCIES: ['🔴 ด่วนมาก', '🟠 ด่วน', '🟡 ปกติ', '🟢 ไม่รีบ'],
  DEFAULT_URGENCY: '🟡 ปกติ',

  STATUS_COLORS: {
    'รอดำเนินการ': '#90A4AE',
    'กำลังทำ': '#2196F3',
    'รอตรวจ': '#7E57C2',
    'เสร็จแล้ว': '#4CAF50',
    'ตีกลับ': '#F44336',
    'ยกเลิก': '#BDBDBD',
    'ลบแล้ว': '#BDBDBD',
  },

  MASTER: {
    FIRST_DATA_ROW: 2,
    // 1-based
    COL: {
      ORDER: 1, TITLE: 2, DESC: 3, TYPE: 4, DEADLINE: 5, CREATOR: 6,
      ASSIGNEE: 7, STATUS: 8, UPDATED: 9, TASK_ID: 10,
      URGENCY: 11, REMIND: 12, LINK: 13, NOTE: 14, LOG: 15,
    },
    LAST_COL: 15,
    SYNC_LAST_COL: 10, // A–J ของ sync
  },

  // _CALC layout (1-based) — ทุก view อ่านจากชีตนี้
  CALC: {
    COL: {
      ID: 1, TITLE: 2, TYPE: 3, DL_RAW: 4, DL_DATE: 5, CREATOR: 6, ASSIGNEES: 7,
      STATUS: 8, UPD_RAW: 9, URGENCY: 10, REMIND: 11, LINK: 12, NOTE: 13,
      DAYS_LEFT: 14, OVERDUE: 15, IS_OPEN: 16, URG_RANK: 17,
      FIRST_SEEN: 18, DONE_AT: 19, LAST_CHANGE: 20, UPD_DATE: 21,
      COUNTDOWN: 22, METER: 23, STUCK: 24, PIPELINE: 25,
    },
  },

  STUCK_DAYS: 3,          // งานค้างสถานะเดิมเกิน N วัน = คอขวด
  CAL_MAX_PER_DAY: 3,     // งานสูงสุดที่แสดงต่อช่องปฏิทิน
  LOCAL_ID_PREFIX: 'LOCAL-',
};

/** shorthand */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name) { return ss_().getSheetByName(name); }

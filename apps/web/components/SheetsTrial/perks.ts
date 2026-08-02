/**
 * What connecting Google Sheets actually gives you.
 *
 * ONE list, two readers: the trial offer panel (TrialBanner) and the plan gate
 * the settings page opens when entitlement has run out (UpgradeModal). They
 * used to be the same three lines written twice, which is how a user gets
 * promised one thing by the offer and a different thing by the upgrade card.
 *
 * Nothing here is a number the API serves — the trial LENGTH is
 * `SheetsTrialStatus.trialDays` and is interpolated at the call site, never
 * written into this list.
 */
export const SHEETS_PERKS = [
  'ซิงค์งานทั้งหมดไป Google Sheet อัตโนมัติ',
  'อัปเดตสถานะงานแบบ real-time',
  'แชร์ข้อมูลทีมผ่าน Google Drive ได้ทันที',
];

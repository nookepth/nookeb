/**
 * หนูเก็บลองงาน — the 14-day Google Sheets trial (migration 062).
 *
 * Wire shapes only. The API is the sole authority on every value here: the
 * trial length, whether it is active, and how many days are left are all
 * computed server-side from `users.sheets_trial_expires_at` and served, never
 * derived in the browser. A client-computed countdown would disagree with the
 * server the moment a device clock is wrong, and the server's answer is the one
 * that actually gates the feature.
 */

/**
 * The trial's state for one user.
 *
 * `isActive` and `isExpired` are BOTH false before activation — they are not
 * each other's negation. The three states are:
 *   never activated  activatedAt === null, isActive false, isExpired false
 *   running          isActive true,  isExpired false, daysRemaining >= 0
 *   finished         isActive false, isExpired true,  daysRemaining === 0
 */
export interface SheetsTrial {
  isActive: boolean;
  isExpired: boolean;
  /** ISO instant, or null if never activated. */
  activatedAt: string | null;
  /** ISO instant, or null if never activated. */
  expiresAt: string | null;
  /**
   * Whole days left, rounded UP, floored at 0. Null before activation.
   * Rounded up so the last partial day still reads "เหลืออีก 1 วัน" rather
   * than "0" while the trial is genuinely still working.
   */
  daysRemaining: number | null;
}

/**
 * Why (or whether) a user may use the Sheets integration right now.
 *
 * `source` is what the UI branches on: a premium subscriber and a trial user
 * both have `allowed: true`, but only the second should be shown a countdown.
 */
export interface SheetsAccess {
  allowed: boolean;
  /** 'plan' = entitled by แพ็กเกจ, 'trial' = entitled by หนูเก็บลองงาน. */
  source: 'plan' | 'trial' | null;
}

/**
 * The live Google connection, as far as the dashboard is allowed to know.
 *
 * NOTHING TOKEN-DERIVED APPEARS HERE, and nothing may be added that is. The
 * access and refresh tokens never leave the API — see
 * services/google-sheets.service.ts.
 */
export interface SheetsConnection {
  connected: boolean;
  sheetId: string | null;
  /** The spreadsheet's title. A constant (SHEET_TITLE), not user input. */
  sheetName: string | null;
  lastSyncAt: string | null;
  /**
   * When the trial's grant was revoked and the credential deleted, or null.
   * Set only by the expiry sweep — a manual disconnect leaves no stamp because
   * it leaves no row.
   */
  revokedAt: string | null;
}

/** `GET /integrations/google/trial` — everything the trial card renders from. */
export interface SheetsTrialStatus {
  /** ชื่อที่แสดงกับผู้ใช้ — served, never hard-coded in a component. */
  name: string;
  /** Trial length in days, from the API's single source of truth. */
  trialDays: number;
  trial: SheetsTrial;
  access: SheetsAccess;
  /**
   * May this user start the trial right now? False once used, and false while
   * their plan already includes Sheets — burning the one-shot on an entitlement
   * they already hold would leave them nothing for a later downgrade.
   */
  canActivate: boolean;
}

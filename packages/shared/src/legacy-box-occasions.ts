import type { LegacyBoxThemeId } from './legacy-box-themes';

/**
 * กล่องของขวัญ (Legacy Box) — the 7 fixed occasions (migration 034).
 *
 * An occasion is the create flow's step 0: it pre-selects a theme, pre-fills the
 * tagline picker, and is stored on the box row (`legacy_boxes.occasion`). It is
 * cosmetic/authoring metadata only — nothing about access or lifecycle keys off
 * it, and a box with occasion = NULL is perfectly valid (every box created
 * before this migration is exactly that).
 *
 * The ids must stay in sync with the `legacy_boxes.occasion` CHECK constraint,
 * the same rule THEMES follows. Icons live in the web app (this package is
 * JSX-free and shared with the API) — see the create flow's OccasionIcon.
 */

export interface LegacyBoxOccasion {
  /** Thai display name shown on the occasion card */
  name: string;
  /** one-line card subtitle */
  subtitle: string;
  /** theme pre-selected in the theme step when this occasion is picked */
  theme: LegacyBoxThemeId;
  /**
   * Taglines offered first for this occasion. The picker shows these, then
   * "ดูเพิ่มเติม" expands to ALL_TAGLINES. taglines[0] is the pre-selection.
   */
  taglines: readonly string[];
}

/** Shown on the reveal page when a box has no tagline (incl. every pre-034 box). */
export const DEFAULT_TAGLINE = 'ส่งมาด้วยความคิดถึง';

/** Matches the DB `tagline VARCHAR(60)` cap; the custom-tagline input enforces it client-side. */
export const MAX_TAGLINE_LENGTH = 60;

export const OCCASIONS = {
  birthday: {
    name: 'วันเกิด',
    subtitle: 'อวยพรวันเกิดแบบมีความหมาย',
    theme: 'rose',
    taglines: [
      'ส่งมาด้วยความปรารถนาดี',
      'สุขสันต์วันเกิดจากใจจริง',
      'ขอให้ปีนี้พิเศษมากๆ',
      'อวยพรด้วยรักและความห่วงใย',
    ],
  },
  anniversary: {
    name: 'วันครบรอบ',
    subtitle: 'ฉลองวันพิเศษของเราสองคน',
    theme: 'lilac',
    taglines: [
      'ด้วยความรักที่ไม่เปลี่ยนแปลง',
      'ขอบคุณที่อยู่เคียงข้างกันเสมอ',
      'ส่งมาพร้อมความทรงจำที่ดี',
      'ถึงคนที่ทำให้ทุกวันมีความหมาย',
    ],
  },
  surprise: {
    name: 'เซอร์ไพรส์แฟน',
    subtitle: 'เซอร์ไพรส์คนที่คุณรัก',
    theme: 'peach',
    taglines: [
      DEFAULT_TAGLINE,
      'ส่งมาด้วยความรักและห่วงใย',
      'คิดถึงอยู่เสมอ',
      'หวังว่าจะทำให้ยิ้มได้',
    ],
  },
  apology: {
    name: 'ขอโทษ / ง้อแฟน',
    subtitle: 'บอกสิ่งที่พูดไม่ออก',
    theme: 'sky',
    taglines: ['ส่งมาจากใจที่เสียใจ', 'ขอโทษที่ทำให้เจ็บปวด', 'หวังว่าเราจะเข้าใจกัน'],
  },
  longing: {
    name: 'คิดถึง / ไกลกัน',
    subtitle: 'ส่งความคิดถึงข้ามระยะทาง',
    theme: 'mint',
    taglines: ['ส่งมาจากอีกฝั่งของระยะทาง', 'ไม่ว่าจะอยู่ที่ไหน ก็คิดถึงเสมอ', 'ส่งมาพร้อมใจที่คิดถึง'],
  },
  family: {
    name: 'ของขวัญครอบครัว',
    subtitle: 'ขอบคุณพ่อแม่ พี่น้อง คนในครอบครัว',
    theme: 'butter',
    taglines: ['ด้วยความรักจากลูก', 'ขอบคุณที่เป็นครอบครัวที่ดีที่สุด', 'ส่งมาพร้อมความกตัญญู'],
  },
  special: {
    name: 'ของขวัญพิเศษ',
    subtitle: 'สำหรับทุกโอกาสพิเศษ',
    theme: 'rose',
    // the catch-all occasion reuses the general bank
    taglines: [
      DEFAULT_TAGLINE,
      'ส่งมาด้วยความรักและห่วงใย',
      'คิดถึงอยู่เสมอ',
      'หวังว่าจะทำให้ยิ้มได้',
    ],
  },
} as const satisfies Record<string, LegacyBoxOccasion>;

export type LegacyBoxOccasionId = keyof typeof OCCASIONS;

export const OCCASION_IDS = Object.keys(OCCASIONS) as LegacyBoxOccasionId[];

export function isOccasionId(value: string): value is LegacyBoxOccasionId {
  return Object.prototype.hasOwnProperty.call(OCCASIONS, value);
}

/**
 * Every tagline in the bank, de-duplicated, in occasion order — what the picker
 * shows once "ดูเพิ่มเติม" is tapped. The general bank is shared by `surprise`
 * and `special`, so de-duping here is load-bearing, not cosmetic: without it the
 * expanded list would render four chips with the same text and the same key.
 */
export const ALL_TAGLINES: readonly string[] = Array.from(
  new Set(OCCASION_IDS.flatMap((id) => OCCASIONS[id].taglines as readonly string[])),
);

/** The tagline pre-selected for an occasion (or the global default when unset). */
export function defaultTaglineFor(occasion: LegacyBoxOccasionId | null): string {
  return occasion ? OCCASIONS[occasion].taglines[0] : DEFAULT_TAGLINE;
}

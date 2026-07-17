/**
 * กล่องของขวัญ (Legacy Box) — the 6 fixed color themes (migration 033).
 *
 * Each theme is a complete palette: page gradient, card surface, accent,
 * readable text color, ribbon/box colors for the CSS gift box, and a glow.
 * The theme id is stored on the box row (`legacy_boxes.theme`) and must stay
 * in sync with the DB CHECK constraint.
 */

export interface LegacyBoxTheme {
  /** Thai display name shown in the theme picker */
  name: string;
  bg: string;
  card: string;
  accent: string;
  text: string;
  ribbon: string;
  boxColor: string;
  boxAccent: string;
  glow: string;
  gradient: string;
}

export const THEMES = {
  rose: {
    name: 'โรสพิงค์',
    bg: '#FFF0F3',
    card: '#FFE4EC',
    accent: '#E8507A',
    text: '#6B2D3E',
    ribbon: '#F4A0B8',
    boxColor: '#F9C5D1',
    boxAccent: '#E8507A',
    glow: 'rgba(232, 80, 122, 0.3)',
    gradient: 'linear-gradient(135deg, #FFF0F3 0%, #FFE4EC 50%, #FADADD 100%)',
  },
  mint: {
    name: 'มินต์กรีน',
    bg: '#F0FFF8',
    card: '#D4F5E9',
    accent: '#2ECC8F',
    text: '#1A5C42',
    ribbon: '#88E0C0',
    boxColor: '#B8F0D8',
    boxAccent: '#2ECC8F',
    glow: 'rgba(46, 204, 143, 0.3)',
    gradient: 'linear-gradient(135deg, #F0FFF8 0%, #D4F5E9 50%, #BDEFD8 100%)',
  },
  butter: {
    name: 'บัตเตอร์เยลโล่',
    bg: '#FFFDF0',
    card: '#FFF5C2',
    accent: '#E6B800',
    text: '#5C4A00',
    ribbon: '#FFE066',
    boxColor: '#FFE680',
    boxAccent: '#E6B800',
    glow: 'rgba(230, 184, 0, 0.3)',
    gradient: 'linear-gradient(135deg, #FFFDF0 0%, #FFF5C2 50%, #FFE999 100%)',
  },
  lilac: {
    name: 'ลิลาคม่วง',
    bg: '#F8F0FF',
    card: '#EDD5FF',
    accent: '#9B59D0',
    text: '#3D1A5C',
    ribbon: '#C899F0',
    boxColor: '#D9B3FF',
    boxAccent: '#9B59D0',
    glow: 'rgba(155, 89, 208, 0.3)',
    gradient: 'linear-gradient(135deg, #F8F0FF 0%, #EDD5FF 50%, #E0BBFF 100%)',
  },
  sky: {
    name: 'สกายบลู',
    bg: '#F0F8FF',
    card: '#C8E8FF',
    accent: '#2E86DE',
    text: '#0A3560',
    ribbon: '#78C4F5',
    boxColor: '#A8D8FF',
    boxAccent: '#2E86DE',
    glow: 'rgba(46, 134, 222, 0.3)',
    gradient: 'linear-gradient(135deg, #F0F8FF 0%, #C8E8FF 50%, #A8D4FF 100%)',
  },
  peach: {
    name: 'พีชคอรัล',
    bg: '#FFF5F0',
    card: '#FFD8C8',
    accent: '#E8622E',
    text: '#5C2010',
    ribbon: '#FFAA88',
    boxColor: '#FFC0A0',
    boxAccent: '#E8622E',
    glow: 'rgba(232, 98, 46, 0.3)',
    gradient: 'linear-gradient(135deg, #FFF5F0 0%, #FFD8C8 50%, #FFC0A0 100%)',
  },
} as const satisfies Record<string, LegacyBoxTheme>;

export type LegacyBoxThemeId = keyof typeof THEMES;

export const THEME_IDS = Object.keys(THEMES) as LegacyBoxThemeId[];

export const DEFAULT_THEME: LegacyBoxThemeId = 'rose';

export function isThemeId(value: string): value is LegacyBoxThemeId {
  return Object.prototype.hasOwnProperty.call(THEMES, value);
}

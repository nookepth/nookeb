/**
 * One share path for every "send this link" button (กล่องของขวัญ list card,
 * create-flow success screen).
 *
 * The share sheet is the Web Share API — on iOS/Android it already lists LINE,
 * Messages, Instagram etc., so there is nothing to wire per-target. Desktop
 * browsers without it (and any non-cancel failure) degrade to a clipboard copy.
 *
 * Callers must pass an ABSOLUTE https:// url — for boxes that is `shareUrl`
 * from the API, which is built from WEB_URL. Never `window.location.origin`:
 * the dashboard is reachable on preview domains and inside the LINE in-app
 * browser, and a link built from the current origin would send the recipient
 * to a host that isn't the product.
 */

export type ShareOutcome = 'shared' | 'copied' | 'error';

/** what a shared กล่องของขวัญ link says about itself in the native sheet */
export const BOX_SHARE_COPY = {
  title: 'มีกล่องของขวัญรอคุณอยู่',
  text: 'เปิดดูสิ่งที่ฉันส่งมาให้คุณ 🎁',
} as const;

export interface ShareCopy {
  title?: string;
  text?: string;
}

async function copyToClipboard(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share `url` through the native sheet, falling back to the clipboard.
 *
 * A user dismissing the sheet reports 'shared', not 'error': they saw the
 * sheet and chose to back out, so the button must not flash a failure at them.
 */
export async function shareOrCopy(url: string, copy: ShareCopy = {}): Promise<ShareOutcome> {
  const data = { ...copy, url };
  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    (typeof navigator.canShare !== 'function' || navigator.canShare(data));

  if (canShare) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared';
      // anything else: fall through to the clipboard
    }
  }

  return (await copyToClipboard(url)) ? 'copied' : 'error';
}

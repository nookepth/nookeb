/**
 * Flex JSON schema guard.
 *
 * LINE validates Flex JSON STRICTLY: an unknown property is not ignored — the
 * Messaging API rejects the whole message with a 400 and NOTHING is delivered.
 * Because `replyMessage` only logs the status code, that failure is invisible in
 * the logs, so a card can stop rendering for every user with no visible error.
 *
 * That is exactly what happened: the card redesign put the CSS-only property
 * `letterSpacing` into `cardHeader()`, the helper nearly every card uses, and
 * took out 19 of 26 cards at once. This test pins the property vocabulary so a
 * CSS habit can never silently do it again.
 *
 * The allow-lists below were checked against LINE's own validator:
 *   POST https://api.line.me/v2/bot/message/validate/reply  { messages: [msg] }
 * Adding a property here without confirming it there just moves the bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommandListFlexMessage,
  buildConvertToDocxResultCard,
  buildDiaryPromptCard,
  buildDiaryResultCard,
  buildDocxConvertFlexMessage,
  buildFeatureCarouselMessage,
  buildFinalizingFlexMessage,
  buildHelpFlexMessage,
  buildInviteFlexMessage,
  buildOnboardingCarouselMessage,
  buildPdfMergeFlexMessage,
  buildProgressFlexMessage,
  buildRedeemSuccessFlexMessage,
  buildReferralProgressFlexMessage,
  buildScanFlexMessage,
  buildTeamGuideFlexMessage,
} from './flex.service';

// ── LINE Flex property vocabulary ───────────────────────────────────────────
const COMMON = ['type', 'position', 'offsetTop', 'offsetBottom', 'offsetStart', 'offsetEnd'];

const ALLOWED: Record<string, readonly string[]> = {
  box: [...COMMON, 'layout', 'contents', 'backgroundColor', 'borderColor', 'borderWidth',
    'cornerRadius', 'width', 'maxWidth', 'height', 'maxHeight', 'flex', 'spacing', 'margin',
    'paddingAll', 'paddingTop', 'paddingBottom', 'paddingStart', 'paddingEnd', 'action',
    'justifyContent', 'alignItems', 'background'],
  text: [...COMMON, 'text', 'contents', 'adjustMode', 'flex', 'margin', 'size', 'align',
    'gravity', 'wrap', 'lineSpacing', 'maxLines', 'weight', 'color', 'action', 'style',
    'decoration', 'scaling'],
  span: ['type', 'text', 'color', 'size', 'weight', 'style', 'decoration'],
  button: [...COMMON, 'action', 'flex', 'margin', 'height', 'style', 'color', 'gravity',
    'adjustMode', 'scaling'],
  image: [...COMMON, 'url', 'flex', 'margin', 'align', 'gravity', 'size', 'aspectRatio',
    'aspectMode', 'backgroundColor', 'action', 'animated'],
  icon: [...COMMON, 'url', 'margin', 'size', 'aspectRatio', 'scaling'],
  separator: ['type', 'margin', 'color'],
  filler: ['type', 'flex'],
  video: ['type', 'url', 'previewUrl', 'altContent', 'aspectRatio', 'action'],
};

const GRADIENT_KEYS = ['type', 'angle', 'startColor', 'endColor', 'centerColor', 'centerPosition'];

/** Walk a component tree, asserting every property is one LINE actually accepts. */
function assertComponent(node: unknown, path: string): void {
  assert.ok(node && typeof node === 'object', `${path}: not an object`);
  const c = node as Record<string, unknown>;
  const type = c.type;
  assert.equal(typeof type, 'string', `${path}: missing "type"`);

  const allowed = ALLOWED[type as string];
  assert.ok(allowed, `${path}: unknown component type "${String(type)}"`);

  for (const key of Object.keys(c)) {
    assert.ok(
      allowed.includes(key),
      `${path}: "${key}" is NOT a valid LINE Flex property on a "${String(type)}" ` +
        `component — LINE rejects the entire message with a 400 and no card renders.`,
    );
  }

  if (c.background) {
    const bg = c.background as Record<string, unknown>;
    assert.equal(bg.type, 'linearGradient', `${path}.background: unsupported type`);
    for (const key of Object.keys(bg)) {
      assert.ok(GRADIENT_KEYS.includes(key), `${path}.background: unknown key "${key}"`);
    }
    for (const req of ['angle', 'startColor', 'endColor']) {
      assert.ok(bg[req] !== undefined, `${path}.background: missing "${req}"`);
    }
  }

  // A `uri` action must be https — LINE 400s the whole message otherwise.
  const action = c.action as Record<string, unknown> | undefined;
  if (action?.type === 'uri') {
    assert.match(String(action.uri), /^https:\/\//, `${path}.action.uri must be https://`);
  }

  for (const child of (Array.isArray(c.contents) ? c.contents : [])) {
    assertComponent(child, `${path}.contents[?]`);
  }
}

function assertBubble(bubble: unknown, path: string): void {
  const b = bubble as Record<string, unknown>;
  assert.equal(b.type, 'bubble', `${path}: expected a bubble`);
  for (const slot of ['header', 'hero', 'body', 'footer']) {
    if (b[slot]) assertComponent(b[slot], `${path}.${slot}`);
  }
}

function assertMessage(msg: unknown, name: string): void {
  const m = msg as Record<string, unknown>;
  assert.equal(m.type, 'flex', `${name}: not a flex message`);
  assert.ok(m.altText, `${name}: missing altText`);

  const contents = m.contents as Record<string, unknown>;
  if (contents.type === 'carousel') {
    const bubbles = contents.contents as unknown[];
    assert.ok(bubbles.length > 0 && bubbles.length <= 12, `${name}: carousel size out of range`);
    bubbles.forEach((b, i) => assertBubble(b, `${name}.contents[${i}]`));
  } else {
    assertBubble(contents, name);
  }

  // LINE hard-caps a Flex message at 10KB of JSON.
  const bytes = Buffer.byteLength(JSON.stringify(m.contents), 'utf8');
  assert.ok(bytes <= 10 * 1024, `${name}: ${bytes} bytes exceeds LINE's 10KB limit`);
}

const DASH = 'https://example.com/dashboard';
const referral = {
  referralCount: 3,
  currentTierGB: 2.5,
  nextTierGB: 4,
  neededForNext: 2,
  progressPercent: 60,
};

const cards: [string, unknown][] = [
  ['progress', buildProgressFlexMessage({ total: 5, username: 'ต้นข้าว', progressViewUrl: `${DASH}/p` })],
  ['progress:noName', buildProgressFlexMessage({ total: 1, username: null, progressViewUrl: `${DASH}/p` })],
  ['scan:opened', buildScanFlexMessage({ kind: 'opened' })],
  ['scan:page', buildScanFlexMessage({ kind: 'page', count: 3 })],
  ['pdfMerge:opened', buildPdfMergeFlexMessage({ kind: 'opened' })],
  ['pdfMerge:page', buildPdfMergeFlexMessage({ kind: 'page', count: 4 })],
  ['finalizing:scan', buildFinalizingFlexMessage({ kind: 'scan', count: 3, dashboardUrl: DASH })],
  ['finalizing:pdf', buildFinalizingFlexMessage({ kind: 'pdf', count: 4, dashboardUrl: DASH })],
  ['finalizing:merge', buildFinalizingFlexMessage({ kind: 'merge', count: 2, dashboardUrl: DASH })],
  ['docxConvert', buildDocxConvertFlexMessage()],
  ['docxResult:minimal', buildConvertToDocxResultCard({ docxFilename: 'a.docx', lockerUrl: DASH })],
  ['docxResult:full', buildConvertToDocxResultCard({
    docxFilename: 'b.docx', lockerUrl: DASH, originalFilename: 'IMG.jpg',
    documentType: 'invoice', fileSize: 248_320, pageCount: 2, convertedAt: new Date(),
    warning: 'เอกสารมีตารางซับซ้อน',
  })],
  ['diaryPrompt', buildDiaryPromptCard({ dateThai: '2 สิงหาคม 2569', nextDayNumber: 128 })],
  ['diaryResult', buildDiaryResultCard({ dayNumber: 128, dateThai: '2 สิงหาคม 2569', caption: 'ทดสอบ', diaryUrl: DASH })],
  ['diaryResult:noCaption', buildDiaryResultCard({ dayNumber: 129, dateThai: '3 สิงหาคม 2569', caption: '', diaryUrl: DASH })],
  ['invite', buildInviteFlexMessage({ ...referral, code: 'NOOK1234' })],
  ['referralProgress', buildReferralProgressFlexMessage(referral)],
  ['referralProgress:top', buildReferralProgressFlexMessage({
    referralCount: 5, currentTierGB: 4, nextTierGB: null, neededForNext: 0, progressPercent: 100,
  })],
  ['redeemSuccess', buildRedeemSuccessFlexMessage({ totalGB: 2.5, bonusGB: 0.5, dashboardUrl: DASH })],
  ['onboardingCarousel', buildOnboardingCarouselMessage()],
  ['featureCarousel', buildFeatureCarouselMessage()],
  ['teamGuide', buildTeamGuideFlexMessage()],
  ['help', buildHelpFlexMessage()],
  ['commandList', buildCommandListFlexMessage()],
];

for (const [name, message] of cards) {
  test(`flex schema: ${name} uses only properties LINE accepts`, () => {
    assertMessage(message, name);
  });
}

test('flex schema: letterSpacing never reappears in any card', () => {
  // Pinned by name as well as by the vocabulary check above: `letterSpacing` is
  // the specific CSS property that broke 19 of 26 cards, and it reads so
  // naturally next to the valid `lineSpacing` that it invites a repeat.
  for (const [name, message] of cards) {
    assert.ok(
      !JSON.stringify(message).includes('letterSpacing'),
      `${name}: letterSpacing is a CSS property, not a LINE Flex one — it 400s the message.`,
    );
  }
});

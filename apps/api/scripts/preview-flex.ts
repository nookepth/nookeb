/**
 * Dev-only Flex card preview dump.
 *
 * Calls every exported card builder in `services/flex.service.ts` with
 * representative mock data and writes the result to `flex-preview.json` at the
 * repo root, so the `contents` of any card can be pasted straight into
 * https://developers.line.biz/flex-simulator/
 *
 * Run:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/preview-flex.ts
 *
 * (flex.service.ts imports `config`, so the env file is required — the zod
 * schema in config.ts rejects a bare process.env.)
 *
 * The simulator takes ONE bubble/carousel at a time: paste the value of a
 * card's `contents` key, not the whole file.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
} from '../src/services/flex.service';

// ── Mock data ───────────────────────────────────────────────────────────────
// HTTPS everywhere on purpose: several builders degrade a `uri` action to plain
// text when the URL is not https (LINE rejects http), so localhost URLs would
// preview a card the user never actually sees.
const WEB = 'https://nookeb-web.vercel.app';
const DASHBOARD = `${WEB}/dashboard`;

/** Mid-ladder referral state — 3 redeemed, one tier reached, one still ahead. */
const referral = {
  referralCount: 3,
  currentTierGB: 2.5,
  nextTierGB: 4,
  neededForNext: 2,
  progressPercent: 60,
};

const cards: { name: string; note: string; message: unknown }[] = [
  // ── Upload / progress ─────────────────────────────────────────────────────
  {
    name: 'buildProgressFlexMessage',
    note: 'batch upload started (1-on-1 only)',
    message: buildProgressFlexMessage({
      total: 5,
      username: 'ต้นข้าว',
      progressViewUrl: 'https://api.nookeb.com/progress/batch_abc123/view',
    }),
  },
  {
    name: 'buildProgressFlexMessage:noName',
    note: 'same card when the LINE profile lookup fails (username null → "คุณ")',
    message: buildProgressFlexMessage({
      total: 1,
      username: null,
      progressViewUrl: 'https://api.nookeb.com/progress/batch_abc123/view',
    }),
  },

  // ── สแกน ──────────────────────────────────────────────────────────────────
  {
    name: 'buildScanFlexMessage:opened',
    note: 'หนูเก็บสแกน — session opened',
    message: buildScanFlexMessage({ kind: 'opened' }),
  },
  {
    name: 'buildScanFlexMessage:page',
    note: 'per-page confirmation after each photo',
    message: buildScanFlexMessage({ kind: 'page', count: 3 }),
  },

  // ── รวมไฟล์ ───────────────────────────────────────────────────────────────
  {
    name: 'buildPdfMergeFlexMessage:opened',
    note: 'หนูเก็บรวมไฟล์ — session opened',
    message: buildPdfMergeFlexMessage({ kind: 'opened' }),
  },
  {
    name: 'buildPdfMergeFlexMessage:page',
    note: 'per-file confirmation',
    message: buildPdfMergeFlexMessage({ kind: 'page', count: 4 }),
  },

  // ── "เสร็จ" → finalizing, one per session kind ────────────────────────────
  {
    name: 'buildFinalizingFlexMessage:scan',
    note: 'blue scan theme',
    message: buildFinalizingFlexMessage({ kind: 'scan', count: 3, dashboardUrl: DASHBOARD }),
  },
  {
    name: 'buildFinalizingFlexMessage:pdf',
    note: 'navy merge theme',
    message: buildFinalizingFlexMessage({ kind: 'pdf', count: 4, dashboardUrl: DASHBOARD }),
  },
  {
    name: 'buildFinalizingFlexMessage:merge',
    note: "legacy 'merge' sessions — nothing opens one any more, kept for back-compat",
    message: buildFinalizingFlexMessage({ kind: 'merge', count: 2, dashboardUrl: DASHBOARD }),
  },

  // ── แปลงไฟล์ ──────────────────────────────────────────────────────────────
  {
    name: 'buildDocxConvertFlexMessage',
    note: 'convert mode armed',
    message: buildDocxConvertFlexMessage(),
  },
  {
    name: 'buildConvertToDocxResultCard:full',
    note: 'every optional field populated',
    message: buildConvertToDocxResultCard({
      docxFilename: 'ใบเสร็จรับเงิน-2569.docx',
      lockerUrl: DASHBOARD,
      originalFilename: 'IMG_4821.jpg',
      documentType: 'invoice',
      fileSize: 248_320,
      pageCount: 2,
      convertedAt: new Date('2026-08-02T10:24:00+07:00'),
    }),
  },
  {
    name: 'buildConvertToDocxResultCard:minimal',
    note: 'retry-recovery path — only the stored filename is known',
    message: buildConvertToDocxResultCard({
      docxFilename: 'เอกสาร.docx',
      lockerUrl: DASHBOARD,
    }),
  },
  {
    name: 'buildConvertToDocxResultCard:warning',
    note: 'muted caution row',
    message: buildConvertToDocxResultCard({
      docxFilename: 'สัญญาเช่า.docx',
      lockerUrl: DASHBOARD,
      originalFilename: 'contract.pdf',
      documentType: 'contract',
      fileSize: 1_048_576,
      pageCount: 12,
      convertedAt: new Date('2026-08-02T10:24:00+07:00'),
      warning: 'เอกสารมีตารางซับซ้อน หน้าตาอาจเพี้ยนบ้างน้า',
    }),
  },

  // ── ไดอารี่ ───────────────────────────────────────────────────────────────
  {
    name: 'buildDiaryPromptCard',
    note: 'diary mode armed',
    message: buildDiaryPromptCard({ dateThai: '2 สิงหาคม 2569', nextDayNumber: 128 }),
  },
  {
    name: 'buildDiaryResultCard:withCaption',
    note: 'entry saved, caption present',
    message: buildDiaryResultCard({
      dayNumber: 128,
      dateThai: '2 สิงหาคม 2569',
      caption: 'วันนี้กินข้าวกับแม่ที่บ้าน อร่อยมาก',
      diaryUrl: `${DASHBOARD}/diary`,
    }),
  },
  {
    name: 'buildDiaryResultCard:noCaption',
    note: 'photo only — the caption block should be absent',
    message: buildDiaryResultCard({
      dayNumber: 129,
      dateThai: '3 สิงหาคม 2569',
      caption: '',
      diaryUrl: `${DASHBOARD}/diary`,
    }),
  },

  // ── Referral ──────────────────────────────────────────────────────────────
  {
    name: 'buildInviteFlexMessage',
    note: 'หนูเก็บเชิญ — the user asks for their own code',
    message: buildInviteFlexMessage({ ...referral, code: 'NOOK1234' }),
  },
  {
    name: 'buildReferralProgressFlexMessage:generic',
    note: 'generic progress line (count 3)',
    message: buildReferralProgressFlexMessage(referral),
  },
  {
    name: 'buildReferralProgressFlexMessage:first',
    note: 'milestone copy for count 1',
    message: buildReferralProgressFlexMessage({
      referralCount: 1,
      currentTierGB: 1,
      nextTierGB: 2.5,
      neededForNext: 2,
      progressPercent: 33,
    }),
  },
  {
    name: 'buildReferralProgressFlexMessage:top',
    note: 'top of the ladder (count 5) — nextTierGB null',
    message: buildReferralProgressFlexMessage({
      referralCount: 5,
      currentTierGB: 4,
      nextTierGB: null,
      neededForNext: 0,
      progressPercent: 100,
    }),
  },
  {
    name: 'buildRedeemSuccessFlexMessage',
    note: 'pushed to the referee right after redeeming',
    message: buildRedeemSuccessFlexMessage({ totalGB: 2.5, bonusGB: 0.5, dashboardUrl: DASHBOARD }),
  },

  // ── Static / no-arg cards ─────────────────────────────────────────────────
  {
    name: 'buildOnboardingCarouselMessage',
    note: 'carousel — follow / join. Paste the whole `contents` (type: carousel)',
    message: buildOnboardingCarouselMessage(),
  },
  {
    name: 'buildFeatureCarouselMessage',
    note: 'carousel — หนูเก็บเพิ่มเติม in 1-on-1',
    message: buildFeatureCarouselMessage(),
  },
  {
    name: 'buildTeamGuideFlexMessage',
    note: 'หนูเก็บคู่มือทีม',
    message: buildTeamGuideFlexMessage(),
  },
  {
    name: 'buildHelpFlexMessage',
    note: 'หนูเก็บวิธีใช้',
    message: buildHelpFlexMessage(),
  },
  {
    name: 'buildCommandListFlexMessage',
    note: 'หนูเก็บคำสั่ง',
    message: buildCommandListFlexMessage(),
  },
];

const out = resolve(process.cwd(), '../../flex-preview.json');

writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      howTo:
        'Paste ONE card\'s "message.contents" value into https://developers.line.biz/flex-simulator/ — the simulator takes a single bubble or carousel, not this whole file.',
      cards,
    },
    null,
    2,
  ),
  'utf8',
);

// eslint-disable-next-line no-console
console.log(`[preview-flex] wrote ${cards.length} cards → ${out}`);
for (const c of cards) {
  // eslint-disable-next-line no-console
  console.log(`  • ${c.name} — ${c.note}`);
}

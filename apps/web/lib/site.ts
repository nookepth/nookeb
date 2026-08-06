/**
 * Canonical public origin of the web app — used for SEO metadata
 * (metadataBase / sitemap / robots / JSON-LD). Override with
 * NEXT_PUBLIC_SITE_URL when a custom domain is added.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://nookeb-web.vercel.app';

/** Official channels (see marketing/nookeb-brand-content-playbook.docx, ภาคผนวก A). */
export const LINE_ADD_FRIEND_URL = 'https://lin.ee/nbhqZ2C';
/**
 * Support / ติดต่อหนูเก็บ — the SAME link the bot replies with in chat
 * (SUPPORT_TEXT in apps/api/src/routes/webhook/line.ts). Distinct from
 * LINE_ADD_FRIEND_URL, which is the marketing add-friend link.
 */
export const LINE_SUPPORT_URL = 'https://lin.ee/Z0ewNYb';
export const LINE_ID = '@nookeb';
export const INSTAGRAM_URL = 'https://www.instagram.com/nookeb.official';
export const TIKTOK_URL = 'https://www.tiktok.com/@nookebinwza';

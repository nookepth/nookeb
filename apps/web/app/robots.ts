import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Private, auth-gated, or tokened surfaces — keep out of search results.
        disallow: ['/dashboard', '/admin', '/auth/', '/join', '/share/', '/api-proxy/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

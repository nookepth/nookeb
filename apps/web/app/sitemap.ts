import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

/** Only the public landing page is indexable — dashboard/join/share are private. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}

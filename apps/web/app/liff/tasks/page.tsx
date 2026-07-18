'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import styles from './tasks.module.css';
import { initLiff } from '../../../lib/liff';

/**
 * LIFF endpoint root — LINE's redirect flow ALWAYS lands here first. Opening
 * https://liff.line.me/{id}/create/single does a primary redirect to the
 * registered endpoint URL (/liff/tasks) with the extra path carried in
 * ?liff.state=%2Fcreate%2Fsingle; only after liff.init() runs on THIS page
 * does the SDK perform the secondary redirect to the real route. Without a
 * page at this exact path, Next.js 404s before the SDK ever loads — which is
 * how every Flex-card deep link (create carousel and ดูงาน buttons) broke.
 *
 * liff.init() normally executes the secondary redirect itself; the manual
 * liff.state resolution below is the fallback for LIFF-less dev mode and any
 * init failure (the target page re-runs initLiff and renders its own error).
 */
export default function LiffTasksEndpointPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('liff.state');
    // liff.state is a path relative to the endpoint URL. Require a single
    // leading slash so a crafted ?liff.state=//evil.com can't leave the app.
    const dest =
      state && state.startsWith('/') && !state.startsWith('//')
        ? `/liff/tasks${state}`
        : `/liff/tasks/create${window.location.search}`;

    initLiff()
      .catch(() => {
        // swallow — the destination page shows its own connect error
      })
      .then(() => router.replace(dest));
  }, [router]);

  // Only visible for the moment before the secondary redirect fires.
  return (
    <main className={styles.page} style={{ paddingBottom: 24 }}>
      <div className={styles.cardList}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.card} style={{ height: 84 }}>
            <div className={styles.skeletonBar} style={{ width: '55%', marginBottom: 10 }} />
            <div className={styles.skeletonBar} style={{ width: '80%' }} />
          </div>
        ))}
      </div>
    </main>
  );
}

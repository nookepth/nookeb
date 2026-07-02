'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginWithLineCode, setSession } from '@/lib/api';
import { lineLoginRedirectUri, validateLineLoginState } from '@/lib/auth';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const code = params.get('code');
    const state = params.get('state');

    if (!code || !validateLineLoginState(state)) {
      setError('การเข้าสู่ระบบไม่ถูกต้อง ลองใหม่อีกครั้ง');
      return;
    }

    loginWithLineCode(code, lineLoginRedirectUri())
      .then((res) => {
        setSession(res.accessToken, res.defaultSpaceId);
        const next = sessionStorage.getItem('nookeb_post_login');
        sessionStorage.removeItem('nookeb_post_login');
        router.replace(next ?? '/dashboard');
      })
      .catch(() => setError('เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง'));
  }, [params, router]);

  return (
    <div className="center-page">
      {error ? (
        <>
          <p>{error}</p>
          <a className="btn" href="/dashboard">
            กลับหน้าหลัก
          </a>
        </>
      ) : (
        <p>กำลังเข้าสู่ระบบ...</p>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div className="center-page">กำลังเข้าสู่ระบบ...</div>}>
      <CallbackInner />
    </Suspense>
  );
}

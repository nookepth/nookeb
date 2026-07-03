'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, getToken, joinSpace } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';

function JoinInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<'working' | 'need-login' | 'error' | 'done'>('working');
  const [spaceName, setSpaceName] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      return;
    }
    if (!getToken()) {
      // Remember where to return after LINE login
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('nookeb_post_login', window.location.pathname + window.location.search);
      }
      setStatus('need-login');
      return;
    }
    joinSpace(token)
      .then((space) => {
        setSpaceName(space.name);
        setStatus('done');
        setTimeout(() => router.push('/dashboard'), 1200);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setStatus('need-login');
        else setStatus('error');
      });
  }, [token, router]);

  return (
    <div className="center-page">
      <h1>หนูเก็บ</h1>
      {status === 'working' && <p>กำลังเข้าร่วมพื้นที่...</p>}
      {status === 'need-login' && (
        <>
          <p>เข้าสู่ระบบด้วย LINE ก่อนเพื่อเข้าร่วมพื้นที่นี้</p>
          <button className="btn" onClick={startLineLogin}>
            เข้าสู่ระบบด้วย LINE
          </button>
        </>
      )}
      {status === 'done' && <p>เข้าร่วม “{spaceName}” แล้ว กำลังพาไปที่คลังไฟล์...</p>}
      {status === 'error' && <p>ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว</p>}
    </div>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<div className="center-page">กำลังโหลด...</div>}>
      <JoinInner />
    </Suspense>
  );
}

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { acceptTeamInvite, ApiError, getToken } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';

function JoinInner() {
  const params = useSearchParams();
  const teamInviteToken = params.get('team_invite');
  const [status, setStatus] = useState<'working' | 'need-login' | 'error' | 'pending'>('working');
  const [teamName, setTeamName] = useState('');

  useEffect(() => {
    if (!teamInviteToken) {
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
    acceptTeamInvite(teamInviteToken)
      .then((res) => {
        // Joining now needs owner/admin approval — the user waits, no redirect.
        setTeamName(res.teamName);
        setStatus('pending');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setStatus('need-login');
        else setStatus('error');
      });
  }, [teamInviteToken]);

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
      {status === 'pending' && (
        <>
          <p>ส่งคำขอเข้าทีมแล้วน้า รอเจ้าของทีมอนุมัติก่อนน้า</p>
          {teamName && <p className="team-card-meta">ทีม: {teamName}</p>}
        </>
      )}
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

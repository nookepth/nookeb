'use client';

import { useEffect, useState } from 'react';
import {
  ApiError,
  getToken,
  listAdminSpaces,
  listAdminUsers,
  setUserQuota,
  type AdminSpace,
  type AdminUser,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [spaces, setSpaces] = useState<AdminSpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [u, s] = await Promise.all([listAdminUsers(), listAdminSpaces()]);
      setUsers(u.users);
      setSpaces(s.spaces);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError('คุณไม่มีสิทธิ์เข้าหน้าผู้ดูแล');
      else if (err instanceof ApiError && err.status === 401) setError('กรุณาเข้าสู่ระบบก่อน');
      else setError('โหลดข้อมูลไม่สำเร็จ');
    }
  }

  useEffect(() => {
    if (!getToken()) {
      setError('กรุณาเข้าสู่ระบบก่อน');
      return;
    }
    void load();
  }, []);

  async function editQuota(u: AdminUser): Promise<void> {
    const gb = window.prompt(`ตั้งโควตา (GB) สำหรับ ${u.displayName ?? u.id}`, String(u.storageLimit / (1024 ** 3)));
    if (!gb) return;
    const bytes = Math.round(parseFloat(gb) * 1024 ** 3);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      alert('กรุณาใส่ตัวเลขที่ถูกต้อง');
      return;
    }
    try {
      await setUserQuota(u.id, bytes);
      await load();
    } catch {
      alert('อัปเดตโควตาไม่สำเร็จ');
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>หนูเก็บ — ผู้ดูแล</h1>
        <a className="btn secondary" href="/dashboard">
          กลับคลังไฟล์
        </a>
      </header>
      <main className="container">
        {error && <p className="empty-state">{error}</p>}

        {!error && (
          <>
            <h2 className="admin-h2">ผู้ใช้ ({users?.length ?? 0})</h2>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>แผน</th>
                    <th>ไฟล์</th>
                    <th>ใช้ไป</th>
                    <th>โควตา</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(users ?? []).map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.displayName ?? '—'} {u.isAdmin && <span className="tag-chip">admin</span>}
                      </td>
                      <td>{u.plan}</td>
                      <td>{u.fileCount}</td>
                      <td>{formatBytes(u.storageUsed)}</td>
                      <td>{formatBytes(u.storageLimit)}</td>
                      <td>
                        <button className="btn secondary" onClick={() => void editQuota(u)}>
                          แก้โควตา
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 className="admin-h2">พื้นที่ ({spaces?.length ?? 0})</h2>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>ประเภท</th>
                    <th>สมาชิก</th>
                    <th>ไฟล์</th>
                    <th>ขนาด</th>
                  </tr>
                </thead>
                <tbody>
                  {(spaces ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.type === 'personal' ? 'ส่วนตัว' : 'ทีม'}</td>
                      <td>{s.memberCount}</td>
                      <td>{s.fileCount}</td>
                      <td>{formatBytes(s.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TeamDto } from '@nookeb/shared';
import { ApiError, createTeam, getToken, listTeams } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { TeamStorageBar } from '@/components/TeamStorageBar';

export default function TeamsPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<TeamDto[] | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeams(await listTeams());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('โหลดรายชื่อทีมไม่สำเร็จน้า ลองรีเฟรชอีกทีน้า');
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setNeedsLogin(true);
      return;
    }
    void load();
  }, [load]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const team = await createTeam(name);
      setCreateOpen(false);
      setNewName('');
      router.push(`/dashboard/teams/${team.id}`);
    } catch {
      setError('สร้างทีมไม่สำเร็จน้า ลองใหม่อีกทีน้า');
      setCreating(false);
    }
  }

  if (needsLogin) {
    return (
      <div className="center-page">
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE ก่อนเพื่อจัดการทีมน้า</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  return (
    <div className="teams-page">
      <a className="team-back" href="/dashboard">
        ← กลับไปคลังไฟล์
      </a>
      <div className="teams-head">
        <h1 className="teams-title">ทีมของฉัน</h1>
        <button className="btn" onClick={() => setCreateOpen(true)}>
          สร้างทีมใหม่
        </button>
      </div>

      {error && <p className="team-empty">{error}</p>}

      {teams === null && !error && <p className="team-empty">กำลังโหลดทีมอยู่น้า...</p>}

      {teams !== null && teams.length === 0 && (
        <p className="team-empty">
          ยังไม่มีทีมเลยน้า กด &quot;สร้างทีมใหม่&quot; เพื่อเริ่มใช้พื้นที่ร่วมกับเพื่อน ๆ ได้เลยน้า
        </p>
      )}

      {teams !== null && teams.length > 0 && (
        <div className="teams-grid">
          {teams.map((team) => (
            <div key={team.id} className="team-card">
              <div>
                <div className="team-card-name">{team.name}</div>
                <div className="team-card-meta">
                  สมาชิก {team.memberCount ?? 1} คน
                  {team.role ? ` · คุณเป็น ${roleLabel(team.role)}` : ''}
                </div>
              </div>
              <TeamStorageBar used={team.storageUsed} limit={team.storageLimit} />
              <button
                className="btn secondary"
                onClick={() => router.push(`/dashboard/teams/${team.id}`)}
              >
                จัดการ
              </button>
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <div className="modal-overlay" onClick={() => !creating && setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">สร้างทีมใหม่</div>
            <input
              className="team-name-input"
              placeholder="ชื่อทีม เช่น ทีมบัญชี"
              value={newName}
              maxLength={120}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <button className="btn" disabled={!newName.trim() || creating} onClick={handleCreate}>
              {creating ? 'กำลังสร้างทีม...' : 'สร้างทีม'}
            </button>
            <button className="btn ghost" disabled={creating} onClick={() => setCreateOpen(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'เจ้าของทีม';
  if (role === 'admin') return 'แอดมิน';
  return 'สมาชิก';
}

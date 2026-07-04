'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ApiError,
  bindTeamGroup,
  createTeamInvite,
  deleteTeam,
  getMe,
  getTeamDetail,
  getToken,
  removeTeamMember,
  unbindTeamGroup,
  type TeamDetailResponse,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { TeamStorageBar } from '@/components/TeamStorageBar';

function roleLabel(role: string): string {
  if (role === 'owner') return 'เจ้าของทีม';
  if (role === 'admin') return 'แอดมิน';
  return 'สมาชิก';
}

/** Full, shareable invite URL — same shape the /join page reads. */
function buildInviteUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/join?team_invite=${token}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function TeamDetailPage() {
  const router = useRouter();
  const { teamId } = useParams<{ teamId: string }>();

  const [detail, setDetail] = useState<TeamDetailResponse | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteBusy, setInviteBusy] = useState(false);
  const [groupIdInput, setGroupIdInput] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getTeamDetail(teamId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setError('ไม่พบทีมนี้ หรือคุณไม่ได้เป็นสมาชิกของทีมน้า');
      } else setError('โหลดข้อมูลทีมไม่สำเร็จน้า ลองรีเฟรชอีกทีน้า');
    }
  }, [teamId]);

  useEffect(() => {
    if (!getToken()) {
      setNeedsLogin(true);
      return;
    }
    void load();
    getMe()
      .then((me) => setMyUserId(me.id))
      .catch(() => {});
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3500);
  };

  async function handleInvite() {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      const invite = await createTeamInvite(teamId);
      await navigator.clipboard.writeText(buildInviteUrl(invite.token)).catch(() => {});
      flash('คัดลอกลิงก์แล้วน้า ส่งให้เพื่อนได้เลย ✓');
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? `เชิญไม่สำเร็จน้า: ${err.message}` : 'เชิญไม่สำเร็จน้า ลองใหม่อีกทีน้า');
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleCopyInvite(inviteId: string, token: string) {
    await navigator.clipboard.writeText(buildInviteUrl(token)).catch(() => {});
    setCopiedInviteId(inviteId);
    setTimeout(() => setCopiedInviteId((cur) => (cur === inviteId ? null : cur)), 2000);
  }

  async function handleLeaveTeam() {
    if (leaveBusy || !myUserId) return;
    setLeaveBusy(true);
    try {
      await removeTeamMember(teamId, myUserId);
      router.push('/dashboard/teams');
    } catch (err) {
      setConfirmLeave(false);
      setLeaveBusy(false);
      flash(err instanceof ApiError ? `ออกจากทีมไม่สำเร็จน้า: ${err.message}` : 'ออกจากทีมไม่สำเร็จน้า');
    }
  }

  async function handleRemoveMember(userId: string, name: string | null) {
    if (!window.confirm(`เอา "${name ?? 'สมาชิกคนนี้'}" ออกจากทีมจริง ๆ ใช่ไหมน้า?`)) return;
    setRemovingUserId(userId);
    try {
      await removeTeamMember(teamId, userId);
      flash('เอาสมาชิกออกจากทีมแล้วน้า');
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? `ลบไม่สำเร็จน้า: ${err.message}` : 'ลบไม่สำเร็จน้า');
    } finally {
      setRemovingUserId(null);
    }
  }

  async function handleBind() {
    const gid = groupIdInput.trim();
    if (!gid || bindBusy) return;
    setBindBusy(true);
    try {
      await bindTeamGroup(teamId, gid);
      setGroupIdInput('');
      flash('ผูกกลุ่ม LINE กับทีมแล้วน้า ไฟล์จากกลุ่มนี้จะเข้าพื้นที่ทีมเลย');
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? `ผูกกลุ่มไม่สำเร็จน้า: ${err.message}` : 'ผูกกลุ่มไม่สำเร็จน้า');
    } finally {
      setBindBusy(false);
    }
  }

  async function handleUnbind(lineGroupId: string) {
    if (!window.confirm('ยกเลิกการผูกกลุ่มนี้จริง ๆ ใช่ไหมน้า? ไฟล์ใหม่จากกลุ่มจะไม่เข้าทีมแล้วนะ')) return;
    try {
      await unbindTeamGroup(teamId, lineGroupId);
      flash('ยกเลิกการผูกกลุ่มแล้วน้า');
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? `ยกเลิกไม่สำเร็จน้า: ${err.message}` : 'ยกเลิกไม่สำเร็จน้า');
    }
  }

  async function handleDeleteTeam() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteTeam(teamId);
      router.push('/dashboard/teams');
    } catch (err) {
      setConfirmDelete(false);
      setDeleteBusy(false);
      flash(err instanceof ApiError ? `ลบทีมไม่สำเร็จน้า: ${err.message}` : 'ลบทีมไม่สำเร็จน้า');
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

  if (error) {
    return (
      <div className="teams-page">
        <a className="team-back" href="/dashboard/teams">
          ← กลับไปหน้าทีม
        </a>
        <p className="team-empty">{error}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="teams-page">
        <p className="team-empty">กำลังโหลดข้อมูลทีมอยู่น้า...</p>
      </div>
    );
  }

  const { team, members, storage, invites, lineGroups } = detail;
  const myRole = team.role ?? 'member';
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  return (
    <div className="teams-page">
      <a className="team-back" href="/dashboard/teams">
        ← กลับไปหน้าทีม
      </a>

      <div className="teams-head">
        <h1 className="teams-title">{team.name}</h1>
        <span className={`role-badge ${myRole}`}>{roleLabel(myRole)}</span>
      </div>

      <TeamStorageBar used={storage.used} limit={storage.limit} />

      {notice && <p className="team-card-meta">{notice}</p>}

      {/* Members */}
      <section className="team-section">
        <div className="team-section-title">สมาชิก ({members.length})</div>
        <table className="team-table">
          <thead>
            <tr>
              <th></th>
              <th>ชื่อ</th>
              <th>บทบาท</th>
              <th>เข้าร่วมเมื่อ</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain not configured
                    <img className="avatar" src={m.pictureUrl} alt="" />
                  ) : (
                    <span className="avatar-fallback">{(m.displayName ?? 'ห').charAt(0)}</span>
                  )}
                </td>
                <td>{m.displayName ?? 'ผู้ใช้'}</td>
                <td>
                  <span className={`role-badge ${m.role}`}>{roleLabel(m.role)}</span>
                </td>
                <td>{formatDate(m.joinedAt)}</td>
                {canManage && (
                  <td>
                    {m.role !== 'owner' && (
                      <button
                        className="btn danger small"
                        disabled={removingUserId === m.userId}
                        onClick={() => handleRemoveMember(m.userId, m.displayName)}
                      >
                        ลบออกจากทีม
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!isOwner && (
          <button className="btn secondary small leave-team-btn" onClick={() => setConfirmLeave(true)}>
            ออกจากทีม
          </button>
        )}
      </section>

      {/* Invites */}
      {canManage && (
        <section className="team-section">
          <div className="team-section-title">เชิญสมาชิก</div>
          <button className="btn" disabled={inviteBusy} onClick={handleInvite}>
            {inviteBusy ? 'กำลังสร้างลิงก์...' : 'เชิญสมาชิก (สร้างลิงก์ + คัดลอก)'}
          </button>
          {invites.length > 0 && (
            <>
              <div className="team-card-meta">ลิงก์เชิญที่ยังใช้ได้:</div>
              {invites.map((inv) => (
                <div key={inv.id} className="invite-row">
                  <span className="invite-url" title={buildInviteUrl(inv.token)}>
                    {buildInviteUrl(inv.token)}
                  </span>
                  <div className="invite-row-right">
                    <button
                      className="btn ghost small invite-copy"
                      onClick={() => handleCopyInvite(inv.id, inv.token)}
                      aria-label="คัดลอกลิงก์เชิญ"
                    >
                      {copiedInviteId === inv.id ? 'คัดลอกแล้ว ✓' : '📋 คัดลอก'}
                    </button>
                    <span className="team-card-meta">หมดอายุ {formatDate(inv.expiresAt)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {/* LINE groups */}
      <section className="team-section">
        <div className="team-section-title">กลุ่ม LINE ที่ผูกกับทีม</div>
        {lineGroups.length === 0 && (
          <div className="team-card-meta">
            ยังไม่ได้ผูกกลุ่มเลยน้า ผูกกลุ่มแล้วไฟล์ที่ส่งในกลุ่มจะเข้าพื้นที่ทีมอัตโนมัติเลย
          </div>
        )}
        {lineGroups.map((g) => (
          <div key={g.id} className="group-row">
            <span className="group-id">{g.lineGroupId}</span>
            {canManage && (
              <button className="btn ghost small" onClick={() => handleUnbind(g.lineGroupId)}>
                ยกเลิกการผูก
              </button>
            )}
          </div>
        ))}
        <div className="bind-form">
          <input
            placeholder="วาง LINE Group ID เช่น C1234567890..."
            value={groupIdInput}
            onChange={(e) => setGroupIdInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleBind()}
          />
          <button className="btn secondary" disabled={!groupIdInput.trim() || bindBusy} onClick={handleBind}>
            ผูกกลุ่ม
          </button>
        </div>
      </section>

      {/* Danger zone */}
      {isOwner && (
        <section className="team-section danger-zone">
          <div className="team-section-title">โซนอันตราย</div>
          <div className="team-card-meta">
            ลบทีมแล้วสมาชิกจะเข้าพื้นที่ทีมไม่ได้อีก ไฟล์จะกลับไปเป็นไฟล์ปกติ (ไม่ถูกลบ) น้า
          </div>
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>
            ลบทีม
          </button>
        </section>
      )}

      {confirmLeave && (
        <div className="modal-overlay" onClick={() => !leaveBusy && setConfirmLeave(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">ออกจากทีม “{team.name}” ใช่ไหมน้า?</div>
            <p className="team-card-meta">ไฟล์ของทีมจะยังอยู่ในทีม ไม่ถูกลบน้า</p>
            <button className="btn danger" disabled={leaveBusy} onClick={handleLeaveTeam}>
              {leaveBusy ? 'กำลังออกจากทีม...' : 'ยืนยันออกจากทีม'}
            </button>
            <button className="btn ghost" disabled={leaveBusy} onClick={() => setConfirmLeave(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => !deleteBusy && setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">ลบทีม “{team.name}” จริง ๆ ใช่ไหมน้า?</div>
            <p className="team-card-meta">
              การลบทีมย้อนกลับไม่ได้นะ สมาชิกทุกคนจะออกจากทีม และกลุ่ม LINE ที่ผูกไว้จะถูกยกเลิกทั้งหมดน้า
            </p>
            <button className="btn danger" disabled={deleteBusy} onClick={handleDeleteTeam}>
              {deleteBusy ? 'กำลังลบทีม...' : 'ยืนยันลบทีม'}
            </button>
            <button className="btn ghost" disabled={deleteBusy} onClick={() => setConfirmDelete(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

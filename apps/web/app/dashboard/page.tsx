'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FileDto, FolderDto, SpaceDto, TagDto } from '@nookeb/shared';
import {
  ApiError,
  clearSession,
  createFolder,
  createInvite,
  createSpace,
  createTag,
  deleteFolder,
  getGoogleAuthUrl,
  getGoogleStatus,
  getMe,
  getSpaceId,
  getToken,
  getUsage,
  listFiles,
  listFolders,
  listSpaces,
  listTags,
  type GoogleStatus,
  type UsageResponse,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { FileGrid } from '@/components/FileGrid';
import { UsageBar } from '@/components/UsageBar';

export default function DashboardPage() {
  const [files, setFiles] = useState<FileDto[] | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [spaces, setSpaces] = useState<SpaceDto[]>([]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [drive, setDrive] = useState<GoogleStatus | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentFolder, setCurrentFolder] = useState<FolderDto | null>(null);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);

  const currentSpace = spaces.find((s) => s.id === spaceId) ?? null;
  const canInvite = currentSpace?.type === 'team' && (currentSpace.role === 'owner' || currentSpace.role === 'admin');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Load the space list once, and pick a default space
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setNeedsLogin(true);
      return;
    }
    listSpaces()
      .then(({ spaces }) => {
        setSpaces(spaces);
        setSpaceId((prev) => prev ?? getSpaceId() ?? spaces[0]?.id ?? null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      });
    getMe().then((me) => setIsAdmin(me.isAdmin)).catch(() => {});
    getGoogleStatus().then(setDrive).catch(() => {});

    // Returning from the Google OAuth flow
    const params = new URLSearchParams(window.location.search);
    if (params.get('drive') === 'connected') {
      getGoogleStatus().then(setDrive).catch(() => {});
      window.history.replaceState({}, '', '/dashboard');
    } else if (params.get('drive') === 'error') {
      alert('เชื่อม Google Drive ไม่สำเร็จ ลองใหม่อีกครั้ง');
      window.history.replaceState({}, '', '/dashboard');
    }
  }, []);

  const load = useCallback(async () => {
    const token = getToken();
    if (!token || !spaceId) {
      if (!token) setNeedsLogin(true);
      return;
    }
    try {
      const [fileRes, folderRes, tagRes] = await Promise.all([
        listFiles(spaceId, {
          search: debouncedSearch || undefined,
          folderId: currentFolder?.id,
          tagId: activeTagId ?? undefined,
        }),
        listFolders(spaceId),
        listTags(spaceId),
      ]);
      setFiles(fileRes.files);
      setFolders(folderRes.folders);
      setTags(tagRes.tags);
      setError(null);
      getUsage().then(setUsage).catch(() => {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsLogin(true);
      } else {
        setError('โหลดรายการไฟล์ไม่สำเร็จ ลองรีเฟรชอีกครั้ง');
      }
    }
  }, [spaceId, debouncedSearch, currentFolder, activeTagId]);

  useEffect(() => {
    void load();
  }, [load]);

  function switchSpace(id: string): void {
    setSpaceId(id);
    setCurrentFolder(null);
    setActiveTagId(null);
    setSearch('');
    setFiles(null);
  }

  async function handleCreateTeam(): Promise<void> {
    const name = window.prompt('ตั้งชื่อพื้นที่ทีมใหม่');
    if (!name?.trim()) return;
    try {
      const space = await createSpace(name.trim());
      const refreshed = await listSpaces();
      setSpaces(refreshed.spaces);
      switchSpace(space.id);
    } catch {
      alert('สร้างพื้นที่ทีมไม่สำเร็จ');
    }
  }

  async function handleConnectDrive(): Promise<void> {
    try {
      const { url } = await getGoogleAuthUrl();
      window.location.href = url;
    } catch {
      alert('เริ่มการเชื่อม Google Drive ไม่สำเร็จ');
    }
  }

  async function handleInvite(): Promise<void> {
    if (!spaceId) return;
    try {
      const { url } = await createInvite(spaceId);
      try {
        await navigator.clipboard.writeText(url);
        alert(`คัดลอกลิงก์เชิญแล้ว (อายุ 7 วัน)\n\n${url}`);
      } catch {
        window.prompt('คัดลอกลิงก์เชิญนี้ (อายุ 7 วัน):', url);
      }
    } catch {
      alert('สร้างลิงก์เชิญไม่สำเร็จ');
    }
  }

  async function handleCreateFolder(): Promise<void> {
    if (!spaceId) return;
    const name = window.prompt('ชื่อโฟลเดอร์ใหม่');
    if (!name?.trim()) return;
    try {
      await createFolder(spaceId, name.trim(), currentFolder?.id ?? null);
      await load();
    } catch {
      alert('สร้างโฟลเดอร์ไม่สำเร็จ');
    }
  }

  async function handleDeleteFolder(folder: FolderDto): Promise<void> {
    if (!window.confirm(`ลบโฟลเดอร์ "${folder.name}" ? (ไฟล์ข้างในจะย้ายออกมาข้างนอก)`)) return;
    try {
      await deleteFolder(folder.id);
      if (currentFolder?.id === folder.id) setCurrentFolder(null);
      await load();
    } catch {
      alert('ลบโฟลเดอร์ไม่สำเร็จ');
    }
  }

  async function handleCreateTag(): Promise<void> {
    if (!spaceId) return;
    const name = window.prompt('ชื่อ tag ใหม่');
    if (!name?.trim()) return;
    try {
      await createTag(spaceId, name.trim());
      await load();
    } catch {
      alert('สร้าง tag ไม่สำเร็จ (ชื่ออาจซ้ำ)');
    }
  }

  if (needsLogin) {
    return (
      <div className="center-page">
        <h1>หนูเก็บ 🐭</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดคลังไฟล์ของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  const visibleFolders = folders.filter((f) =>
    currentFolder ? f.parentId === currentFolder.id : f.parentId === null,
  );

  return (
    <>
      <header className="topbar">
        <h1>🐭 หนูเก็บ</h1>
        <div className="topbar-actions">
          {spaces.length > 0 && (
            <select
              className="select"
              value={spaceId ?? ''}
              onChange={(e) => switchSpace(e.target.value)}
              aria-label="เลือกพื้นที่"
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.type === 'personal' ? '👤' : '👥'} {s.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn secondary" onClick={handleCreateTeam}>
            + ทีม
          </button>
          {canInvite && (
            <button className="btn secondary" onClick={handleInvite}>
              เชิญสมาชิก
            </button>
          )}
          {drive?.enabled && !drive.connected && (
            <button className="btn secondary" onClick={handleConnectDrive}>
              เชื่อม Google Drive
            </button>
          )}
          {drive?.connected && <span className="drive-badge">✓ Drive: {drive.email}</span>}
          {isAdmin && (
            <a className="btn secondary" href="/admin">
              ผู้ดูแล
            </a>
          )}
          <button
            className="btn secondary"
            onClick={() => {
              clearSession();
              setNeedsLogin(true);
            }}
          >
            ออกจากระบบ
          </button>
        </div>
      </header>
      <main className="container">
        {usage && <UsageBar usage={usage} />}
        <div className="toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="ค้นหาไฟล์ (ชื่อ หรือข้อความในรูปจาก OCR)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn secondary" onClick={handleCreateFolder}>
            + โฟลเดอร์
          </button>
          <button className="btn secondary" onClick={handleCreateTag}>
            + Tag
          </button>
        </div>

        {tags.length > 0 && (
          <div className="tag-row filter-row">
            {tags.map((t) => (
              <button
                key={t.id}
                className={`tag-chip toggle ${activeTagId === t.id ? 'active' : ''}`}
                style={activeTagId === t.id ? { background: t.color } : undefined}
                onClick={() => setActiveTagId(activeTagId === t.id ? null : t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}

        <div className="breadcrumb">
          <button className="crumb" onClick={() => setCurrentFolder(null)}>
            🏠 ทั้งหมด
          </button>
          {currentFolder && <span className="crumb current">/ 📁 {currentFolder.name}</span>}
        </div>

        {visibleFolders.length > 0 && (
          <div className="folder-row">
            {visibleFolders.map((f) => (
              <div key={f.id} className="folder-chip">
                <button className="folder-open" onClick={() => setCurrentFolder(f)}>
                  📁 {f.name}
                </button>
                <button
                  className="icon-btn"
                  aria-label={`ลบโฟลเดอร์ ${f.name}`}
                  onClick={() => void handleDeleteFolder(f)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="empty-state">{error}</p>}
        {!error && files === null && <p className="empty-state">กำลังโหลด...</p>}
        {!error && files !== null && (
          <FileGrid
            files={files}
            folders={folders}
            tags={tags}
            driveConnected={drive?.connected}
            onChanged={() => void load()}
          />
        )}
      </main>
    </>
  );
}

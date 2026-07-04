'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import type { FileDto, FolderDto, SpaceDto, TagDto } from '@nookeb/shared';
import {
  ApiError,
  clearSession,
  createFolder,
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
import { formatBytes } from '@/lib/format';
import { fileGroup, type FileGroup } from '@/lib/filetype';
import { FileGrid } from '@/components/FileGrid';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { Navbar, type NavbarUser } from '@/components/Navbar';
import { BottomNav, type BottomTab } from '@/components/BottomNav';
import { RecentStrip } from '@/components/RecentStrip';
import { UsageBar } from '@/components/UsageBar';
import { BoxIcon, DatabaseIcon, DocIcon, FolderIcon, GridIcon, ImageIcon, ListIcon } from '@/components/icons';

type TypeFilter = 'all' | FileGroup;
type SortKey = 'newest' | 'oldest' | 'name' | 'size';

const TYPE_TABS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'image', label: 'รูปภาพ' },
  { id: 'doc', label: 'เอกสาร' },
  { id: 'video', label: 'วิดีโอ' },
  { id: 'other', label: 'อื่นๆ' },
];

export default function DashboardPage() {
  const [files, setFiles] = useState<FileDto[] | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [spaces, setSpaces] = useState<SpaceDto[]>([]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [drive, setDrive] = useState<GoogleStatus | null>(null);
  const [user, setUser] = useState<NavbarUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [currentFolder, setCurrentFolder] = useState<FolderDto | null>(null);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [activeTab, setActiveTab] = useState<BottomTab>('vault');
  const [profileOpen, setProfileOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileDto | null>(null);


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
    getMe()
      .then((me) => {
        setIsAdmin(me.isAdmin);
        setUser({ displayName: me.displayName, pictureUrl: me.pictureUrl });
      })
      .catch(() => {});
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
    setTypeFilter('all');
    setFiles(null);
  }

  function handleLogout(): void {
    clearSession();
    setNeedsLogin(true);
  }

  async function handleConnectDrive(): Promise<void> {
    try {
      const { url } = await getGoogleAuthUrl();
      window.location.href = url;
    } catch {
      alert('เริ่มการเชื่อม Google Drive ไม่สำเร็จ');
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

  function handleBottomNav(tab: BottomTab): void {
    setActiveTab(tab);
    if (tab === 'vault') {
      setTypeFilter('all');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tab === 'search') {
      setSearchOpen(true);
    } else if (tab === 'recent') {
      document.getElementById('recent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (tab === 'profile') {
      setProfileOpen(true);
    }
  }

  // ---------- derived lists (client-side filter + sort) ----------

  const groupCounts = useMemo(() => {
    const counts: Record<FileGroup, number> = { image: 0, doc: 0, video: 0, other: 0 };
    for (const f of files ?? []) counts[fileGroup(f.mimeType)]++;
    return counts;
  }, [files]);

  const shownFiles = useMemo(() => {
    if (!files) return null;
    const filtered = typeFilter === 'all' ? files : files.filter((f) => fileGroup(f.mimeType) === typeFilter);
    const sorted = [...filtered];
    switch (sort) {
      case 'newest':
        sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        break;
      case 'oldest':
        sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        break;
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name, 'th'));
        break;
      case 'size':
        sorted.sort((a, b) => b.fileSize - a.fileSize);
        break;
    }
    return sorted;
  }, [files, typeFilter, sort]);

  const recentFiles = useMemo(() => {
    if (!files) return [];
    return [...files].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  }, [files]);

  const showRecent = recentFiles.length > 0 && !debouncedSearch && typeFilter === 'all' && !currentFolder;

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดล็อคเกอร์ของคุณ</p>
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
      <Navbar
        search={search}
        onSearchChange={setSearch}
        user={user}
        onLogout={handleLogout}
        searchOpen={searchOpen}
        onSearchOpenChange={(open) => {
          setSearchOpen(open);
          if (!open && activeTab === 'search') setActiveTab('vault');
        }}
      />

      <main className="container">
        {/* ---------- quick stats ---------- */}
        {files !== null && (
          <div className="stats-row">
            <button
              className={`stat-chip ${typeFilter === 'all' ? 'active' : ''}`}
              onClick={() => setTypeFilter('all')}
            >
              <span className="stat-icon">
                <BoxIcon />
              </span>
              <span>
                <span className="stat-num">{files.length}</span>
                <br />
                <span className="stat-label">ไฟล์ทั้งหมด</span>
              </span>
            </button>
            <button
              className={`stat-chip ${typeFilter === 'image' ? 'active' : ''}`}
              onClick={() => setTypeFilter(typeFilter === 'image' ? 'all' : 'image')}
            >
              <span className="stat-icon">
                <ImageIcon />
              </span>
              <span>
                <span className="stat-num">{groupCounts.image}</span>
                <br />
                <span className="stat-label">รูปภาพ</span>
              </span>
            </button>
            <button
              className={`stat-chip ${typeFilter === 'doc' ? 'active' : ''}`}
              onClick={() => setTypeFilter(typeFilter === 'doc' ? 'all' : 'doc')}
            >
              <span className="stat-icon">
                <DocIcon />
              </span>
              <span>
                <span className="stat-num">{groupCounts.doc}</span>
                <br />
                <span className="stat-label">เอกสาร</span>
              </span>
            </button>
            {usage && (
              <div className="stat-chip" role="status">
                <span className="stat-icon">
                  <DatabaseIcon />
                </span>
                <span>
                  <span className="stat-num">{formatBytes(usage.storageUsed)}</span>
                  <br />
                  <span className="stat-label">พื้นที่ใช้ไป</span>
                </span>
              </div>
            )}
          </div>
        )}

        {usage && <UsageBar usage={usage} />}

        {/* ---------- space / tools row ---------- */}
        <div className="actions-row">
          {spaces.length > 0 && (
            <select
              className="select"
              value={spaceId ?? ''}
              onChange={(e) => switchSpace(e.target.value)}
              aria-label="เลือกพื้นที่"
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.type === 'personal' ? 'ส่วนตัว' : 'ทีม'} · {s.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn secondary small" onClick={() => void handleCreateFolder()}>
            + โฟลเดอร์
          </button>
          <button className="btn secondary small" onClick={() => void handleCreateTag()}>
            + Tag
          </button>
          {drive?.enabled && !drive.connected && (
            <button className="btn secondary small" onClick={() => void handleConnectDrive()}>
              เชื่อม Google Drive
            </button>
          )}
          {drive?.connected && (
            <span className="drive-badge">
              <span className="drive-dot" />
              Drive: {drive.email}
            </span>
          )}
          {isAdmin && (
            <a className="btn secondary small" href="/admin">
              ผู้ดูแล
            </a>
          )}
        </div>

        {/* ---------- filter tabs + sort + view ---------- */}
        <div className="filter-toolbar">
          <div className="type-tabs" role="tablist" aria-label="ชนิดไฟล์">
            {TYPE_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={typeFilter === t.id}
                className={`type-tab ${typeFilter === t.id ? 'active' : ''}`}
                onClick={() => setTypeFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <select
              className="select"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="เรียงตาม"
            >
              <option value="newest">ล่าสุด</option>
              <option value="oldest">เก่าสุด</option>
              <option value="name">ชื่อ A-Z</option>
              <option value="size">ขนาด</option>
            </select>
            <div className="view-toggle" role="group" aria-label="รูปแบบการแสดงผล">
              <button
                className={view === 'grid' ? 'active' : ''}
                aria-label="มุมมองตาราง"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <GridIcon size={16} />
              </button>
              <button
                className={view === 'list' ? 'active' : ''}
                aria-label="มุมมองรายการ"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <ListIcon size={16} />
              </button>
            </div>
          </div>
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
            ทั้งหมด
          </button>
          {currentFolder && <span className="crumb current">/ {currentFolder.name}</span>}
        </div>

        {visibleFolders.length > 0 && (
          <div className="folder-row">
            {visibleFolders.map((f) => (
              <div key={f.id} className="folder-chip">
                <button className="folder-open" onClick={() => setCurrentFolder(f)}>
                  <span className="folder-glyph">
                    <FolderIcon />
                  </span>
                  {f.name}
                </button>
                <button
                  className="icon-btn"
                  aria-label={`ลบโฟลเดอร์ ${f.name}`}
                  onClick={() => void handleDeleteFolder(f)}
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ---------- recent strip ---------- */}
        {showRecent && (
          <RecentStrip
            files={recentFiles}
            onOpen={setPreviewFile}
            onSeeAll={() => {
              setTypeFilter('all');
              setSort('newest');
            }}
          />
        )}

        {error && <p className="empty-state">{error}</p>}
        {!error && shownFiles === null && (
          <div className="file-grid" aria-label="กำลังโหลด" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton-card">
                <div className="skeleton skeleton-thumb" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
              </div>
            ))}
          </div>
        )}
        {!error && shownFiles !== null && (
          <FileGrid
            files={shownFiles}
            folders={folders}
            tags={tags}
            driveConnected={drive?.connected}
            view={view}
            onChanged={() => void load()}
          />
        )}
      </main>

      {previewFile && <FilePreviewModal files={[previewFile]} onClose={() => setPreviewFile(null)} />}

      {/* ---------- profile sheet (mobile) ---------- */}
      {profileOpen && (
        <div
          className="modal-overlay"
          onClick={() => {
            setProfileOpen(false);
            setActiveTab('vault');
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="profile-sheet-head">
              {user?.pictureUrl ? (
                <img className="avatar" src={user.pictureUrl} alt="" />
              ) : (
                <span className="avatar-fallback">{(user?.displayName ?? 'ห').charAt(0)}</span>
              )}
              <div>
                <div className="profile-sheet-name">{user?.displayName ?? 'ผู้ใช้'}</div>
                {usage && (
                  <div className="profile-sheet-sub">
                    ใช้ไป {formatBytes(usage.storageUsed)} จาก {formatBytes(usage.storageLimit)}
                  </div>
                )}
              </div>
            </div>
            <div className="profile-sheet-actions">
              {drive?.enabled && !drive.connected && (
                <button className="btn secondary" onClick={() => void handleConnectDrive()}>
                  เชื่อม Google Drive
                </button>
              )}
              {drive?.connected && (
                <span className="drive-badge">
                  <span className="drive-dot" />
                  Drive: {drive.email}
                </span>
              )}
              {isAdmin && (
                <a className="btn secondary" href="/admin">
                  หน้าผู้ดูแล
                </a>
              )}
              <button className="btn danger" onClick={handleLogout}>
                ออกจากระบบ
              </button>
              <button
                className="btn ghost-muted"
                onClick={() => {
                  setProfileOpen(false);
                  setActiveTab('vault');
                }}
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav active={activeTab} onNavigate={handleBottomNav} />
    </>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { CloseIcon, SearchIcon } from './icons';

export interface NavbarUser {
  displayName: string | null;
  pictureUrl: string | null;
}

export interface NavbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  user: NavbarUser | null;
  onLogout: () => void;
  /** Mobile full-width search overlay — state lives in the page so the bottom nav can open it too. */
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  /** Files currently in the trash — shows a count badge on the ถังขยะ link when > 0. */
  trashCount?: number;
}

export function Navbar({
  search,
  onSearchChange,
  user,
  onLogout,
  searchOpen,
  onSearchOpenChange,
  trashCount = 0,
}: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onScroll(): void {
      setScrolled(window.scrollY > 4);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (searchOpen) overlayInputRef.current?.focus();
  }, [searchOpen]);

  // Enter commits the (already-live) search: close the mobile overlay and blur so
  // the results underneath are visible. The query itself is kept intact.
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchOpenChange(false);
      e.currentTarget.blur();
    }
  }

  const initial = (user?.displayName ?? 'ห').trim().charAt(0) || 'ห';

  return (
    <>
      <header className={`navbar ${scrolled ? 'scrolled' : ''}`}>
        <a className="navbar-brand" href="/dashboard">
          <Image src="/logo.png" alt="หนูเก็บ" width={36} height={36} className="navbar-logo" />
          <span className="navbar-title">หนูเก็บ</span>
        </a>

        <div className="navbar-search">
          <div className="search-pill">
            <span className="search-icon">
              <SearchIcon />
            </span>
            <input
              type="search"
              placeholder="ค้นหาไฟล์..."
              aria-label="ค้นหาไฟล์"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        </div>

        <div className="navbar-right">
          <a className="btn ghost" href="/dashboard/teams">
            ทีม
          </a>
          <a className="btn ghost" href="/dashboard/trash">
            ถังขยะ{trashCount > 0 ? ` (${trashCount})` : ''}
          </a>
          <button
            className="icon-btn search-toggle"
            aria-label="ค้นหาไฟล์"
            onClick={() => onSearchOpenChange(true)}
          >
            <SearchIcon />
          </button>
          {user && (
            <span className="navbar-user">
              {user.pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain not configured
                <img className="avatar" src={user.pictureUrl} alt="" />
              ) : (
                <span className="avatar-fallback">{initial}</span>
              )}
              <span className="user-name">{user.displayName ?? 'ผู้ใช้'}</span>
            </span>
          )}
          <button className="btn ghost logout-btn" onClick={onLogout}>
            ออกจากระบบ
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="search-overlay">
          <div className="search-overlay-row">
            <div className="search-pill">
              <span className="search-icon">
                <SearchIcon />
              </span>
              <input
                ref={overlayInputRef}
                type="search"
                placeholder="ค้นหาไฟล์..."
                aria-label="ค้นหาไฟล์"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
            <button
              className="icon-btn"
              aria-label="ปิดการค้นหา"
              onClick={() => onSearchOpenChange(false)}
            >
              <CloseIcon size={18} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

'use client';

import { GridIcon, ListIcon, SearchIcon, UserIcon } from './icons';

export type BottomTab = 'vault' | 'tasks' | 'search' | 'profile';

export interface BottomNavProps {
  active: BottomTab;
  onNavigate: (tab: BottomTab) => void;
}

/** Mobile-only fixed bottom navigation (hidden ≥768px via CSS). */
export function BottomNav({ active, onNavigate }: BottomNavProps) {
  const tabs: { id: BottomTab; label: string; icon: JSX.Element }[] = [
    { id: 'vault', label: 'คลัง', icon: <GridIcon size={20} /> },
    { id: 'tasks', label: 'งาน', icon: <ListIcon size={20} /> },
    { id: 'search', label: 'ค้นหา', icon: <SearchIcon size={20} /> },
    { id: 'profile', label: 'โปรไฟล์', icon: <UserIcon size={20} /> },
  ];

  return (
    <nav className="bottom-nav" aria-label="เมนูหลัก">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={active === t.id ? 'active' : ''}
          aria-current={active === t.id ? 'page' : undefined}
          onClick={() => onNavigate(t.id)}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

'use client';

/**
 * <AdminShell> —— 管理后台侧栏布局（响应式抽屉 + 图标导航 + 语言切换）。
 *
 * 用法（需包裹在 <PublicPkgProvider> 内）：
 *   <AdminShell currentPage={page} onPageChange={setPage}>
 *     {content}
 *   </AdminShell>
 *
 * - 导航项默认取 config.admin.navItems，可通过 `navItems` 覆盖；
 * - 标签取 navItem.label[locale]；图标按 navItem.icon 名称映射 lucide-react，未知名称则跳过；
 * - 界面语言默认 config.admin.locale，切换后持久化到 config.admin.localeStorageKey。
 */

import { useState, type ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  CreditCard,
  FileText,
  KeyRound,
  LayoutDashboard,
  Menu,
  PanelLeft,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { usePublicPkg } from '../config/provider';
import type { AdminNavItem } from '../config/types';

/** navItem.icon 名称 → lucide-react 图标（未知名称不渲染）。 */
const ICONS: Record<string, LucideIcon> = {
  Activity,
  BarChart3,
  CreditCard,
  FileText,
  KeyRound,
  LayoutDashboard,
  PanelLeft,
  Users,
};

type AdminLocale = 'en' | 'zh';

/** 切换按钮显示的文字（即目标语言的本名）。 */
const LOCALE_SWITCH_LABEL: Record<AdminLocale, string> = {
  en: '中文',
  zh: 'English',
};

export interface AdminShellProps {
  currentPage: string;
  onPageChange: (page: string) => void;
  children: ReactNode;
  /** 覆盖 config.admin.navItems。 */
  navItems?: AdminNavItem[];
}

export function AdminShell({ currentPage, onPageChange, children, navItems }: AdminShellProps) {
  const { config } = usePublicPkg();
  const items = navItems ?? config.admin.navItems ?? [];

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [locale, setLocale] = useState<AdminLocale>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(config.admin.localeStorageKey);
        if (saved === 'en' || saved === 'zh') return saved;
      } catch {
        /* 存储不可用时回落默认语言 */
      }
    }
    return config.admin.locale;
  });

  const toggleLocale = () => {
    const next: AdminLocale = locale === 'zh' ? 'en' : 'zh';
    setLocale(next);
    try {
      localStorage.setItem(config.admin.localeStorageKey, next);
    } catch {
      /* 忽略持久化失败 */
    }
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed lg:sticky top-0 left-0 h-full w-64 bg-background border-r border-border z-50 transition-transform duration-300',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex flex-col h-full">
          {/* Brand / Logo */}
          <div className="flex items-center gap-2 h-16 px-4 border-b border-border">
            <LayoutDashboard className="w-6 h-6 text-primary" />
            <span className="font-semibold text-lg">{config.brand.name}</span>
            {config.brand.tagline ? (
              <span className="text-muted-foreground text-sm">{config.brand.tagline}</span>
            ) : null}
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4">
            <ul className="space-y-1">
              {items.map((item) => {
                const Icon = item.icon ? ICONS[item.icon] : undefined;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => onPageChange(item.id)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                        currentPage === item.id
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {Icon ? <Icon className="w-5 h-5" /> : null}
                      {item.label[locale]}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Locale Switch */}
          <div className="p-4 border-t border-border">
            <button
              onClick={toggleLocale}
              className="w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            >
              {LOCALE_SWITCH_LABEL[locale]}
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed top-4 left-4 z-50 p-2 rounded-lg bg-background border border-border lg:hidden"
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Backdrop for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
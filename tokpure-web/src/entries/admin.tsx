'use client';

/**
 * 管理后台岛屿（admin.html）。
 *
 * 组合 public-pkg 的 <AdminGate>（服务端/本地 demo 管理员校验）+
 * <AdminShell>（侧栏布局）+ 各页签内容；「博客管理」页签直接复用 <BlogEditor>。
 *
 * 未登录 / 非管理员会被 AdminGate 重定向到 /login.html；
 * 管理员账号：admin@126.com / admin@666666。
 */

import { useEffect, useState } from 'react';
import {
  AdminGate,
  AdminShell,
  BlogEditor,
  getSupabaseClient,
  useAuth,
} from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';
import { pkgConfig, SUPABASE_READY } from '@/lib/pkg-config';

const CREDS = pkgConfig.supabase ?? { url: '', anonKey: '' };

type Row = Record<string, unknown>;

/** 读取一张表的行（未接入 Supabase 时直接返回空）。 */
function useTable(table: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(SUPABASE_READY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!SUPABASE_READY) return;
    let alive = true;
    (async () => {
      try {
        const client = getSupabaseClient(CREDS);
        const { data, error: err } = await client
          .from(table)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (!alive) return;
        if (err) setError(String(err?.message ?? err));
        else setRows((data ?? []) as Row[]);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [table]);

  return { rows, loading, error };
}

function PendingNotice() {
  if (SUPABASE_READY) return null;
  return (
    <div className="mb-6 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      尚未接入 Supabase，当前为本地演示模式。配置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
      后即可显示真实用户、订单与博客数据。
    </div>
  );
}

function PageHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-foreground">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-bold text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: { key: string; label: string }[];
  rows: Row[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-3 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={String(row.id ?? i)} className="hover:bg-muted/30">
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-3 text-foreground">
                  {row[c.key] == null ? '—' : String(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatsPage() {
  const users = useTable('users');
  const subs = useTable('subscriptions');
  const posts = useTable('blogs');
  const fmt = (n: number) => (SUPABASE_READY ? String(n) : '—');
  return (
    <div className="p-6">
      <PageHead title="数据统计" desc="用户、订阅与内容概览。" />
      <PendingNotice />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="注册用户" value={fmt(users.rows.length)} />
        <StatCard label="有效订阅" value={fmt(subs.rows.length)} />
        <StatCard label="博客文章" value={fmt(posts.rows.length)} />
        <StatCard label="管理员" value={String(pkgConfig.admin.adminEmails.length)} hint="白名单账号" />
      </div>
    </div>
  );
}

function UsersPage() {
  const { rows, loading, error } = useTable('users');
  return (
    <div className="p-6">
      <PageHead title="用户管理" desc="平台注册用户与角色。" />
      <PendingNotice />
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={[
          { key: 'email', label: '邮箱' },
          { key: 'name', label: '昵称' },
          { key: 'role', label: '角色' },
          { key: 'credits', label: '积分' },
          { key: 'created_at', label: '注册时间' },
        ]}
        rows={rows}
        empty={loading ? '正在加载…' : '暂无用户数据'}
      />
    </div>
  );
}

function PaymentsPage() {
  const { rows, loading, error } = useTable('subscriptions');
  return (
    <div className="p-6">
      <PageHead title="付费管理" desc="订阅与积分订单记录。" />
      <PendingNotice />
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={[
          { key: 'email', label: '用户' },
          { key: 'plan', label: '套餐' },
          { key: 'status', label: '状态' },
          { key: 'amount', label: '金额' },
          { key: 'created_at', label: '下单时间' },
        ]}
        rows={rows}
        empty={loading ? '正在加载…' : '暂无订单数据'}
      />
    </div>
  );
}

/**
 * <AdminGate> 在挂载瞬间就读 user/accessToken，而会话恢复是异步的
 * （AuthProvider 的 loading 初始为 true）。若不等 loading 结束，
 * 已登录用户会被误判为未登录并重定向到登录页。
 */
function AdminApp() {
  const { loading } = useAuth();
  const [page, setPage] = useState('stats');

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-muted-foreground">正在校验管理员身份…</p>
        </div>
      </div>
    );
  }

  return (
    <AdminGate>
      <AdminShell currentPage={page} onPageChange={setPage}>
        {page === 'blog' ? (
          <BlogEditor />
        ) : page === 'users' ? (
          <UsersPage />
        ) : page === 'payments' ? (
          <PaymentsPage />
        ) : (
          <StatsPage />
        )}
      </AdminShell>
    </AdminGate>
  );
}

mount(
  'admin-root',
  <PkgRoot initialLocale={readSiteLocale()}>
    <AdminApp />
  </PkgRoot>,
);
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  Database,
  FileClock,
  LockKeyhole,
  Play,
  Radar,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { NvidiaProviderDialog } from '@/components/nvidia-provider-dialog';
import {
  arenaRuntime,
  type ArchiveQueryPage,
  type ArenaRuntimeStatus,
} from '@/lib/arena-runtime';

const navigation = [
  { label: '运行总览', icon: Radar, active: true },
  { label: '档案记录', icon: Archive },
  { label: '复盘分析', icon: Bot },
  { label: '策略审计', icon: ShieldCheck },
];

const invariants = [
  ['提交能力', '不存在'],
  ['并发', '1'],
  ['原始数据', '仅本机'],
  ['检查点', '提交后推进'],
];

export default function Home() {
  const [status, setStatus] = useState<ArenaRuntimeStatus | null>(null);
  const [archivePage, setArchivePage] = useState<ArchiveQueryPage | null>(null);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, recent] = await Promise.all([
        arenaRuntime.status(),
        arenaRuntime.queryRecords({ limit: 6 }),
      ]);
      setStatus(next);
      setArchivePage(recent);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<unknown>, success: string) => {
      setBusy(name);
      setNotice(null);
      try {
        await action();
        setNotice(success);
        await refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '操作失败');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const running = status?.run?.state === 'running';
  const source: 'demo' | 'live' =
    status?.browser.liveCollectionEnabled &&
    status.browser.selectorContract === 'verified'
      ? 'live'
      : 'demo';
  const runtimeMode = running
    ? source === 'demo'
      ? 'DEMO_MODE'
      : 'COLLECT_MODE'
    : (status?.browser.mode ?? 'PAUSED_HUMAN_AUTH');
  const archiveTotal = status?.archive.totalRecords ?? 0;
  const authPageCount = status?.browser.authPageCount ?? 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen max-w-[1600px] lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="hidden border-r border-sidebar-border bg-sidebar px-5 py-6 lg:flex lg:flex-col">
          <div className="flex items-center gap-3 px-2">
            <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_8px_28px_oklch(0.55_0.14_45/20%)]">
              <Archive className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-heading text-[15px] font-semibold tracking-[-0.02em]">
                Arena Archivist
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Local runtime
              </p>
            </div>
          </div>

          <nav className="mt-10 space-y-1" aria-label="主导航">
            {navigation.map(({ label, icon: Icon, active }) => (
              <button
                key={label}
                type="button"
                aria-current={active ? 'page' : undefined}
                className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground'
                }`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-xl border border-sidebar-border bg-background/55 p-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <LockKeyhole className="size-3.5 text-safe" aria-hidden="true" />
              Browser Guardian
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              写入、上传与未知变更请求均被运行时拒绝。
            </p>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="flex h-[72px] items-center justify-between border-b border-border px-5 sm:px-8">
            <div className="flex items-center gap-3 lg:hidden">
              <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Archive className="size-4" aria-hidden="true" />
              </div>
              <span className="font-heading text-sm font-semibold">
                Arena Archivist
              </span>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              <span
                className={`size-2 rounded-full ${
                  reachable
                    ? 'bg-safe shadow-[0_0_0_4px_oklch(0.72_0.12_165/12%)]'
                    : 'bg-destructive'
                }`}
              />
              <span className="text-sm font-medium">
                {reachable ? '本地服务正常' : '等待本地运行时'}
              </span>
              <span className="text-xs text-muted-foreground">
                · 仅监听 localhost
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="h-6 border-safe/30 bg-safe/8 text-safe-foreground"
              >
                <ShieldCheck data-icon="inline-start" />
                只读策略已启用
              </Badge>
              <NvidiaProviderDialog
                runtimeReachable={reachable}
                summary={status?.providers.find(
                  (provider) => provider.id === 'nvidia',
                )}
                onStatusChange={refresh}
              />
            </div>
          </header>

          <div className="mx-auto max-w-[1260px] p-5 sm:p-8">
            <div className="flex flex-col gap-5 border-b border-border pb-7 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-foreground">
                  Manual batch · Gray Swan only
                </p>
                <h1 className="mt-2 font-heading text-3xl font-semibold tracking-[-0.04em] sm:text-[38px]">
                  个人红队档案运行台
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  人工登录、低频只读采集、可恢复归档。模型仅参与异常解释与离线复盘。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  disabled={
                    !reachable || busy !== null || running || authPageCount >= 3
                  }
                  onClick={() =>
                    void runAction(
                      'auth',
                      () => arenaRuntime.openAuth(),
                      authPageCount > 0
                        ? '普通登录浏览器已经打开。'
                        : '已用普通系统浏览器打开 3 个登录标签页；登录完成后请关闭整个浏览器。',
                    )
                  }
                >
                  <FileClock data-icon="inline-start" />
                  {authPageCount === 0
                    ? '打开三个登录标签页'
                    : '登录浏览器已打开'}
                </Button>
                {running ? (
                  <Button
                    size="lg"
                    variant="destructive"
                    disabled={!reachable || busy !== null}
                    onClick={() =>
                      void runAction(
                        'pause',
                        () => arenaRuntime.pause(),
                        '已发送暂停信号，当前步骤完成后将安全停止。',
                      )
                    }
                  >
                    <CirclePause data-icon="inline-start" />
                    暂停当前批次
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    disabled={!reachable || busy !== null}
                    className="bg-command text-command-foreground hover:bg-command/88"
                    onClick={() =>
                      void runAction(
                        'sync',
                        () => arenaRuntime.sync(10, source),
                        source === 'demo'
                          ? '离线演示批次已启动，不会访问 Gray Swan。'
                          : '只读同步批次已启动。',
                      )
                    }
                  >
                    <Play data-icon="inline-start" fill="currentColor" />
                    {source === 'demo' ? '运行离线演示' : '同步下一批 10 条'}
                  </Button>
                )}
              </div>
            </div>

            {notice ? (
              <output
                aria-live="polite"
                className="mt-4 block rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
              >
                {notice}
              </output>
            ) : null}

            <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
              <Card className="border-0 bg-card shadow-[0_16px_50px_oklch(0.17_0.02_250/6%)] ring-border">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="flex items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-md bg-warning/12 text-warning-foreground">
                      <CirclePause className="size-4" aria-hidden="true" />
                    </span>
                    {running ? '采集器正在运行' : '采集器已暂停'}
                  </CardTitle>
                  <CardDescription>
                    {running
                      ? `${status?.run?.source === 'demo' ? '离线 fixture' : 'Gray Swan'} · 已提交 ${status?.run?.committed ?? 0} / ${status?.run?.requested ?? 0}`
                      : reachable
                        ? source === 'demo'
                          ? '真实采集默认关闭；可先运行完整离线演示。'
                          : '等待你确认登录状态并手动开始新批次。'
                        : '请先启动 localhost Runtime API。'}
                  </CardDescription>
                  <CardAction>
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px] tracking-wide"
                    >
                      {runtimeMode}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="pt-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      [
                        '本次预算',
                        String(status?.run?.requested ?? 10),
                        '条新记录',
                      ],
                      [
                        '最小间隔',
                        `${status?.budget.minIntervalSeconds ?? 10}s`,
                        source === 'demo' ? 'fixture 可跳过等待' : '每条打开',
                      ],
                      [
                        '运行上限',
                        `${status?.budget.maxRunMinutes ?? 20}m`,
                        '到期即停',
                      ],
                    ].map(([label, value, hint]) => (
                      <div
                        key={label}
                        className="rounded-lg border border-border bg-muted/35 p-4"
                      >
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="mt-2 font-mono text-2xl font-semibold tracking-[-0.04em]">
                          {value}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {hint}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 rounded-lg border border-border px-4 py-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">今日运行预算</span>
                      <span className="font-mono text-muted-foreground">
                        {status?.budget.runsToday ?? 0} /{' '}
                        {status?.budget.maxRunsPerDay ?? 3} RUNS
                      </span>
                    </div>
                    <Progress
                      value={
                        ((status?.budget.runsToday ?? 0) /
                          (status?.budget.maxRunsPerDay ?? 3)) *
                        100
                      }
                      className="mt-3 [&_[data-slot=progress-track]]:h-1.5"
                    />
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                      <span>403 / 429 立即停止</span>
                      <span>CAPTCHA 立即暂停</span>
                      <span>第三次失败停止</span>
                    </div>
                  </div>
                  {status?.run?.actionId ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/25 px-4 py-3 text-xs">
                      <span className="text-muted-foreground">
                        Durable action
                      </span>
                      <span className="font-mono">
                        {status.run.actionId.slice(0, 20)} ·{' '}
                        {status.run.actionPhase ?? 'unknown'} ·{' '}
                        {status.run.connectorId ?? 'unregistered'}
                      </span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="border-0 bg-ink text-ink-foreground ring-0">
                <CardHeader>
                  <CardTitle className="text-sm text-ink-foreground">
                    运行时不变量
                  </CardTitle>
                  <CardDescription className="text-ink-muted">
                    这些约束不受模型选择影响。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="divide-y divide-white/10">
                    {invariants.map(([term, value]) => (
                      <div
                        key={term}
                        className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                      >
                        <dt className="text-xs text-ink-muted">{term}</dt>
                        <dd className="font-mono text-xs font-medium text-ink-foreground">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              {[
                {
                  title: '归档状态',
                  value: `${archiveTotal} records`,
                  note: `${status?.archive.chats ?? 0} chats · ${status?.archive.submissions ?? 0} submissions`,
                  icon: Database,
                },
                {
                  title: '最近检查点',
                  value: status?.archive.lastCheckpoint ? '已提交' : '尚未创建',
                  note: status?.archive.lastCheckpoint
                    ? `${status.archive.lastCheckpoint.scope} · ${new Date(status.archive.lastCheckpoint.updatedAt).toLocaleString('zh-CN')}`
                    : '只会在数据库事务成功后推进',
                  icon: CheckCircle2,
                },
                {
                  title: '待复盘',
                  value: `${status?.archive.annotations ?? 0} annotations`,
                  note: '原始档案默认禁止外发模型',
                  icon: Bot,
                },
              ].map(({ title, value, note, icon: Icon }) => (
                <Card key={title} size="sm" className="border-0 ring-border">
                  <CardHeader>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <ChevronRight
                        className="size-4 text-muted-foreground/60"
                        aria-hidden="true"
                      />
                    </div>
                    <CardDescription>{title}</CardDescription>
                    <CardTitle className="font-mono text-lg">{value}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {note}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="mt-4 border-0 ring-border">
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Archive className="size-4" aria-hidden="true" />
                  最近归档
                </CardTitle>
                <CardDescription>
                  通过稳定 keyset
                  查询读取本地记录句柄；模型语义工具只返回无正文投影收据，完整确定性投影仅在本地路由边界生成。
                </CardDescription>
                <CardAction>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    CATALOG G{archivePage?.catalogGeneration ?? '—'}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="p-0">
                {archivePage?.items.length ? (
                  <div className="divide-y divide-border">
                    {archivePage.items.map((record) => (
                      <div
                        key={record.id}
                        className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {record.title ?? record.outcome ?? record.id}
                          </p>
                          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                            {record.kind} · {record.id} ·{' '}
                            {record.sourceHash?.slice(0, 24) ??
                              'no-source-hash'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Badge
                            variant="secondary"
                            className="font-mono text-[10px]"
                          >
                            {record.dataPolicy}
                          </Badge>
                          <span>
                            {new Date(record.updatedAt).toLocaleString('zh-CN')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                    尚无归档记录；可运行离线 fixture 验证完整链路。
                  </p>
                )}
              </CardContent>
            </Card>

            <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">离线复盘与可分享输出</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  统计只从 SQLite 重算；导出前强制秘密扫描，并排除浏览器
                  Profile。
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!reachable || busy !== null || running}
                  onClick={() =>
                    void runAction(
                      'analyze',
                      () => arenaRuntime.analyze(),
                      '确定性指标与 Markdown 报告已重新生成。',
                    )
                  }
                >
                  <Bot data-icon="inline-start" />
                  运行复盘
                </Button>
                <Button
                  variant="secondary"
                  disabled={!reachable || busy !== null || running}
                  onClick={() =>
                    void runAction(
                      'export',
                      () => arenaRuntime.exportPack(),
                      'analysis pack 已通过秘密扫描并写入本地 exports 目录。',
                    )
                  }
                >
                  <Archive data-icon="inline-start" />
                  导出 Analysis Pack
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

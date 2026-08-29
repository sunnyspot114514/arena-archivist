'use client';

import { useCallback, useState } from 'react';
import {
  ChevronsUpDown,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  Unplug,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { arenaRuntime, type NvidiaProviderStatus } from '@/lib/arena-runtime';
import { scoreModelIdMatch } from '@/lib/model-id-search';

function storageLabel(provider: NvidiaProviderStatus | null): string {
  if (provider?.credentialSource === 'environment') return '环境变量';
  if (provider?.secretStorage === 'windows_dpapi') {
    return 'Windows DPAPI · 当前用户加密';
  }
  return '仅当前本地运行';
}

export function NvidiaProviderDialog({
  runtimeReachable,
  summary,
  onStatusChange,
}: {
  runtimeReachable: boolean;
  summary?: {
    status: 'connected' | 'disconnected';
    activeModel?: string | null;
  };
  onStatusChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<NvidiaProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const visibleModel = provider?.activeModel ?? summary?.activeModel ?? null;
  const visibleStatus = provider?.status ?? summary?.status ?? 'disconnected';
  const availableModels = provider?.availableModels ?? [];
  const catalogLoaded = availableModels.length > 0;
  const activeModelInCatalog = provider?.activeModel
    ? availableModels.includes(provider.activeModel)
    : true;
  const modelChanged = Boolean(model && model !== provider?.activeModel);

  const applyProvider = useCallback((next: NvidiaProviderStatus) => {
    setProvider(next);
    setModel((current) => {
      if (next.availableModels.includes(current)) return current;
      return next.activeModel && next.availableModels.includes(next.activeModel)
        ? next.activeModel
        : '';
    });
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    setMessage(null);
    try {
      let next = await arenaRuntime.nvidiaStatus();
      applyProvider(next);
      if (next.status === 'connected' && next.availableModels.length === 0) {
        try {
          next = await arenaRuntime.refreshNvidiaModels();
          applyProvider(next);
        } catch (error) {
          setMessage(
            `Provider 已连接，但模型目录读取失败：${
              error instanceof Error ? error.message : '刷新失败'
            }`,
          );
        }
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '无法读取 Provider 状态',
      );
    } finally {
      setBusy(null);
    }
  }, [applyProvider]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) void load();
      else {
        setApiKey('');
        setModelPickerOpen(false);
        setShowKey(false);
        setMessage(null);
      }
    },
    [load],
  );

  const save = useCallback(async () => {
    const selectedModel = model;
    const newKey = apiKey.trim();
    if (!modelChanged && !newKey) {
      setMessage('请选择目录中的模型，或输入新的 API Key。');
      return;
    }
    if (provider?.status !== 'connected' && !newKey) {
      setMessage('首次连接需要填写 NVIDIA API Key。');
      return;
    }
    setBusy('save');
    setMessage(null);
    try {
      let next: NvidiaProviderStatus;
      if (newKey) {
        next = await arenaRuntime.configureNvidia({ apiKey: newKey });
        applyProvider(next);
        setApiKey('');
        setShowKey(false);
        try {
          next = await arenaRuntime.refreshNvidiaModels();
          applyProvider(next);
        } catch (error) {
          setMessage(
            `Key 已加密保存，但模型目录暂时不可用：${
              error instanceof Error ? error.message : '刷新失败'
            }`,
          );
          await onStatusChange();
          return;
        }
        if (modelChanged && next.availableModels.includes(selectedModel)) {
          next = await arenaRuntime.configureNvidia({ model: selectedModel });
          applyProvider(next);
          setMessage(`Key 已更新，已切换到 ${selectedModel}。`);
        } else if (modelChanged) {
          setMessage(
            `Key 已更新，但 ${selectedModel} 已不在最新目录中，请重新选择。`,
          );
        } else {
          setMessage(
            `Key 已安全保存；已读取 ${next.availableModels.length} 个模型 ID，请从列表选择。`,
          );
        }
      } else {
        next = await arenaRuntime.configureNvidia({ model: selectedModel });
        applyProvider(next);
        setMessage(`已切换到 ${selectedModel}。`);
      }
      await onStatusChange();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }, [
    apiKey,
    applyProvider,
    model,
    modelChanged,
    onStatusChange,
    provider?.status,
  ]);

  const refreshModels = useCallback(async () => {
    setBusy('models');
    setMessage(null);
    try {
      const next = await arenaRuntime.refreshNvidiaModels();
      applyProvider(next);
      setMessage(`已从 NVIDIA 更新 ${next.availableModels.length} 个模型 ID。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型列表刷新失败');
    } finally {
      setBusy(null);
    }
  }, [applyProvider]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setMessage(null);
    try {
      const next = await arenaRuntime.disconnectNvidia();
      applyProvider(next);
      setApiKey('');
      setMessage('已清除本地 NVIDIA 凭据。模型选择已保留。');
      await onStatusChange();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '断开失败');
    } finally {
      setBusy(null);
    }
  }, [applyProvider, onStatusChange]);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!runtimeReachable}
        onClick={() => handleOpenChange(true)}
        className="max-w-[280px] gap-2"
      >
        <KeyRound aria-hidden="true" />
        <span className="truncate">{visibleModel ?? '配置 NVIDIA 模型'}</span>
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            visibleStatus === 'connected' ? 'bg-safe' : 'bg-muted-foreground/50'
          }`}
          aria-hidden="true"
        />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-3 pr-8">
              <span className="grid size-9 place-items-center rounded-lg bg-safe/12 text-safe-foreground">
                <Zap className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogTitle>NVIDIA 模型连接</DialogTitle>
                <DialogDescription className="mt-1">
                  像 CC Switch 一样保存 Provider 并切换模型，但 Key 不进入
                  SQLite。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2.5 text-xs">
            <Badge
              variant={
                provider?.status === 'connected' ? 'default' : 'secondary'
              }
              className={
                provider?.status === 'connected'
                  ? 'bg-safe text-primary-foreground'
                  : undefined
              }
            >
              {provider?.status === 'connected' ? '已配置' : '未配置'}
            </Badge>
            <span className="text-muted-foreground">
              {storageLabel(provider)}
            </span>
            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
              integrate.api.nvidia.com/v1
            </span>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="nvidia-api-key">NVIDIA API Key</Label>
              <div className="flex gap-2">
                <Input
                  id="nvidia-api-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    provider?.status === 'connected'
                      ? '已安全保存；留空不会修改'
                      : 'nvapi-…'
                  }
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy !== null}
                  className="h-9 font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={
                    showKey ? '隐藏刚输入的 API Key' : '显示刚输入的 API Key'
                  }
                  disabled={!apiKey || busy !== null}
                  onClick={() => setShowKey((value) => !value)}
                >
                  {showKey ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                保存后只保留 Windows 当前用户可解密的密文；界面不会取回或回显旧
                Key。
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="nvidia-model">活动模型</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={provider?.status !== 'connected' || busy !== null}
                  onClick={() => void refreshModels()}
                >
                  <RefreshCw
                    className={busy === 'models' ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  更新模型列表
                </Button>
              </div>
              <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      id="nvidia-model"
                      type="button"
                      variant="outline"
                      aria-haspopup="listbox"
                      aria-expanded={modelPickerOpen}
                      aria-controls="nvidia-model-list"
                      aria-label="从 NVIDIA 模型目录选择活动模型"
                      className="h-9 w-full justify-between px-3 font-normal"
                    />
                  }
                  disabled={!catalogLoaded || busy !== null}
                >
                  <span
                    className={`truncate font-mono ${
                      model ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {model ||
                      (provider?.status === 'connected'
                        ? '先更新模型列表'
                        : '保存 Key 后读取模型 ID')}
                  </span>
                  <ChevronsUpDown
                    className="ml-2 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
                >
                  <Command filter={scoreModelIdMatch}>
                    <CommandInput placeholder="模糊搜索，例如 k3…" />
                    <CommandList id="nvidia-model-list">
                      <CommandEmpty>没有匹配的模型 ID</CommandEmpty>
                      <CommandGroup
                        heading={`NVIDIA 在线目录 · ${availableModels.length} 个`}
                      >
                        {availableModels.map((modelId) => (
                          <CommandItem
                            key={modelId}
                            value={modelId}
                            data-checked={model === modelId}
                            onSelect={() => {
                              setModel(modelId);
                              setModelPickerOpen(false);
                              setMessage(null);
                            }}
                          >
                            <span className="truncate font-mono text-xs">
                              {modelId}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs leading-5 text-muted-foreground">
                {catalogLoaded
                  ? `已读取 ${availableModels.length} 个完整模型 ID；支持忽略分隔符的模糊搜索（如 k3），只能从目录中选择。`
                  : provider?.status === 'connected'
                    ? '尚未读取到模型目录，请点击“更新模型列表”后选择。'
                    : '首次保存 Key 后会自动读取 NVIDIA 模型目录。'}
              </p>
            </div>
          </div>

          {provider?.activeModel && catalogLoaded && !activeModelInCatalog ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>当前模型 ID 不在 NVIDIA 目录中</AlertTitle>
              <AlertDescription>
                已保存的{' '}
                <code className="font-mono">{provider.activeModel}</code>{' '}
                不是当前目录返回的完整 ID，请从上方列表重新选择。
              </AlertDescription>
            </Alert>
          ) : null}

          {message ? (
            <output
              aria-live="polite"
              className="block rounded-lg border border-border bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground"
            >
              {message}
            </output>
          ) : null}

          <DialogFooter className="sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={provider?.status !== 'connected' || busy !== null}
              onClick={() => void disconnect()}
            >
              <Unplug aria-hidden="true" />
              断开并清除 Key
            </Button>
            <Button
              type="button"
              disabled={
                !runtimeReachable ||
                busy !== null ||
                (!modelChanged && !apiKey.trim())
              }
              onClick={() => void save()}
            >
              <Zap aria-hidden="true" />
              {busy === 'save'
                ? '正在保存…'
                : modelChanged
                  ? apiKey.trim()
                    ? '更新 Key 并切换'
                    : '切换到所选模型'
                  : provider?.status === 'connected'
                    ? '更新 Key 并刷新模型'
                    : '保存 Key 并读取模型'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

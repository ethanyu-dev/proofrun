import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BENCHMARK_MAX_BYTES,
  V2_BENCHMARK_MAX_BYTES,
  V2_BENCHMARK_SUITE,
  parseBenchmark,
  type BenchmarkRun,
} from '@proofrun/contracts/benchmark';
import type { ReleaseIdentity } from '@proofrun/contracts/release';
import type { ApiClient } from './api';

/** 在途任务和后台新运行每两秒读取元数据，完整正文仅加载当前运行及选中的基线。 */
const POLL_MS = 2000;
const REQUEST_MS = 10000;
const LOCAL = '/__benchmark';
const REMOTE = '/v1/admin/benchmarks';
export interface BenchmarkEntry {
  id: string;
  createdAt: string;
  release?: ReleaseIdentity;
  state?: string;
}
/** 页面实例按本地/服务端切换重建，避免把另一数据源迟到的响应合入当前列表。 */
export function useBenchmarks(
  api?: ApiClient,
  family: 'browser' | 'v2' = 'browser',
) {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [entries, setEntries] = useState<BenchmarkEntry[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('all');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeFamily, setActiveFamily] = useState<'browser' | 'v2' | null>(
    null,
  );
  const [error, setError] = useState<string>();
  const [log, setLog] = useState('');
  const [selected, setSelected] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [server, setServer] = useState<{
    enabled: boolean;
    release: ReleaseIdentity;
    environment: string;
    nodePool: string | null;
  }>();
  const selectedRef = useRef('');
  const pendingId = useRef<string | null>(null);
  const previousIds = useRef<Set<string> | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const loadedPages = useRef(1);
  const choose = useCallback((id: string) => {
    selectedRef.current = id;
    setSelected(id);
  }, []);
  /** 服务端允许补全同一在途归档；导入归档不覆盖已有同身份内容。 */
  const merge = useCallback((items: BenchmarkRun[], update = false) => {
    setRuns((current) => {
      const map = new Map(current.map((run) => [run.id, run]));
      for (const run of items)
        if (update || !map.has(run.id)) map.set(run.id, run);
      return [...map.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    });
  }, []);
  const load = useCallback(
    async (id: string) => {
      if (!api) return;
      const epoch = generation.current;
      const result = await api.json<{ run: unknown; state: string }>(
        `${REMOTE}/${encodeURIComponent(id)}`,
        AbortSignal.timeout(REQUEST_MS),
      );
      const run = parseBenchmark(JSON.stringify(result.run));
      if (mounted.current && epoch === generation.current) merge([run], true);
    },
    [api, merge],
  );
  const refresh = useCallback(
    async (more = false) => {
      if (inFlight.current || (!api && !import.meta.env.DEV)) return;
      const epoch = generation.current;
      inFlight.current = true;
      setLoading(true);
      try {
        if (api) {
          const params = new URLSearchParams();
          if (version !== 'all') params.set('version', version);
          if (more && nextCursor) params.set('after', nextCursor);
          const [list, groups, status] = await Promise.all([
            api.json<{ runs: BenchmarkEntry[]; nextCursor: string | null }>(
              `${REMOTE}?${params}`,
              AbortSignal.timeout(REQUEST_MS),
            ),
            api.json<{ versions: { version: string }[] }>(
              `${REMOTE}/versions`,
              AbortSignal.timeout(REQUEST_MS),
            ),
            api.json<NonNullable<typeof server>>(
              `${REMOTE}/status`,
              AbortSignal.timeout(REQUEST_MS),
            ),
          ]);
          if (!mounted.current || epoch !== generation.current) return;
          if (more) loadedPages.current++;
          setEntries((current) => {
            const map = new Map(current.map((row) => [row.id, row]));
            for (const row of list.runs) map.set(row.id, row);
            return [...map.values()].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            );
          });
          if (more || loadedPages.current === 1) setNextCursor(list.nextCursor);
          setError(undefined);
          setVersions(groups.versions.map((row) => row.version));
          setServer(status);
          setRunning(
            list.runs.some((row) =>
              ['QUEUED', 'RUNNING'].includes(row.state ?? ''),
            ),
          );
          const target = selectedRef.current || list.runs[0]?.id;
          if (target) {
            choose(target);
            await load(target);
          }
        } else {
          const response = await fetch(`${LOCAL}?family=${family}`, {
            signal: AbortSignal.timeout(REQUEST_MS),
          });
          if (!response.ok)
            throw new Error(`本地结果读取失败（${response.status}）`);
          const data = await response.json();
          if (!Array.isArray(data.runs) || typeof data.running !== 'boolean')
            throw new Error('本地 Benchmark 接口不可用');
          const validated: BenchmarkRun[] = data.runs.map((value: unknown) =>
            parseBenchmark(JSON.stringify(value)),
          );
          if (!mounted.current || epoch !== generation.current) return;
          merge(validated);
          setRunning(data.running);
          setActiveFamily(data.activeFamily ?? null);
          setLog(data.log ?? '');
          if (data.running && !previousIds.current)
            previousIds.current = new Set(validated.map((run) => run.id));
          if (!data.running && previousIds.current) {
            const added = validated.find(
              (run) => !previousIds.current!.has(run.id),
            );
            if (added) choose(added.id);
            previousIds.current = null;
          }
          setError(
            [data.error, ...(data.errors ?? [])].filter(Boolean).join('\n') ||
              undefined,
          );
        }
      } catch (error) {
        if (mounted.current && epoch === generation.current)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight.current = false;
        if (mounted.current) setLoading(false);
        if (mounted.current && epoch !== generation.current)
          void refreshRef.current();
      }
    },
    [api, family, version, nextCursor, choose, load, merge],
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    mounted.current = true;
    void refreshRef.current();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!api && !running) return;
    const timer = window.setInterval(() => void refreshRef.current(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [api, running]);
  useEffect(() => {
    if (api && selected)
      void load(selected).catch((error) => setError(String(error)));
  }, [api, selected, load]);
  /** 版本筛选切换取消旧结果归属；历史无版本归档单独分组，不推测版本。 */
  const changeVersion = (value: string) => {
    generation.current++;
    loadedPages.current = 1;
    setVersion(value);
    choose('');
    setEntries([]);
    setNextCursor(null);
    setError(undefined);
  };
  useEffect(() => {
    if (api) void refreshRef.current();
  }, [api, version]);
  const start = async (mode: 'real' | 'scripted', releaseVersion?: string) => {
    setError(undefined);
    setRunning(true);
    try {
      if (api) {
        pendingId.current ??= crypto.randomUUID();
        const result = await api.json<{ id: string }>(
          REMOTE,
          AbortSignal.timeout(REQUEST_MS),
          { id: pendingId.current },
        );
        pendingId.current = null;
        choose(result.id);
        setVersion('all');
        await load(result.id);
      } else {
        previousIds.current = new Set(runs.map((run) => run.id));
        const response = await fetch(LOCAL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: family === 'v2' ? 'v2' : mode,
            ...(releaseVersion ? { version: releaseVersion } : {}),
          }),
          signal: AbortSignal.timeout(REQUEST_MS),
        });
        if (!response.ok)
          throw new Error(
            (await response.json()).error ?? '无法启动 Benchmark',
          );
      }
      await refreshRef.current();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setRunning(false);
    }
  };
  const importFiles = async (files: File[]) => {
    try {
      const limit =
        family === 'v2' ? V2_BENCHMARK_MAX_BYTES : BENCHMARK_MAX_BYTES;
      if (files.reduce((sum, file) => sum + file.size, 0) > limit)
        throw new Error(`单批导入不能超过 ${limit / 1024 / 1024} MiB`);
      const items = await Promise.all(
        files.map(async (file) => parseBenchmark(await file.text())),
      );
      if (
        items.some(
          (run) => (run.suite === V2_BENCHMARK_SUITE) !== (family === 'v2'),
        )
      )
        throw new Error('归档属于另一测试集，请切换对应页签后导入');
      merge(items);
      choose(items[0]?.id ?? '');
      setError(undefined);
    } catch (error) {
      setError(String(error));
    }
  };
  const localEntries: BenchmarkEntry[] = runs.filter(
    (run) =>
      (run.suite === V2_BENCHMARK_SUITE) === (family === 'v2') &&
      (version === 'all' ||
        (run.release?.version ?? 'unversioned') === version),
  );
  return {
    runs,
    entries: api ? entries : localEntries,
    versions: api
      ? versions
      : [...new Set(runs.map((run) => run.release?.version ?? 'unversioned'))],
    version,
    setVersion: changeVersion,
    running,
    activeFamily,
    loading,
    error,
    log,
    selected,
    setSelected: choose,
    refresh: () => refresh(),
    more: () => refresh(true),
    nextCursor,
    load,
    start,
    importFiles,
    server,
  };
}

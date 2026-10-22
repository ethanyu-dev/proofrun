import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drainRequestSummaries } from '../src/modules/requests/summary.js';
import { Database } from '../src/db.js';
import { RequestReader as CurrentReader } from '../src/modules/requests/reader.js';
/** 可显式载入旧版本读取器，用相同数据库和数据比较查询路径；默认使用当前实现。 */
const RequestReader: typeof CurrentReader = process.env
  .PROOFRUN_LIST_BASELINE_READER
  ? (await import(process.env.PROOFRUN_LIST_BASELINE_READER)).RequestReader
  : CurrentReader;

/** 独立临时库压测；使用合成报告，不调用模型，不代表生产负载或真实业务验收。 */
const SIZES = [10_000, 100_000];
/** 稀少状态少于一页，强制旧实现扫描整个历史范围。 */
const RARE_EVERY = 5000;
/** 小样本只报告原始耗时、中位数和最大值，不推算尾延迟分位数。 */
const REPEATS = 3;
const CLIENTS = 4;
const address = process.env.PROOFRUN_TEST_DATABASE_URL;
assert.ok(address, '需要独立测试 PostgreSQL 地址');
const admin = new pg.Client({ connectionString: address });
await admin.connect();
const name = `proofrun_list_bench_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(address);
url.pathname = `/${name}`;
const db = new Database(url.toString());
const results: unknown[] = [];
try {
  await db.start();
  const reader = new RequestReader(db, 'http://localhost');
  const comparison: CurrentReader | null = process.env
    .PROOFRUN_LIST_COMPARE_READER
    ? new (
        await import(process.env.PROOFRUN_LIST_COMPARE_READER)
      ).RequestReader(db, 'http://localhost')
    : null;
  assert(
    !(comparison && process.env.PROOFRUN_LIST_BASELINE_READER),
    '不能同时指定独立基线与配对读取器',
  );
  // 并发测量前同时取得四条连接，避免把连接初始化波动误认为查询计划退化。
  const warmPool = async () => {
    const clients = await Promise.all(
      Array.from({ length: CLIENTS }, () => db.pool.connect()),
    );
    try {
      await Promise.all(clients.map((client) => client.query('SELECT 1')));
    } finally {
      clients.forEach((client) => client.release());
    }
  };
  let previous = 0;
  for (const size of SIZES) {
    // 每个请求有独立任务和三条标准；时间含微秒，便于复现游标排序。
    await db.transaction(async (client) => {
      // 造数不是线上查询；单独放宽批量导入期限，查询仍沿用生产十秒上限。
      await client.query("SET LOCAL statement_timeout='120s'");
      await client.query(
        `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,report)
        SELECT 'bench-'||n,jsonb_build_object('taskId','bench-'||n,'objective','历史任务 '||n,
          'acceptanceCriteria',(SELECT jsonb_agg(jsonb_build_object('id','c'||c,'description','标准','expectedResult','结果','evidenceKinds',jsonb_build_array('DOM'))) FROM generate_series(1,3) c)),
          'fixture','COMPLETED',now(),jsonb_build_object('executionDisposition','EXECUTED','verdict',CASE WHEN n % $3=0 THEN 'FAILED' ELSE 'PASSED' END,
          'criteria',(SELECT jsonb_agg(jsonb_build_object('criterionId','c'||c,'verdict',CASE WHEN n % $3=0 THEN 'FAILED' ELSE 'PASSED' END)) FROM generate_series(1,3) c))
        FROM generate_series($1::integer,$2::integer) n`,
        [previous + 1, size, RARE_EVERY],
      );
      await client.query(
        `INSERT INTO pr_verification_requests(request_id,title,definition_hash,created_at)
        SELECT 'bench-'||n,'历史请求 '||n,'fixture','2026-01-01'::timestamptz+n*interval '1 microsecond' FROM generate_series($1::integer,$2::integer) n`,
        [previous + 1, size],
      );
      await client.query(
        `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin)
        SELECT 'bench-'||n,'case-'||n,'bench-'||n,0,'fixture','created' FROM generate_series($1::integer,$2::integer) n`,
        [previous + 1, size],
      );
      await client.query(
        `INSERT INTO pr_verification_request_arms(request_id,case_id,task_id,execution_mode)
        SELECT 'bench-'||n,'case-'||n,'bench-'||n,'llm' FROM generate_series($1::integer,$2::integer) n`,
        [previous + 1, size],
      );
    });
    await db.query('ANALYZE');
    const backfillAt = performance.now();
    if (!process.env.PROOFRUN_LIST_BASELINE_READER)
      await drainRequestSummaries(db);
    const backfillMs = process.env.PROOFRUN_LIST_BASELINE_READER
      ? null
      : performance.now() - backfillAt;
    const warmStart = performance.now();
    await reader.list({ limit: '25' });
    const coldMs = performance.now() - warmStart;
    await db.query('ANALYZE');
    for (const query of [
      { limit: '25' },
      { limit: '25', reportStatus: 'FAILED' },
      { limit: '25', q: '不存在的搜索词' },
    ]) {
      const variants = [
        {
          mode: process.env.PROOFRUN_LIST_BASELINE_READER
            ? 'baseline'
            : 'candidate',
          reader,
          times: [] as number[],
        },
        ...(comparison
          ? [{ mode: 'baseline', reader: comparison, times: [] as number[] }]
          : []),
      ];
      let expected: unknown;
      const run = async (variant: (typeof variants)[number]) => {
        const start = performance.now();
        const result = await variant.reader.list(query);
        variant.times.push(performance.now() - start);
        assert.equal(
          result.requests.length,
          query.q ? 0 : query.reportStatus ? size / RARE_EVERY : 25,
        );
        const normalized = {
          ...result,
          requests: result.requests.map(
            ({ generatedAt: _at, ...item }) => item,
          ),
        };
        if (expected) assert.deepEqual(normalized, expected);
        else expected = normalized;
      };
      await warmPool();
      // 固定三轮、交替先后顺序，失败立即保留错误而不追加成功样本覆盖。
      for (let i = 0; i < REPEATS; i++)
        for (const variant of i % 2 ? [...variants].reverse() : variants)
          await run(variant);
      for (const variant of variants) {
        await warmPool();
        const parallelAt = performance.now();
        await Promise.all(Array.from({ length: CLIENTS }, () => run(variant)));
        results.push({
          size,
          query,
          mode: variant.mode,
          coldMs,
          backfillMs,
          timesMs: variant.times,
          parallelWallMs: performance.now() - parallelAt,
          medianMs: [...variant.times].sort((a, b) => a - b)[
            Math.floor(variant.times.length / 2)
          ],
          maxMs: Math.max(...variant.times),
        });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    if (!process.env.PROOFRUN_LIST_BASELINE_READER) {
      // 验证真实计划使用摘要索引；合成数据规模可复现，但不能据此承诺生产延迟。
      for (const [kind, where, index] of [
        ['status', "s.report_status='FAILED'", 'pr_request_summary_report'],
        [
          'search',
          "s.search_text ILIKE '%不存在的搜索词%' AND EXISTS(SELECT 1 FROM unnest(s.search_terms) term WHERE term ILIKE '%不存在的搜索词%')",
          'pr_request_summary_search',
        ],
      ]) {
        const plan = (
          await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT s.request_id,s.summary,r.title
          FROM pr_request_summaries s JOIN pr_verification_requests r USING(request_id)
          WHERE ${where} ORDER BY s.created_at DESC,s.request_id DESC LIMIT 26`)
        ).rows[0]!['QUERY PLAN'];
        assert(
          JSON.stringify(plan).includes(index!),
          `未命中预期索引 ${index}`,
        );
        console.log(JSON.stringify({ event: 'plan', size, kind, plan }));
      }
      const updated = performance.now();
      await db.query("UPDATE pr_tasks SET state='CANCELLED' WHERE id=$1", [
        `bench-${size}`,
      ]);
      const refreshed = await reader.list({ q: `历史任务 ${size}` });
      assert.equal(refreshed.requests[0]?.executionCounts.cancelled, 1);
      console.log(
        JSON.stringify({
          event: 'incremental-refresh',
          size,
          elapsedMs: performance.now() - updated,
        }),
      );
    }
    previous = size;
  }
} finally {
  await db.close();
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}

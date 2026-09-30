import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { auditDirectory } from '../../scripts/acceptance/audit.mjs';

/** 固定时间与最小本地证据只服务于审计回归，不代表真实浏览器运行。 */
const TIME = '2026-09-30T00:00:00.000Z';
const CONTENT = Buffer.from('{"text":"已保存"}');
const CLI = new URL('../../scripts/audit-acceptance.mjs', import.meta.url);

/** 建立完整导出夹具；每例修改一类边界，不依赖本机历史任务或网络。 */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = {
    protocolVersion: '0.1',
    taskId: 'audit-task',
    lifecycle: 'COMPLETED',
    executionDisposition: 'EXECUTED',
    verdict: 'PASSED',
    summary: '夹具完成声明',
    criteria: [
      {
        criterionId: 'saved',
        verdict: 'PASSED',
        summary: '夹具事实',
        evidenceRefs: ['dom-1'],
      },
    ],
    artifacts: [
      {
        id: 'dom-1',
        kind: 'DOM',
        uri: 'https://example.com/evidence/dom-1',
        sha256: createHash('sha256').update(CONTENT).digest('hex'),
      },
    ],
  };
  const detail = {
    id: 'audit-task',
    definition: {
      protocolVersion: '0.1',
      taskId: 'audit-task',
      objective: '核对保存结果',
      environment: { id: 'fixture', nodePool: 'fixture' },
      target: { url: 'https://example.com' },
      acceptanceCriteria: [
        {
          id: 'saved',
          description: '核对保存',
          expectedResult: '显示保存结果',
          evidenceKinds: ['DOM'],
        },
      ],
      budget: { timeoutMs: 60000, maxActions: 10 },
    },
    state: 'COMPLETED',
    deadline_at: TIME,
    created_at: TIME,
    finished_at: TIME,
    report,
    error: null,
    archived_at: null,
    executions: [
      {
        id: 'exec-1',
        worker_id: 'worker',
        state: 'FINISHED',
        lease_expires_at: TIME,
        session_id: 'session',
        node_id: 'node',
        session_state: 'CLOSED',
        closure_verified: true,
        action_count: 1,
        control_mode: 'AUTO',
        control_revision: 0,
        control_reason: null,
      },
    ],
  };
  const save = async () => {
    await writeFile(join(directory, 'task.json'), JSON.stringify(detail));
    await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  };
  await save();
  await writeFile(join(directory, 'dom-1.json'), CONTENT);
  return { directory, detail, report, save };
}

// 验证摘要和引用闭环；即便模型 PASSED，也不推导业务通过、零成本或已验证部署。
test('完整材料只通过完整性审计，缺失用量保持未知', async (t) => {
  const f = await fixture(t);
  const run = await auditDirectory(f.directory);
  assert.equal(run.integrity, 'VERIFIED');
  assert.equal(run.artifacts.verified, 1);
  assert.equal(run.reportedVerdict, 'PASSED');
  assert.equal(run.businessReview, 'NOT_REVIEWED');
  assert.equal(run.deploymentVerified, false);
  assert.equal(run.metrics.reportedPromptTokens, null);
  assert.equal(run.metrics.cost, null);
});

// 验证篡改证据不能继续支持验收结论；不判断原始截图或 DOM 的业务真实性。
test('摘要不符同时使引用和必需媒介失效', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'dom-1.json'), '{}');
  const run = await auditDirectory(f.directory);
  assert.equal(run.integrity, 'INVALID_OR_INCOMPLETE');
  assert.equal(run.artifacts.verified, 0);
  assert.deepEqual(
    run.issues.map((issue) => issue.code),
    [
      'ARTIFACT_HASH_MISMATCH',
      'UNVERIFIED_EVIDENCE_REF',
      'MISSING_EVIDENCE_KIND',
    ],
  );
});

// 验证报告副本错配和任务身份错配；不把合法 Schema 当作跨文件一致性证明。
test('另一任务的报告及被修改的副本都被识别', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, 'report.json'),
    JSON.stringify({ ...f.report, taskId: 'other' }),
  );
  const run = await auditDirectory(f.directory);
  assert.deepEqual(
    run.issues.map((issue) => issue.code),
    ['REPORT_MISMATCH', 'REPORT_TASK_MISMATCH'],
  );
});

// 验证完整性不会依赖每个数组非空时才成立；不证明实际节点进程已关闭。
test('缺失验收项与执行记录不能伪装完整通过', async (t) => {
  const f = await fixture(t);
  f.report.criteria = [];
  f.detail.executions = [];
  await f.save();
  const run = await auditDirectory(f.directory);
  assert.equal(run.closureVerified, null);
  assert.deepEqual(
    run.issues.map((issue) => issue.code),
    [
      'MISSING_CRITERION',
      'EXECUTION_RECORD_MISSING',
      'INCONSISTENT_PASSED_VERDICT',
    ],
  );
});

// 验证失败任务保留且与材料损坏分开；夹具不验证超时机制和供应商实际用量。
test('超时样本可具有完整材料，未关闭仍单独报错', async (t) => {
  const f = await fixture(t);
  f.detail.state = 'TIMED_OUT';
  Object.assign(f.report, {
    lifecycle: 'TIMED_OUT',
    executionDisposition: 'ERROR',
    verdict: null,
  });
  f.report.criteria[0].verdict = 'SKIPPED';
  f.report.criteria[0].evidenceRefs = [];
  await f.save();
  assert.equal((await auditDirectory(f.directory)).integrity, 'VERIFIED');
  f.detail.executions[0].closure_verified = false;
  await f.save();
  assert.ok(
    (await auditDirectory(f.directory)).issues.some(
      (issue) => issue.code === 'SESSION_NOT_CLOSED',
    ),
  );
});

// 验证受控文件路径及链接边界；不测试并发恶意替换文件的操作系统级隔离。
test('非法证据路径及符号链接不会被读取', async (t) => {
  const f = await fixture(t);
  await rm(join(f.directory, 'dom-1.json'));
  await symlink(
    join(f.directory, 'task.json'),
    join(f.directory, 'dom-1.json'),
  );
  assert.ok(
    (await auditDirectory(f.directory)).issues.some(
      (issue) => issue.code === 'UNREADABLE_ARTIFACT',
    ),
  );
  f.report.artifacts[0].id = '../outside';
  await f.save();
  assert.ok(
    (await auditDirectory(f.directory)).issues.some(
      (issue) => issue.code === 'INVALID_ARTIFACT_ID',
    ),
  );
});

// 验证批次入口保留缺失和重复样本，并返回非零退出码；不运行任何业务或模型。
test('批次不因缺失或重复样本静默缩小分母', async (t) => {
  const f = await fixture(t);
  try {
    execFileSync(
      process.execPath,
      [CLI.pathname, f.directory, f.directory, join(f.directory, 'missing')],
      { encoding: 'utf8' },
    );
    assert.fail('损坏批次必须失败');
  } catch (error) {
    assert.equal(error.status, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.sampleCount, 3);
    assert.equal(result.verifiedCount, 1);
    assert.equal(result.businessSuccessRate, null);
    assert.ok(
      result.runs[1].issues.some((issue) => issue.code === 'DUPLICATE_SAMPLE'),
    );
    assert.equal(result.runs[2].issues[0].code, 'MISSING_FILE');
  }
});

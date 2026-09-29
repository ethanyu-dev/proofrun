import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatModel } from '../apps/agent/dist/model/chat.js';
import { loadConfig } from '../apps/agent/dist/config.js';
import { loadObservation } from './test-jev.mjs';

/** 使用现有 Agent 的原始提示和六工具协议，单独检查简化比较工具带来的影响。 */
const REPEATS = 3;
const SOURCE = '.proofrun/acceptance/real-model-smoke-675c0260';

/** 只向模型重放观察，不实例化执行器；不领取任务、不执行浏览器动作。 */
async function main() {
  const config = { ...loadConfig(), modelMs: 120000, maxTokens: 8192 };
  const model = new ChatModel(config);
  const task = JSON.parse(await readFile(join(SOURCE, 'task.json'), 'utf8'));
  const report = JSON.parse(
    await readFile(join(SOURCE, 'report.json'), 'utf8'),
  );
  const directory = resolve(
    '.proofrun/jev-comparisons',
    `production-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cases = [];
  for (const [index, artifact] of report.artifacts
    .filter((a) => a.kind === 'DOM')
    .entries()) {
    const observation = await loadObservation(SOURCE, artifact);
    const input = {
      text: JSON.stringify({
        task: task.definition,
        budgetRemaining: {
          actions: task.definition.budget.maxActions,
          modelCalls: 40,
          timeMs: task.definition.budget.timeoutMs,
        },
        observation: {
          ...observation,
          artifactRefs: [
            {
              artifactId: artifact.id,
              kind: artifact.kind,
              sha256: artifact.sha256,
            },
          ],
        },
        evidence: [{ id: artifact.id, kind: artifact.kind }],
        recentOperations: [],
        previousObservations: [],
        feedback: null,
        truncated: false,
      }),
    };
    // 三个状态的预期动作在调用前定义；完成项只核对报告建议，不能证明执行链通过。
    const expected = [
      {
        type: 'browser.act',
        action: 'fill',
        name: 'Plain name',
        value: 'Ada-ProofRun',
      },
      { type: 'browser.act', action: 'click', name: 'Save Plain' },
      { type: 'verification.finish' },
    ][index];
    if (!expected) throw new Error('UNEXPECTED_OBSERVATIONS');
    cases.push({
      id: ['form-empty', 'form-filled', 'form-saved'][index],
      observation,
      input,
      expected,
    });
    await writeFile(
      join(directory, `${cases.at(-1).id}.input.json`),
      input.text,
      { mode: 0o600 },
    );
  }
  const result = {
    status: 'RUNNING',
    model: config.model,
    repeats: REPEATS,
    browserActions: 0,
    methodology:
      '原 ChatModel 系统提示及六工具协议；真实表单历史观察；未重建历史命令，独立状态输入；与简化候选测试分开报告。',
    attempts: [],
  };
  const persist = () =>
    writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
  await persist();
  console.log(
    JSON.stringify({ directory, requestsPlanned: REPEATS * cases.length }),
  );
  for (let round = 1; round <= REPEATS; round++)
    for (const item of cases) {
      const record = { round, caseId: item.id, status: 'STARTED' };
      result.attempts.push(record);
      await persist();
      const started = performance.now();
      try {
        const output = await model.decide(
          item.input,
          AbortSignal.timeout(config.modelMs),
        );
        const decision = output.decision;
        const target = item.observation.targets.find(
          (t) => t.target === decision.target,
        );
        const e = item.expected;
        const matches =
          decision.type === e.type &&
          (!e.action || decision.action === e.action) &&
          (!e.name || target?.name === e.name) &&
          (!e.value || decision.value === e.value);
        record.status = matches ? 'MATCH' : 'MISMATCH';
        record.output = output;
        record.targetName = target?.name;
      } catch (error) {
        record.status = 'ERROR';
        record.error = error.code || 'REQUEST_ERROR';
      }
      record.elapsedMs = Math.round(performance.now() - started);
      await persist();
      console.log(
        JSON.stringify({
          round,
          case: item.id,
          status: record.status,
          decision: record.output?.decision.type,
          action: record.output?.decision.action,
          target: record.targetName,
          ms: record.elapsedMs,
          error: record.error,
        }),
      );
    }
  result.status = 'COMPLETED';
  await persist();
}
main().catch(() => {
  console.error('PRODUCTION_BASELINE_FAILED');
  process.exitCode = 1;
});

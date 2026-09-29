import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pause } from '../../apps/agent/dist/http.js';

/** 仅在回环夹具使用的凭据；不会接入任何真实模型账户。 */
export const config = {
  apiUrl: 'http://127.0.0.1:4100',
  workerToken: 'fixture-worker-credential-only-32-chars',
  workerId: 'fixture-worker',
  modelUrl: '',
  modelKey: 'fixture-model-key',
  model: 'fixture-configurable-model',
  vision: false,
  tokenParameter: 'max_tokens',
  pollMs: 100,
  requestMs: 1000,
  modelMs: 2000,
  commandMs: 2000,
  maxTurns: 8,
  maxContextChars: 8000,
  maxTokens: 512,
};
/** 为每个 case 独立生成身份和期限，不沿用其他执行的证据。 */
export function grant() {
  return {
    id: randomUUID(),
    leaseToken: 'fixture-execution-credential',
    leaseExpiresAt: new Date(Date.now() + 3000).toISOString(),
    taskDeadlineAt: new Date(Date.now() + 15_000).toISOString(),
    nodeId: randomUUID(),
    sessionId: randomUUID(),
    state: 'STARTING',
    task: {
      protocolVersion: '0.1',
      taskId: randomUUID(),
      objective: '填写名称 Alice 并提交表单',
      environment: { id: 'fixture', nodePool: 'fixture' },
      target: { url: 'http://intranet.test/form' },
      acceptanceCriteria: [
        {
          id: 'submitted',
          description: '提交表单',
          expectedResult: '出现已提交 Alice',
          evidenceKinds: ['DOM'],
        },
      ],
      budget: { timeoutMs: 15_000, maxActions: 6 },
    },
  };
}
/** 只模拟控制面事实，用于验证 Agent 调度规则；不证明浏览器或 systemd 行为。 */
export class FakeControl {
  modelCalls = [];
  /** 仅保存执行器提交的步骤快照；真实归属校验由 API 集成测试覆盖。 */
  stepSnapshots = [];
  async recordSteps(_execution, steps) {
    this.stepSnapshots.push(structuredClone(steps));
  }
  /** 仅模拟审计交付，真实数据库归属与幂等性由集成用例验证。 */
  async recordModelCall(_execution, id, body) {
    this.modelCalls.push({ id, body: structuredClone(body) });
  }
  calls = [];
  artifacts = [];
  observedIds = [];
  reports = [];
  renewals = 0;
  value = '';
  submitted = false;
  unknown = false;
  hangingHeartbeat = false;
  pageText = '';
  async view(execution) {
    return {
      taskState: 'RUNNING',
      state: 'RUNNING',
      closureVerified: false,
      leaseExpiresAt: execution.leaseExpiresAt,
      artifacts: this.artifacts,
    };
  }
  async heartbeat(_execution, signal) {
    this.renewals++;
    if (this.hangingHeartbeat) await pause(10_000, signal);
    return new Date(Date.now() + 3000).toISOString();
  }
  async command(execution, id, operation) {
    this.calls.push({ id, operation });
    let data = {};
    if (operation.type === 'browser.act' && operation.action === 'fill')
      this.value = operation.value;
    if (operation.type === 'browser.act' && operation.action === 'click')
      this.submitted = true;
    if (operation.type === 'browser.observe') {
      const observationId = randomUUID();
      this.observedIds.push(observationId);
      const artifact = {
        id: randomUUID(),
        kind: 'DOM',
        sha256: 'a'.repeat(64),
        state: 'AVAILABLE',
      };
      this.artifacts.push(artifact);
      data = {
        observationId,
        text:
          this.pageText ||
          (this.submitted ? `已提交 ${this.value}` : '名称和提交表单'),
        url: execution.task.target.url,
        title: '业务表单',
        atomic: false,
        targets: [
          { target: '@e1', role: 'textbox', name: '名称' },
          { target: '@e2', role: 'button', name: '提交' },
        ],
        artifactRefs: [
          { artifactId: artifact.id, kind: 'DOM', sha256: artifact.sha256 },
        ],
      };
    }
    const unknown = this.unknown && operation.action === 'click';
    return {
      type: 'command.result',
      protocolVersion: '0.1',
      messageId: id,
      commandId: id,
      nodeId: execution.nodeId,
      sessionId: execution.sessionId,
      nodeEpoch: 'fixture-epoch',
      leaseId: 'fixture-lease',
      fence: 1,
      operationStatus: unknown ? 'UNKNOWN' : 'SUCCEEDED',
      effect: unknown ? 'MAY_HAVE_HAPPENED' : 'COMPLETED',
      data,
    };
  }
  async complete(_execution, report) {
    this.reports.push(report);
  }
  async image() {
    throw new Error('夹具没有真实截图');
  }
}
/** 根据当前实际送给模型的证据生成协议回复，不能预先猜测证据 ID。 */
export function finish(context) {
  return {
    type: 'verification.finish',
    summary: '夹具完成协议验证',
    criteria: context.task.acceptanceCriteria.map((c) => ({
      criterionId: c.id,
      verdict: 'PASSED',
      summary: '观察到预期结果',
      evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
    })),
  };
}
/** 本地 HTTP 模型协议夹具；决定来自脚本，不证明真实模型判断质量。 */
export async function modelServer(decide) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const content = body.messages[1].content;
      const context = JSON.parse(
        typeof content === 'string' ? content : content[0].text,
      );
      const value = await decide(context, requests.length, body, request);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          value?.raw ?? {
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      type: 'function',
                      function: {
                        name: value.type.replace('.', '_'),
                        arguments: JSON.stringify(
                          Object.fromEntries(
                            Object.entries(value).filter(
                              ([key]) => key !== 'type',
                            ),
                          ),
                        ),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          },
        ),
      );
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    errors,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

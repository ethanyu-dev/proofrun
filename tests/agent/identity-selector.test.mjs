import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { selectIdentity } from '../../apps/agent/dist/model/identity-selector.js';
import { config } from './fixture.mjs';

// 范围：真实回环模型协议、候选引用约束与单次调用；回复为夹具，不代表模型选取质量或网站登录成功。
test('薄身份 Agent 只接收目录摘要，拒绝候选外引用', async () => {
  let answer = {
    identityId: 'member',
    needsIdentity: true,
    reason: '符合成员要求',
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'identity_select',
                    arguments: JSON.stringify(answer),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settings = {
    ...config,
    modelUrl: `http://127.0.0.1:${server.address().port}`,
  };
  const input = {
    taskId: 'task',
    token: 'private-selection-token',
    task: {
      objective: '使用团队普通成员查看账单',
      url: 'https://example.test',
    },
    candidates: [
      {
        id: 'member',
        name: '测试成员',
        type: '成员',
        description: '测试团队的普通成员',
        url: 'https://example.test',
      },
    ],
  };
  try {
    assert.deepEqual(
      await selectIdentity(settings, input, new AbortController().signal),
      answer,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools.length, 1);
    assert.ok(!JSON.stringify(requests).includes(input.token));
    answer = {
      identityId: 'invented',
      needsIdentity: true,
      reason: '推测账号',
    };
    await assert.rejects(
      selectIdentity(settings, input, new AbortController().signal),
      /当前候选/,
    );
    answer = { identityId: null, needsIdentity: true, reason: '没有所需角色' };
    assert.deepEqual(
      await selectIdentity(settings, input, new AbortController().signal),
      answer,
    );
    answer = {
      identityId: null,
      needsIdentity: false,
      reason: '公开页面无需登录',
    };
    assert.deepEqual(
      await selectIdentity(settings, input, new AbortController().signal),
      answer,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

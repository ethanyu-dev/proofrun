import assert from 'node:assert/strict';

/** CLI 会混入诊断行；只解析完整事件，不从最终自然语言推断调用成功。 */
export function transcriptFacts(text) {
  const events = text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const items = events
    .filter((e) => e.type === 'item.completed')
    .map((e) => e.item);
  const calls = items.filter((i) => i.type === 'mcp_tool_call');
  const successful = calls.filter(
    (i) => !i.error && i.result && !i.result.is_error,
  );
  const views = successful
    .filter((i) => i.tool === 'verification_get_context')
    .map((i) => i.result.structured_content?.data);
  return {
    calls: calls.map((i) => ({
      tool: i.tool,
      server: i.server,
      arguments: i.arguments,
      error: i.error,
      isError: i.result?.is_error ?? false,
    })),
    tools: [...new Set(successful.map((i) => i.tool))],
    phases: [
      ...new Set(views.map((v) => v?.context?.state?.phase).filter(Boolean)),
    ],
    deliveredImage: successful.some((i) =>
      i.result.content?.some((c) => c.type === 'image' && c.data?.length > 0),
    ),
    readClosed: views.some(
      (v) => v?.closureVerified === true && v.nextAction === 'READ_REPORT',
    ),
    outsideCalls: items
      .filter(
        (i) =>
          !['mcp_tool_call', 'agent_message', 'reasoning'].includes(i.type),
      )
      .map((i) => i.type),
    usage: events.findLast((e) => e.type === 'turn.completed')?.usage ?? null,
    completed: events.some((e) => e.type === 'turn.completed'),
  };
}

/** 必须同时满足模型调用、平台报告、页面副作用及物理关闭，单一 PASSED 不足以验收。 */
export function verifyAudit(audit, submittedCase) {
  assert.equal(audit.exitCode, 0, 'Codex 进程未正常结束');
  assert.equal(audit.transcript.completed, true, '没有 Codex 完成事件');
  assert.deepEqual(
    audit.transcript.outsideCalls,
    [],
    '存在绕开两套 MCP 的工具调用',
  );
  assert.ok(
    audit.transcript.calls.every((c) =>
      ['proofrun_browser', 'proofrun_verification'].includes(c.server),
    ),
    '调用了其他 MCP',
  );
  for (const tool of [
    'browser_get_capabilities',
    'verification_get_capabilities',
    'verification_validate_cases',
    'verification_submit_cases',
    'verification_bind_run',
    'browser_act',
    'verification_record',
    'verification_finish_step',
    'verification_get_run',
    'verification_get_request',
  ])
    assert.ok(
      audit.transcript.tools.includes(tool),
      `缺少成功工具调用：${tool}`,
    );
  for (const call of audit.transcript.calls.filter(
    (c) => c.tool === 'verification_submit_cases',
  ))
    assert.deepEqual(call.arguments, submittedCase, '提交时改变了冻结 Case');
  for (const phase of ['PREPARING', 'CHECKING', 'VERIFYING', 'CLEANUP'])
    assert.ok(audit.transcript.phases.includes(phase), `未观察到阶段 ${phase}`);
  assert.equal(audit.transcript.deliveredImage, true, '没有实际交付原生截图');
  assert.equal(
    audit.transcript.readClosed,
    true,
    'Codex 未读取已关闭的最终上下文',
  );
  assert.equal(audit.tasks.length, 1);
  assert.equal(audit.tasks[0].state, 'COMPLETED');
  assert.equal(audit.tasks[0].report?.verdict, 'PASSED');
  assert.equal(audit.tasks[0].report?.executor?.kind, 'external');
  assert.deepEqual(
    audit.tasks[0].report.criteria.map((c) => [c.criterionId, c.verdict]),
    [['verify-expected-1', 'PASSED']],
  );
  assert.ok(
    audit.tasks[0].report.criteria[0].evidenceRefs.length > 0,
    '验收结论没有证据',
  );
  assert.deepEqual(
    audit.tasks[0].step_results.map((s) => [s.stepId, s.status]),
    [
      ['prepare', 'COMPLETED'],
      ['verify', 'COMPLETED'],
      ['cleanup', 'COMPLETED'],
    ],
  );
  assert.deepEqual(audit.site.writes, [
    { method: 'POST', name: 'MCP-REAL-001' },
    { method: 'DELETE', count: 1 },
  ]);
  assert.deepEqual(audit.site.records, []);
  assert.equal(audit.executions.length, 1);
  assert.ok(audit.executions.every((e) => e.closure_verified));
  assert.equal(audit.modelCalls, 0, '平台不得偷偷调用内置模型完成用例');
}

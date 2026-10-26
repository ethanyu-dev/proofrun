/** 只统计实际存在的用量；缺失 usage 与零 Token 必须区分。 */
export function usage(calls) {
  const known = (value) => Number.isSafeInteger(value) && value >= 0;
  const sum = (key) =>
    calls.some((c) => known(c[key]))
      ? calls.reduce((n, c) => n + (known(c[key]) ? c[key] : 0), 0)
      : null;
  return {
    calls: calls.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    complete:
      calls.length > 0 &&
      calls.every((c) => known(c.promptTokens) && known(c.completionTokens)),
    scope: '仅浏览器执行模型请求，不包含身份选择',
  };
}

/** 小样本只展示原始计数、中位数和范围，不制造稳定的尾延迟估计。 */
function distribution(values) {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? {
        count: sorted.length,
        min: sorted[0],
        median:
          sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2,
        max: sorted.at(-1),
      }
    : null;
}

/** 分母保留未完成/失败样本；未启动清单独立显示，不能消失在统计中。 */
export function summarize(manifest, samples) {
  const classifications = {};
  for (const sample of samples)
    for (const criterion of sample.result?.criteria ?? [])
      classifications[criterion.classification] =
        (classifications[criterion.classification] ?? 0) + 1;
  const started = samples.filter((s) => s.submissionIntentAt);
  return {
    runId: manifest.runId,
    planned: manifest.samples.length,
    started: started.length,
    evaluated: samples.filter((s) => s.result).length,
    passed: samples.filter((s) => s.result?.passed).length,
    businessSatisfied: samples.filter((s) => s.result?.businessSatisfied)
      .length,
    incomplete: started
      .filter((s) => !s.result)
      .map((s) => ({ id: s.id, error: s.error ?? null })),
    notRun: manifest.samples
      .filter((s) => !started.some((p) => p.id === s.id))
      .map((s) => s.id),
    classifications,
    elapsedMs: distribution(samples.map((s) => s.elapsedMs)),
    usage: usage(samples.flatMap((s) => s.calls ?? [])),
    limitations: [
      '受控测试应用不代表生产业务泛化',
      'HITL 使用固定操作脚本',
      '截图只校验媒介和摘要，自动语义判定依赖已引用 DOM 正文',
    ],
  };
}

/** 比较先核对场景、算法、种子和样本全集；缺项直接拒绝，避免幸存者偏差。 */
export function compareRuns(left, right) {
  if (
    left.manifest.environment?.modelKind !==
    right.manifest.environment?.modelKind
  )
    throw new Error('运行不可比较：不能混合脚本模型与真实模型');
  for (const key of [
    'formatVersion',
    'scenarioVersion',
    'oracleVersion',
    'scenarioDigest',
    'seed',
    'suite',
    'repeat',
  ])
    if (left.manifest[key] !== right.manifest[key])
      throw new Error(`运行不可比较：${key} 不同`);
  const keyed = (run) => new Map(run.samples.map((s) => [s.key, s]));
  for (const run of [left, right]) {
    if (
      run.manifest.samples.some(
        (planned) =>
          !run.samples.some(
            (sample) => sample.id === planned.id && sample.key === planned.key,
          ),
      )
    )
      throw new Error('运行不可比较：样本身份与清单不符');
  }
  const a = keyed(left);
  const b = keyed(right);
  if (
    a.size !== left.manifest.samples.length ||
    b.size !== right.manifest.samples.length ||
    a.size !== b.size ||
    [...a.keys()].some((key) => !b.has(key))
  )
    throw new Error('运行不可比较：样本缺失或重复');
  const pairs = [...a].map(([key, before]) => {
    const after = b.get(key);
    if (!before.result || !after.result) return { key, status: 'INCOMPLETE' };
    const budgetsMatch =
      JSON.stringify(before.budget) === JSON.stringify(after.budget);
    return {
      key,
      status:
        before.result.passed === after.result.passed
          ? 'UNCHANGED'
          : after.result.passed
            ? 'IMPROVED'
            : 'REGRESSED',
      budgetsMatch,
      before: before.result,
      after: after.result,
      elapsedDeltaMs: after.elapsedMs - before.elapsedMs,
      beforeUsage: usage(before.calls ?? []),
      afterUsage: usage(after.calls ?? []),
    };
  });
  return {
    baseline: left.manifest.runId,
    candidate: right.manifest.runId,
    comparison: '已声明配置对比；预算不同的样本不声称等预算收益',
    configurations: {
      baseline: left.manifest.environment,
      candidate: right.manifest.environment,
    },
    pairs,
  };
}

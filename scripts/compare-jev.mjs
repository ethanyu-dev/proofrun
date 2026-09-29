import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { makeRequest, callJev, loadObservation } from './test-jev.mjs';

/** 固定三轮、六个状态，最多 36 次真实请求；轮内交替顺序，不自动重试。 */
const REPEATS = 3;
const MODEL_MS = 120000;
const MAX_BYTES = 2 * 1024 * 1024;
const MODEL_OUTPUT_TOKENS = 8192;
const SOURCES = ['real-model-smoke-675c0260', 'novita-glm-pricing-bfb1f1c8'];

/** 以配置中的当前文本模型完成相同候选选择，额外排除浏览器执行和文字生成成本。 */
async function callLlm(request) {
  const started = performance.now();
  const base = new URL(process.env.PROOFRUN_MODEL_BASE_URL);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('INVALID_LLM_ENDPOINT');
  const tools = [
    {
      type: 'function',
      function: {
        name: 'choose_action',
        description: '从给定操作和对应目标候选中选出一个下一步建议。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: {
              type: 'string',
              enum: Object.keys(request.questions.operation.criteria),
            },
            target: {
              type: ['string', 'null'],
              description:
                'CLICK / TYPE_TEXT 使用对应问题中的候选键；其他操作为 null。',
            },
          },
          required: ['operation', 'target'],
        },
      },
    },
  ];
  const body = {
    model: process.env.PROOFRUN_MODEL,
    stream: false,
    parallel_tool_calls: false,
    [process.env.PROOFRUN_MODEL_TOKEN_PARAMETER || 'max_completion_tokens']:
      MODEL_OUTPUT_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          '依据提供的 state 和 questions 做下一步候选选择。遵守问题中的目标和规则。先选 operation，再选对应操作的 target。其他目标问题为条件性候选，不能同时执行。只调用 choose_action。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          state: request.state,
          questions: request.questions,
        }),
      },
    ],
    tools,
    tool_choice: 'required',
  };
  const response = await fetch(
    `${base.toString().replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_MS),
      headers: {
        authorization: `Bearer ${process.env.PROOFRUN_MODEL_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`LLM_HTTP_${response.status}`);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('LLM_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error('LLM_INVALID_JSON');
  }
  const choice = raw.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (
    choice?.finish_reason === 'length' ||
    calls?.length !== 1 ||
    calls[0].function?.name !== 'choose_action'
  )
    throw new Error('LLM_INVALID_TOOL_CALL');
  let decision;
  try {
    decision = JSON.parse(calls[0].function.arguments);
  } catch {
    throw new Error('LLM_INVALID_ARGUMENTS');
  }
  if (!Object.hasOwn(request.questions.operation.criteria, decision.operation))
    throw new Error('LLM_INVALID_OPERATION');
  const targetQuestion =
    request.questions[`${decision.operation.toLowerCase()}_target`];
  if (
    targetQuestion
      ? !Object.hasOwn(targetQuestion.criteria, decision.target)
      : decision.target !== null
  )
    throw new Error('LLM_INVALID_TARGET');
  return {
    model: raw.model ?? null,
    latencyMs: Math.round(performance.now() - started),
    operation: { choice: decision.operation },
    target: decision.target === null ? null : { choice: decision.target },
    usage: raw.usage ?? null,
  };
}

/** 读取历史任务及原始证据；旧报告的 PASSED 不直接当作本次全部问题的标准答案。 */
async function loadSource(id) {
  const directory = resolve('.proofrun/acceptance', id);
  const detail = JSON.parse(
    await readFile(join(directory, 'task.json'), 'utf8'),
  );
  const report = JSON.parse(
    await readFile(join(directory, 'report.json'), 'utf8'),
  );
  const observations = [];
  for (const artifact of report.artifacts.filter((a) => a.kind === 'DOM'))
    observations.push({
      artifact,
      observation: await loadObservation(directory, artifact),
    });
  return { detail, observations, directory };
}

/** 用预先固定的页面状态和显式预期构建比较集；两个模型接收完全相同的语义输入。 */
async function buildCases(model) {
  const [form, novita] = await Promise.all(SOURCES.map(loadSource));
  const cases = [];
  // 表单的三个真实浏览器状态；仅覆盖选动作，不覆盖填充值生成和真实提交。
  for (const [index, source] of form.observations.entries()) {
    const expected = [
      { operation: 'TYPE_TEXT', name: 'Plain name' },
      { operation: 'CLICK', name: 'Save Plain' },
      { operation: 'VERIFY', name: null },
    ][index];
    if (!expected) throw new Error('UNEXPECTED_FORM_OBSERVATIONS');
    const request = makeRequest(
      source.observation,
      form.detail.definition.objective,
      model,
    );
    // 此处保留“历史未知”，完成建议只依赖已显示的业务结果，不证明服务器写入次数。
    cases.push({
      id: ['form-empty', 'form-filled', 'form-saved'][index],
      taskId: form.detail.id,
      ...source,
      expected,
      request,
    });
  }
  if (cases.length !== 3) throw new Error('FORM_OBSERVATIONS_MISSING');
  const search = novita.observations.find(
    ({ observation: o }) =>
      o.targets.some(
        (t) => t.role === 'textbox' && t.name === 'Search models',
      ) && !o.text.includes(']: GLM'),
  );
  const dedicated = novita.observations.find(({ observation: o }) =>
    /tab "DEDICATED ENDPOINTS" \[selected/.test(o.text),
  );
  if (!search || !dedicated) throw new Error('NOVITA_OBSERVATIONS_MISSING');
  // Novita 定向子目标有显式标签；完整目标为探索项，不能按 LLM 一致率替代正确率。
  for (const item of [
    {
      id: 'novita-search',
      source: search,
      objective: '下一步找到 Search models 输入框，准备填写 GLM 以筛选模型。',
      expected: { operation: 'TYPE_TEXT', name: 'Search models' },
    },
    {
      id: 'novita-tab',
      source: dedicated,
      objective:
        '下一步切换到 SERVERLESS ENDPOINTS 栏目，继续查看按模型计费的价格。',
      expected: { operation: 'CLICK', name: 'SERVERLESS ENDPOINTS' },
    },
    {
      id: 'novita-full-goal',
      source: search,
      objective: novita.detail.definition.objective,
      expected: null,
    },
  ])
    cases.push({
      id: item.id,
      taskId: novita.detail.id,
      ...item.source,
      expected: item.expected,
      request: makeRequest(item.source.observation, item.objective, model),
    });
  return cases;
}

/** 对所有尝试留档，失败也保留耗时；汇总的正确率只使用预先定义标签的五个状态。 */
async function main() {
  if (
    !process.env.TYPESAFE_API_KEY ||
    !process.env.PROOFRUN_MODEL_API_KEY ||
    !process.env.PROOFRUN_MODEL
  )
    throw new Error('MISSING_MODEL_CONFIGURATION');
  const model = process.env.TYPESAFE_MODEL || 'jev-latest';
  const cases = await buildCases(model);
  const directory = resolve(
    '.proofrun/jev-comparisons',
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = {
    status: 'RUNNING',
    repeats: REPEATS,
    requestsPlanned: REPEATS * cases.length * 2,
    modelsRequested: { jev: model, llm: process.env.PROOFRUN_MODEL },
    methodology:
      '同一录制页面、相同目标、6000 字符页面片段及全部角色候选；两个模型交替顺序；只测操作与目标选择。当前文本模型使用专用选择工具，不等于原执行 Agent 的完整提示和工具协议。',
    browserActions: 0,
    cases: [],
    attempts: [],
  };
  for (const item of cases) {
    const input = JSON.stringify({
      state: item.request.state,
      questions: item.request.questions,
    });
    const metadata = {
      id: item.id,
      taskId: item.taskId,
      artifactId: item.artifact.id,
      evidenceSha256: item.artifact.sha256,
      semanticInputSha256: createHash('sha256').update(input).digest('hex'),
      expected: item.expected,
      textChars: item.request.state.page.text.length,
      textTruncated: item.request.state.pageTextTruncated,
      candidates: Object.fromEntries(
        Object.entries(item.request.questions).map(([k, v]) => [
          k,
          Object.keys(v.criteria).length,
        ]),
      ),
    };
    result.cases.push(metadata);
    await writeFile(
      join(directory, `${item.id}.request.json`),
      JSON.stringify(item.request, null, 2),
      { mode: 0o600 },
    );
  }
  const persist = () =>
    writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
  await persist();
  console.log(
    JSON.stringify({ directory, requestsPlanned: result.requestsPlanned }),
  );
  for (let round = 0; round < REPEATS; round++) {
    for (const [caseIndex, item] of cases.entries()) {
      const order = (round + caseIndex) % 2 ? ['llm', 'jev'] : ['jev', 'llm'];
      for (const arm of order) {
        const record = {
          round: round + 1,
          caseId: item.id,
          arm,
          status: 'STARTED',
          startedAt: new Date().toISOString(),
        };
        result.attempts.push(record);
        await persist();
        const started = performance.now();
        try {
          record.response =
            arm === 'jev'
              ? await callJev(item.request, process.env.TYPESAFE_API_KEY)
              : await callLlm(item.request);
          record.selectedTarget =
            item.observation.targets.find(
              (t) => t.target === record.response.target?.choice,
            ) ?? null;
          record.status = item.expected
            ? record.response.operation.choice === item.expected.operation &&
              (record.selectedTarget?.name ?? null) === item.expected.name
              ? 'MATCH'
              : 'MISMATCH'
            : 'EXPLORATORY';
        } catch (error) {
          record.status = 'ERROR';
          record.error = /^(JEV_|LLM_|INVALID_JEV_)[A-Z0-9_]+$/.test(
            error.message,
          )
            ? error.message
            : 'NETWORK_OR_REQUEST_ERROR';
        }
        record.elapsedMs = Math.round(performance.now() - started);
        await persist();
        console.log(
          JSON.stringify({
            round: record.round,
            case: item.id,
            arm,
            status: record.status,
            operation: record.response?.operation.choice,
            target: record.selectedTarget?.name,
            ms: record.elapsedMs,
            error: record.error,
          }),
        );
        if (record.error && /HTTP_(401|402|403|429)/.test(record.error)) {
          result.status = 'STOPPED_PROVIDER_REJECTION';
          await persist();
          process.exitCode = 1;
          return;
        }
      }
    }
  }
  result.status = 'COMPLETED';
  await persist();
}

main().catch((error) => {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : 'COMPARISON_SETUP_ERROR',
  );
  process.exitCode = 1;
});

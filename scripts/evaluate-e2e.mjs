import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { read } from '../tests/scenarios/harness/storage.mjs';
import { run } from '../tests/scenarios/harness/runner.mjs';

/** 默认只跑三例；真实模型调用须显式提供环境声明与凭据，不从开发配置隐式读取。 */
const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'smoke' },
    repeat: { type: 'string', default: '1' },
    seed: { type: 'string', default: 'baseline-1' },
    output: { type: 'string' },
    resume: { type: 'boolean', default: false },
    environment: { type: 'string' },
    'max-calls': { type: 'string', default: '2000' },
    'max-duration-ms': { type: 'string', default: '7200000' },
    'queue-ms': { type: 'string', default: '60000' },
    'sample-ms': { type: 'string', default: '1200000' },
    'close-ms': { type: 'string', default: '120000' },
  },
});
const number = (key, max) => {
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`参数无效：${key}`);
  return value;
};
if (!values.output || !values.environment)
  throw new Error('需要 --output 与 --environment；恢复时增加 --resume');
const environment = await read(resolve(values.environment));
const fields = [
  'mode',
  'modelKind',
  'model',
  'vision',
  'network',
  'agentCommit',
  'apiCommit',
  'configSha256',
];
if (
  !environment ||
  Object.keys(environment).some((key) => !fields.includes(key)) ||
  environment.mode !== 'llm' ||
  !['real', 'scripted'].includes(environment.modelKind) ||
  (environment.network !== undefined &&
    !['runtime-default', 'explicit-env-proxy'].includes(environment.network)) ||
  !environment.model
)
  throw new Error('环境声明无效；只接受非秘密白名单字段与单执行模式');
const apiUrl = process.env.PROOFRUN_CONTROL_URL;
const fixtureUrl = process.env.PROOFRUN_EVAL_FIXTURE_URL;
const socketPath = process.env.PROOFRUN_EVAL_FIXTURE_SOCKET;
if (!apiUrl || !fixtureUrl || !socketPath)
  throw new Error('需要显式控制面、测试页面 origin 与私有夹具 socket');
const target = new URL(fixtureUrl);
if (
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
)
  throw new Error('测试应用必须是无凭据 origin');
const summary = await run({
  suite: values.suite,
  repeat: number('repeat', 100),
  seed: values.seed,
  output: values.output,
  resume: values.resume,
  environment,
  apiUrl,
  token: process.env.PROOFRUN_ADMIN_TOKEN,
  fixtureUrl: target.origin,
  socketPath,
  mode: environment.mode,
  maxCalls: number('max-calls', 100_000),
  maxDurationMs: number('max-duration-ms', 86_400_000),
  queueMs: number('queue-ms', 3_600_000),
  sampleMs: number('sample-ms', 7_200_000),
  closeMs: number('close-ms', 600_000),
});
console.log(JSON.stringify(summary, null, 2));
process.exitCode =
  summary.evaluated !== summary.planned
    ? 2
    : summary.passed === summary.planned
      ? 0
      : 1;

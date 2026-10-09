import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const check = process.argv.includes('--check');
const destination = new URL('../contracts/src/generated/', import.meta.url);
const names = [
  'queue-reason',
  'case-step',
  'step-result',
  'verification-case-v2',
  'case-result-v2',
  'verification-case',
  'case-result',
  'verification-task',
  'verification-report',
  'node-command',
  'node-event',
  'control-request',
  'execution-grant',
  'agent-decision',
  'task-list',
  'task-detail',
  'node-list',
  'node-routing-write',
  'execution-activity',
  'hitl-client',
  'hitl-server',
  'model-call',
  'model-call-write',
];
if (!check) await mkdir(destination, { recursive: true });

for (const name of names) {
  const source = new URL(
    `../contracts/schemas/${name}.schema.json`,
    import.meta.url,
  );
  const schema = JSON.parse(await readFile(source, 'utf8'));
  const output = await compile(schema, schema.title, {
    cwd: fileURLToPath(new URL('../contracts/schemas/', import.meta.url)),
    bannerComment:
      '/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */',
    style: { singleQuote: true, trailingComma: 'all' },
  });
  const target = new URL(`${name}.ts`, destination);
  if (check) {
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing !== output) {
      console.error(`Contract output is stale: ${fileURLToPath(target)}`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(target, output);
  }
}

// 公共接入文档复用相同 Schema，并纳入已有生成漂移检查。
await import('./generate-public-api.mjs');

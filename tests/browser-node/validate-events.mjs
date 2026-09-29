import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateNodeEvent } from '../../contracts/dist/index.js';

// 验证范围：逐行用 TS 侧 NodeEvent Schema 校验已捕获的节点输出。
// 这里只检查事件结构，不证明事件来源、时序或控制面持久接收。
assert.ok(
  process.argv.length > 2,
  'Pass one or more captured events.jsonl files',
);
let count = 0;
const types = new Set();
for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const value = JSON.parse(line);
    assert.equal(
      validateNodeEvent(value),
      true,
      JSON.stringify(validateNodeEvent.errors),
    );
    types.add(value.type);
    count++;
  }
}
console.log(JSON.stringify({ validated: count, types: [...types] }));

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  validateSessionPlan,
  validateVerificationReport,
  type VerificationTask,
} from '@proofrun/contracts';
import { Database } from '../src/db.js';
import type { ApiConfig } from '../src/config.js';
import {
  IdentityLibrary,
  parseIdentityCookies,
} from '../src/modules/identities/library.js';
import {
  IdentitySelection,
  selectedTask,
} from '../src/modules/identities/selection.js';
import { resolveSession } from '../src/modules/identities/catalog.js';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
import { ExecutionControl } from '../src/modules/scheduling/control.js';
import { taskOutcomes } from '../src/modules/tasks/outcome.js';
import { task, until } from './fixture.js';

// 范围：Cookie 输入协议和秘密错误脱敏；不证明真实网站接受这些 Cookie。
test('身份 Cookie 接受数组与请求头，拒绝重复及未知字段', () => {
  assert.deepEqual(parseIdentityCookies('a=one; b=two'), [
    { name: 'a', value: 'one', httpOnly: true },
    { name: 'b', value: 'two', httpOnly: true },
  ]);
  assert.deepEqual(parseIdentityCookies('[]'), []);
  for (const value of [
    'a=one; a=two',
    '[{"name":"a","value":"secret","domain":"evil.test"}]',
    '[{"name":"a","value":"secret\\n"}]',
  ])
    assert.throws(
      () => parseIdentityCookies(value),
      (error) => error instanceof Error && !error.message.includes('secret'),
    );
});

// 范围：独立真实 PostgreSQL、私有文件版本、模型选择约束和人工终态；浏览器与模型均未在本用例运行。
test('薄身份库冻结种子、版本冲突、共享选择及人工无法执行', async (suite) => {
  assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
  const admin = new pg.Pool({
    connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
  });
  const name = `library_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = new Database(url.toString());
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-library-'));
  try {
    await db.start();
    const library = new IdentityLibrary(db, {
      artifactDirectory: directory,
    } as ApiConfig);
    const fields = {
      url: 'https://example.test/app',
      name: '测试成员',
      type: '成员',
      description: '所属团队普通成员',
      concurrency: 1,
    };
    const saved = await library.save({
      ...fields,
      cookies: 'session=fixture-secret',
    });
    const entry = saved.identities[0]!;
    assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
    const original = (await library.catalog()).identities[0]!;
    assert.equal(
      (await library.seed(original)).cookies[0]!.value,
      'fixture-secret',
    );
    const files = await readdir(join(directory, '.identity-secrets/library'));
    assert.equal(
      (await stat(join(directory, '.identity-secrets/library', files[0]!)))
        .mode & 0o777,
      0o600,
    );
    await library.save({
      ...fields,
      id: entry.id,
      revision: entry.revision,
      cookies: 'session=replacement',
    });
    await assert.rejects(
      library.save({ ...fields, id: entry.id, revision: entry.revision }),
      /重新读取/,
    );
    const current = (await library.catalog()).identities[0]!;
    assert.notEqual(current.libraryVersion, original.libraryVersion);
    assert.equal(
      (await library.seed(original)).cookies[0]!.value,
      'fixture-secret',
    );
    const definition = task('library-case') as VerificationTask;
    definition.environment.allowIntervention = true;
    definition.sessionPlan = resolveSession(
      await library.catalog(),
      undefined,
      fields.url,
      definition.environment,
    );
    assert.ok(
      validateSessionPlan(definition.sessionPlan),
      JSON.stringify(validateSessionPlan.errors),
    );
    assert.equal(definition.sessionPlan.selection, 'pending');
    await db.query(
      "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
      [definition.taskId, definition],
    );
    const selector = new IdentitySelection(db);
    const claimed = (await selector.claim()).selection!;
    assert.ok(claimed);
    assert.equal((await selector.claim()).selection, null);
    assert.ok(!JSON.stringify(claimed).includes('replacement'));
    await assert.rejects(
      selector.finish({
        taskId: definition.taskId,
        token: claimed.token,
        identityId: 'invented',
        needsIdentity: true,
        reason: '选择',
      }),
      /候选/,
    );
    await selector.finish({
      taskId: definition.taskId,
      token: claimed.token,
      identityId: current.id,
      needsIdentity: true,
      reason: '符合成员要求',
    });
    const chosen = await db.transaction((client) =>
      selectedTask(client, definition),
    );
    assert.equal(chosen!.sessionPlan!.candidates[0]!.id, current.id);
    // 范围：超过扫描批次的已选任务和活动选择租约不能饿死队尾；不启动模型或节点。
    await suite.test('身份选择跳过已选和仍持有租约的排队任务', async () => {
      const queued: string[] = [];
      try {
        for (let index = 0; index < 130; index++) {
          const id = randomUUID();
          queued.push(id);
          await db.query(
            "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,created_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour',clock_timestamp()-interval '1 minute')",
            [id, { ...definition, taskId: id }],
          );
          await db.query(
            "INSERT INTO pr_identity_selections(scope,claim_token,expires_at,plan) VALUES($1,$2,clock_timestamp()+interval '1 hour',$3)",
            [id, randomUUID(), index < 65 ? chosen!.sessionPlan : null],
          );
        }
        const tail = randomUUID();
        queued.push(tail);
        await db.query(
          "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
          [tail, { ...definition, taskId: tail }],
        );
        assert.equal((await selector.claim()).selection?.taskId, tail);
        assert.equal((await selector.claim()).selection, null);
      } finally {
        await db.query(
          'DELETE FROM pr_identity_selections WHERE scope=ANY($1::text[])',
          [queued],
        );
        await db.query('DELETE FROM pr_tasks WHERE id=ANY($1::text[])', [
          queued,
        ]);
      }
    });
    assert.equal(sessionAuth(chosen!)!.fullProfile, true);
    assert.ok(sessionAuth(chosen!)!.stateId.length <= 128);
    await db.query(
      "INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES('node','fixture','fixture','fixture')",
    );
    await db.query("UPDATE pr_tasks SET state='RUNNING' WHERE id=$1", [
      definition.taskId,
    ]);
    await db.query(
      "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state,control_mode,control_revision) VALUES('execution',$1,'worker','token',clock_timestamp()+interval '1 hour','RUNNING','HUMAN',1)",
      [definition.taskId],
    );
    await db.query(
      "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state) VALUES('session','execution','node','epoch','lease',1,'ACTIVE')",
    );
    await db.query(
      "INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at) VALUES('hitl','execution',1,'token','[]',clock_timestamp()+interval '1 hour')",
    );
    // 范围：最初判定无需账号，后续人工成功时仍能登记同一完整 profile；不调用真实浏览器。
    const publicTask = {
      ...definition,
      taskId: randomUUID(),
      sessionPlan: {
        ...definition.sessionPlan!,
        mode: 'manual' as const,
        selection: 'selected' as const,
        candidates: [],
      },
    };
    await db.query(
      "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
      [publicTask.taskId, publicTask],
    );
    const publicSlot = sessionAuth(publicTask)!;
    await library.published(publicTask.taskId, 'node');
    const published = (await library.catalog()).identities.find(
      (item) => item.stateId === publicSlot.stateId,
    );
    assert.ok(published);
    assert.equal(
      sessionAuth({
        ...publicTask,
        sessionPlan: { ...publicTask.sessionPlan, candidates: [published] },
      })!.stateId,
      publicSlot.stateId,
    );
    const control = new ExecutionControl(db, 'fixture-admin');
    await assert.rejects(
      control.unable('execution', 1, ' ', 'https://control.test'),
      /具体原因/,
    );
    await control.unable(
      'execution',
      1,
      '没有指定团队的邀请权限',
      'https://control.test',
    );
    await control.unable(
      'execution',
      1,
      '没有指定团队的邀请权限',
      'https://control.test',
    );
    const final = (
      await db.query('SELECT state,report FROM pr_tasks WHERE id=$1', [
        definition.taskId,
      ])
    ).rows[0]!;
    assert.equal(final.state, 'COMPLETED');
    assert.ok(
      validateVerificationReport(final.report),
      JSON.stringify(validateVerificationReport.errors),
    );
    assert.equal(final.report.humanDecision!.reason, '没有指定团队的邀请权限');
    const outcome = (await taskOutcomes(db, [definition.taskId])).get(
      definition.taskId,
    )!;
    assert.equal(outcome.category, 'HUMAN_UNEXECUTABLE');
    assert.equal(outcome.detail, '没有指定团队的邀请权限');
    assert.equal(
      (await db.query('SELECT closure_verified FROM pr_sessions')).rows[0]!
        .closure_verified,
      false,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pr_commands WHERE kind='browser.auth.save'",
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pr_commands WHERE kind='session.close'",
        )
      ).rows[0]!.n,
      1,
    );
    // 范围：保留和清空的数据库版本及展示状态，旧任务种子不受影响；不运行浏览器。
    await suite.test('清空 Cookies 显示未配置并保留历史种子', async () => {
      const before = (await library.list()).identities.find(
        (item) => item.id === entry.id,
      )!;
      const frozen = (await library.catalog()).identities.find(
        (item) => item.id === entry.id,
      )!;
      const kept = await library.save({
        ...fields,
        id: before.id,
        revision: before.revision,
      });
      const retained = kept.identities.find((item) => item.id === entry.id)!;
      assert.equal(retained.cookiesConfigured, true);
      assert.equal(
        (await library.catalog()).identities.find(
          (item) => item.id === entry.id,
        )!.libraryVersion,
        frozen.libraryVersion,
      );
      const cleared = await library.save({
        ...fields,
        id: retained.id,
        revision: retained.revision,
        cookies: '[]',
      });
      assert.equal(
        cleared.identities.find((item) => item.id === entry.id)!
          .cookiesConfigured,
        false,
      );
      const empty = (await library.catalog()).identities.find(
        (item) => item.id === entry.id,
      )!;
      assert.notEqual(empty.libraryVersion, frozen.libraryVersion);
      assert.deepEqual((await library.seed(empty)).cookies, []);
      assert.equal(
        (await library.seed(frozen)).cookies[0]!.value,
        'replacement',
      );
    });
  } finally {
    await db.close();
    await until(
      async () =>
        Number(
          (
            await admin.query(
              'SELECT count(*) FROM pg_stat_activity WHERE datname=$1',
              [name],
            )
          ).rows[0].count,
        ),
      (n) => n === 0,
    );
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});

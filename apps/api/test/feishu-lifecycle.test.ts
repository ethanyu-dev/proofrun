import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Database } from '../src/db.js';
import { digest } from '../src/domain.js';
import type { ApiConfig } from '../src/config.js';
import { ExecutionControl } from '../src/modules/scheduling/control.js';
import { CaseNotifications } from '../src/modules/notifications/service.js';
import {
  FeishuError,
  type FeishuTransport,
} from '../src/modules/notifications/feishu.js';
import { readCase } from '../src/modules/notifications/source.js';
import {
  registerRequest,
  registerMembers,
} from '../src/modules/requests/registration.js';
import { task, until } from './fixture.js';

/** 本地协议夹具凭据，不使用任何部署配置或外部群。 */
const ADMIN = 'fixture-feishu-admin-token-32-characters';
const WORKER = 'fixture-feishu-worker-token-32-characters';

/** 模拟飞书发送去重与逐条更新；失败模式可分别复现回执丢失和单卡片故障。 */
class FakeFeishu implements FeishuTransport {
  /** 飞书侧已接受的消息与最新卡片。 */
  readonly cards = new Map<string, any>();
  /** uuid 对应的原始发送请求，在未知结果重试时必须保持不变。 */
  readonly originals = new Map<string, string>();
  /** 记录尝试次数，不能把成功消息数量当成发送次数。 */
  readonly sends: string[] = [];
  readonly updates: string[] = [];
  /** 投递成功后故意丢失一次响应。 */
  loseReceipt = false;
  /** 指定消息更新失败，不影响其他消息。 */
  failUpdate: string | undefined;
  /** 飞书永久拒绝更新的消息身份。 */
  deleted: string | undefined;
  /** 所有新消息暂时拒绝，用于重试上限与退避。 */
  failSend = false;
  /** 挂起请求直到收到 API 关闭信号。 */
  hang = false;

  async send(card: object, uuid: string, signal: AbortSignal): Promise<string> {
    this.sends.push(uuid);
    if (this.hang)
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(new Error('fixture-abort'));
        else
          signal.addEventListener(
            'abort',
            () => reject(new Error('fixture-abort')),
            { once: true },
          );
      });
    if (this.failSend) throw new FeishuError(230020);
    const id = `om_${uuid.replaceAll('-', '')}`;
    const body = JSON.stringify(card);
    if (this.originals.has(uuid)) assert.equal(body, this.originals.get(uuid));
    else {
      this.originals.set(uuid, body);
      this.cards.set(id, structuredClone(card));
    }
    if (this.loseReceipt) {
      this.loseReceipt = false;
      throw new Error('private-transport-error');
    }
    return id;
  }
  async update(id: string, card: object): Promise<void> {
    this.updates.push(id);
    if (this.deleted === id) throw new FeishuError(230110);
    if (this.failUpdate === id) throw new FeishuError(230020);
    assert.ok(this.cards.has(id));
    this.cards.set(id, structuredClone(card));
  }
}

// 范围：真实 PostgreSQL、迁移与控制权事务；任务/会话由 SQL 建立，飞书为协议夹具，不验收真实群或浏览器。
test(
  '请求与 Case 通知复用卡片并在完成后汇总',
  { timeout: 45_000 },
  async (suite) => {
    const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
    assert.ok(databaseUrl, '请配置独立测试 PostgreSQL');
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const name = `feishu_lifecycle_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    let db = new Database(url.toString());
    await db.start();
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'https://api.example.test',
      consoleUrl: 'https://console.example.test',
      artifactDirectory: '/unused-fixture',
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 250,
      feishu: {
        appId: 'cli_fixture',
        appSecret: 'private-app-secret',
        chatId: 'oc_fixture',
      },
    };
    const warnings: unknown[][] = [];
    const log = {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
      error: () => {},
    };
    const remote = new FakeFeishu();
    let service = new CaseNotifications(db, config, log, remote);
    let control = notificationControl(db);
    // 登记订阅起点；首次启用前的历史记录不向新群补发。
    await service.tick();

    /** SQL 仅建立最小合法状态，人工请求仍通过真实控制权服务生成。 */
    async function create(
      runKey = randomUUID(),
      arm?: 'llm' | 'jev',
      purpose = 'verification',
    ) {
      const id = arm ? `${runKey}-${arm}` : runKey;
      const definition = {
        ...task('feishu'),
        taskId: id,
        environment: {
          id: 'fixture',
          nodePool: 'feishu',
          allowIntervention: true,
        },
        purpose,
        ...(arm
          ? {
              comparison: {
                id: runKey,
                sourceTaskId: 'different-source-task',
                arm,
              },
            }
          : {}),
      };
      await db.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,$1,'QUEUED',clock_timestamp()+interval '1 hour')",
        [id, definition],
      );
      return id;
    }
    /** 建立 v2 请求冻结成员关系；任务仍由夹具创建，不替代公共 API 接收验证。 */
    async function request(ids: string[], requestId = randomUUID()) {
      await db.transaction(async (client) => {
        await client.query(
          'INSERT INTO pr_verification_requests(request_id,title,definition_hash) VALUES($1,$2,$1)',
          [requestId, '批量验证'],
        );
        for (const [position, id] of ids.entries()) {
          await client.query(
            `UPDATE pr_tasks SET definition=jsonb_set(definition,'{caseV2Definition}',jsonb_build_object('caseId',$1::text)) WHERE id=$1`,
            [id],
          );
          await client.query(
            `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin) VALUES($1,$2,$2,$3,$2,'created')`,
            [requestId, id, position],
          );
          await client.query(
            `INSERT INTO pr_verification_request_arms(request_id,case_id,task_id,execution_mode) VALUES($1,$2,$2,'jev')`,
            [requestId, id],
          );
        }
      });
      return `request:${requestId}`;
    }
    /** 使用真实登记事务替换夹具任务；可注入失败验证通知抑制记录与成员一起回滚。 */
    async function rerun(
      key: string,
      caseId: string,
      next: string,
      rollback = false,
    ) {
      const registration = {
        requestId: key.slice('request:'.length),
        replaceRuns: true,
        title: '批量验证',
        hash: digest(next),
        rerunParameters: { caseIds: [{ sourceCaseId: caseId, runId: next }] },
      };
      await db.transaction(async (client) => {
        assert.equal(await registerRequest(client, registration), true);
        const definition = (
          await client.query(
            `UPDATE pr_tasks SET definition=jsonb_set(definition,'{caseV2Definition}',jsonb_build_object('caseId',$2::text)) WHERE id=$1 RETURNING definition`,
            [next, caseId],
          )
        ).rows[0].definition;
        await registerMembers(
          client,
          registration,
          [definition],
          new Set([next]),
        );
        if (rollback) throw new Error('fixture-rollback');
      });
      return registration;
    }
    /** 模拟已建立的浏览器会话和存活执行者，不调用真实浏览器。 */
    async function activate(id: string) {
      await db.query(
        "INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES($1,'夹具','feishu',$1)",
        [id],
      );
      await db.query("UPDATE pr_tasks SET state='RUNNING' WHERE id=$1", [id]);
      await db.query(
        "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES($1,$1,'fixture',$2,clock_timestamp()+interval '1 hour','RUNNING')",
        [id, digest(WORKER)],
      );
      await db.query(
        "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state) VALUES($1,$1,$1,'epoch','lease',1,'ACTIVE')",
        [id],
      );
    }
    /** 冻结报告和终态同时提交，验收结果不会从 COMPLETED 状态猜测。 */
    async function finish(id: string, state = 'COMPLETED', verdict = 'PASSED') {
      await db.transaction(async (client) => {
        await client.query(
          'UPDATE pr_tasks SET state=$2,finished_at=clock_timestamp(),report=$3 WHERE id=$1',
          [
            id,
            state,
            {
              verdict,
              summary: '夹具报告',
              executionDisposition: 'EXECUTED',
              criteria: [{ criterionId: 'visible', verdict }],
            },
          ],
        );
        await client.query(
          "UPDATE pr_executions SET state='STOPPING' WHERE task_id=$1",
          [id],
        );
      });
    }
    /** 加速扫描但保留轮次先后，避免多条活动记录因统一重置时间而饥饿；默认不跳过重试退避。 */
    async function tick(retry = false) {
      await db.query(
        "UPDATE pr_feishu_runs SET next_at=next_at-interval '2 seconds' WHERE settled_at IS NULL",
      );
      if (retry)
        await db.query(
          "UPDATE pr_feishu_messages SET send_next_at=clock_timestamp()-interval '1 second',update_next_at=clock_timestamp()-interval '1 second'",
        );
      await service.tick();
    }
    /** 检查数据库事实与模拟飞书的消息，而非服务内部变量。 */
    async function messages(runKey: string) {
      return (
        await db.query(
          'SELECT * FROM pr_feishu_messages WHERE run_key=$1 ORDER BY occurred_at,id',
          [runKey],
        )
      ).rows;
    }
    /** 等待消息与其当前目标版本收敛，不把排队记录误当成投递完成。 */
    async function sync(runKey: string, count: number) {
      for (let i = 0; i < 30; i++) {
        await tick();
        const rows = await messages(runKey);
        if (
          rows.length === count &&
          rows.every((row) => row.message_id) &&
          rows.every(
            (row) =>
              row.update_hash === null || row.update_hash === row.applied_hash,
          )
        )
          return rows;
      }
      throw new Error('通知未收敛');
    }
    try {
      // 范围：真实 PostgreSQL 请求归属、多 case 完成门槛、同 case 多轮 HITL 和重启去重；飞书由夹具模拟。
      await suite.test(
        '一次 v2 请求一张主卡片，HITL 按 case 复用，全部结束才汇总',
        async () => {
          const a = await create();
          const b = await create();
          const key = await request([a, b]);
          let rows = await sync(key, 1);
          const mainId = rows[0]!.message_id;
          assert.equal((await messages(a)).length, 0);
          assert.equal((await messages(b)).length, 0);
          assert.ok(
            JSON.stringify(remote.cards.get(mainId)).includes(
              '验证状态：排队中',
            ),
          );
          await activate(a);
          await activate(b);
          await sync(key, 1);
          assert.equal(
            remote.cards.get(mainId).header.title.content,
            '自动化测试 · 执行中',
          );
          await control.change(a, WORKER, 'request', 0, 'A 登录');
          await control.change(b, WORKER, 'request', 0, 'B 登录');
          rows = await sync(key, 3);
          const aCard = rows.find((row) => row.event.taskId === a)!;
          const bCard = rows.find((row) => row.event.taskId === b)!;
          const aLink = (await control.currentInterventionId(a))!;
          const bLink = (await control.currentInterventionId(b))!;
          assert.ok(
            JSON.stringify(remote.cards.get(aCard.message_id)).includes(aLink),
          );
          assert.ok(
            !JSON.stringify(remote.cards.get(aCard.message_id)).includes(bLink),
          );
          assert.ok(
            !JSON.stringify(remote.cards.get(mainId)).includes('/#/hitl/'),
          );
          await control.change(a, WORKER, 'acknowledge', 1);
          await control.change(a, null, 'resume', 1);
          await sync(key, 3);
          assert.ok(
            !JSON.stringify(remote.cards.get(aCard.message_id)).includes(
              '/#/hitl/',
            ),
          );
          assert.ok(
            JSON.stringify(remote.cards.get(bCard.message_id)).includes(bLink),
          );
          await control.change(a, WORKER, 'request', 2, '再次确认');
          await sync(key, 3);
          const next = await control.currentInterventionId(a);
          const body = JSON.stringify(remote.cards.get(aCard.message_id));
          assert.ok(body.includes(next!));
          assert.ok(body.includes('再次确认'));
          assert.ok(!body.includes('本轮人工介入已结束'));
          await finish(a);
          rows = await sync(key, 3);
          assert.ok(!rows.some((row) => row.event.kind === 'COMPLETED'));
          assert.ok(
            JSON.stringify(remote.cards.get(mainId)).includes(
              '验证状态：执行完成',
            ),
          );
          assert.equal(
            remote.cards.get(aCard.message_id).header.title.content,
            '自动化测试 · 执行完成',
          );
          await service.close();
          service = new CaseNotifications(db, config, log, remote);
          await sync(key, 3);
          await finish(b, 'TIMED_OUT', 'INCONCLUSIVE');
          rows = await sync(key, 4);
          const report = remote.cards.get(
            rows.find((row) => row.event.kind === 'COMPLETED')!.message_id,
          );
          assert.equal(report.header.title.content, '自动化测试 · 证据不足');
          assert.doesNotMatch(
            JSON.stringify(report),
            /Case 进度|报告覆盖|汇总结论|请求：/,
          );
          assert.ok(JSON.stringify(report).includes('最终结论：验收通过'));
          assert.ok(JSON.stringify(report).includes('最终结论：证据不足'));
          assert.ok(JSON.stringify(report).includes('/#/request-reports/'));
          for (const row of rows)
            assert.doesNotMatch(
              JSON.stringify(remote.cards.get(row.message_id)),
              /对照组|实验组|执行模式/,
            );
          assert.equal(
            remote.sends.filter((id) => rows.some((row) => row.id === id))
              .length,
            4,
          );
          // 复用已完成成员的新请求仍有自己的主卡片和汇总，但不重放旧 HITL。
          const reused = await request([a, b]);
          const reusedRows = await sync(reused, 2);
          assert.deepEqual(
            new Set(reusedRows.map((row) => row.event.kind)),
            new Set(['SUBMITTED', 'COMPLETED']),
          );
        },
      );

      // 范围：真实重跑登记事务与通知扫描，旧失败任务不得重新独立推送；执行状态和飞书由夹具模拟。
      await suite.test(
        '请求内单 case 重跑不补发旧任务卡片，新运行结束后才汇总',
        async () => {
          const old = await create();
          const other = await create();
          const key = await request([old, other]);
          await finish(old, 'ERROR', 'FAILED');
          await finish(other);
          await sync(key, 2);
          const before = remote.sends.length;
          const next = await create();
          const registration = await rerun(key, old, next);
          await activate(next);
          for (let i = 0; i < 6; i++) await tick();
          assert.equal(
            (await messages(old)).length,
            0,
            '旧任务不能变回独立 Case',
          );
          assert.equal(
            (await messages(next)).length,
            0,
            '新任务仍由请求聚合通知',
          );
          const rerunKey = `${key}:${registration.hash}`;
          const running = await sync(rerunKey, 1);
          const submission = running[0]!;
          assert.equal(remote.sends.length, before + 1);
          assert.equal(
            remote.cards.get(submission.message_id).header.title.content,
            '自动化测试 · 执行中',
          );
          assert.equal(submission.event.kind, 'SUBMITTED');
          assert.ok(
            new Date(submission.event.at).getTime() >
              new Date((await messages(key))[0]!.event.at).getTime(),
          );
          // 同一重跑重试和服务重启不得新建消息；保留未重跑成员的原结果。
          await db.transaction(async (client) => {
            assert.equal(await registerRequest(client, registration), false);
          });
          await service.close();
          service = new CaseNotifications(db, config, log, remote);
          await sync(rerunKey, 1);
          assert.equal(remote.sends.length, before + 1);
          await finish(next);
          const completed = await sync(rerunKey, 2);
          assert.equal(
            completed.filter((row) => row.event.kind === 'COMPLETED').length,
            1,
          );
          assert.equal(remote.sends.length, before + 2);
          assert.equal((await messages(old)).length, 0);
        },
      );

      // 范围：历史双组在首次扫描前连续重跑、事务回滚与独立运行隔离；不验证真实双执行器或群投递。
      await suite.test(
        '快速重跑保留全部旧组归属，失败切换不留下通知记录',
        async () => {
          const pair = randomUUID();
          const old = await create(pair, 'llm');
          const sibling = await create(pair, 'jev');
          const key = await request([old]);
          await db.query(
            'UPDATE pr_verification_request_arms SET task_id=$2 WHERE request_id=$1',
            [key.slice('request:'.length), sibling],
          );
          await finish(old, 'ERROR', 'FAILED');
          await finish(sibling);
          const next = await create();
          await assert.rejects(rerun(key, old, next, true), /fixture-rollback/);
          assert.equal(
            (
              await db.query('SELECT 1 FROM pr_feishu_runs WHERE run_key=$1', [
                pair,
              ])
            ).rowCount,
            0,
          );
          const first = await rerun(key, old, next);
          const latest = await create();
          const second = await rerun(key, old, latest);
          await activate(latest);
          // 同 case 的真正独立运行不能被按 caseId 一并屏蔽。
          const standalone = await create();
          await db.query(
            `UPDATE pr_tasks SET definition=jsonb_set(definition,'{caseV2Definition}',jsonb_build_object('caseId',$2::text)) WHERE id=$1`,
            [standalone, old],
          );
          const latestKey = `${key}:${second.hash}`;
          await sync(latestKey, 1);
          await sync(standalone, 1);
          for (let i = 0; i < 6; i++) await tick();
          for (const retired of [pair, next, key, `${key}:${first.hash}`])
            assert.equal((await messages(retired)).length, 0);
          await finish(latest);
          await finish(standalone);
          await sync(latestKey, 2);
          await sync(standalone, 2);
        },
      );

      // 范围：已有 HITL 消息的活动请求被重跑替换后停止旧轮次，新 HITL 只引用新任务；外部执行均为夹具。
      await suite.test('活动请求重跑不会把新任务拼入旧人工卡片', async () => {
        const old = await create();
        const key = await request([old]);
        await activate(old);
        await control.change(old, WORKER, 'request', 0, '旧运行等待登录');
        const original = await sync(key, 2);
        const cards = original.map((row) =>
          JSON.stringify(remote.cards.get(row.message_id)),
        );
        const next = await create();
        const registration = await rerun(key, old, next);
        const rerunKey = `${key}:${registration.hash}`;
        await activate(next);
        await control.change(next, WORKER, 'request', 0, '新运行等待登录');
        const current = await sync(rerunKey, 2);
        assert.ok(
          current.some(
            (row) => row.event.kind === 'HITL' && row.event.taskId === next,
          ),
        );
        assert.deepEqual(
          original.map((row) =>
            JSON.stringify(remote.cards.get(row.message_id)),
          ),
          cards,
        );
        assert.equal((await messages(old)).length, 0);
        await finish(old, 'CANCELLED');
        await finish(next);
        await sync(rerunKey, 3);
      });

      // 范围：新请求复用仍待人工的旧任务、提交顺序和缺报告终态；不验证公共 API 或真实飞书时序。
      await suite.test(
        '复用活动 case 先发请求主卡片，缺报告仍保守汇总',
        async () => {
          const id = await create();
          await activate(id);
          await control.change(id, WORKER, 'request', 0, '旧请求等待登录');
          const first = await request([id]);
          await sync(first, 2);
          const second = await request([id]);
          const rows = await sync(second, 2);
          const sent = remote.sends.filter((uuid) =>
            rows.some((row) => row.id === uuid),
          );
          assert.equal(
            rows.find((row) => row.id === sent[0])!.event.kind,
            'SUBMITTED',
          );
          assert.ok(
            JSON.stringify(
              remote.cards.get(
                rows.find((row) => row.event.kind === 'HITL')!.message_id,
              ),
            ).includes('/#/hitl/'),
          );
          await finish(id, 'CANCELLED');
          await db.query('UPDATE pr_tasks SET report=NULL WHERE id=$1', [id]);
          await sync(first, 3);
          const done = await sync(second, 3);
          const report = remote.cards.get(
            done.find((row) => row.event.kind === 'COMPLETED')!.message_id,
          );
          assert.ok(!JSON.stringify(report).includes('报告覆盖：'));
          assert.ok(JSON.stringify(report).includes('最终结论：证据不足'));
          assert.notEqual(report.header.template, 'green');
        },
      );

      // 范围：升级保留活动请求旧消息身份、抑制已结束历史请求重发；只执行真实迁移 SQL，不访问飞书。
      await suite.test(
        '旧 case 通知迁移到请求，继续更新原主卡片和 HITL 卡片',
        async () => {
          const id = await create();
          await activate(id);
          await control.change(id, WORKER, 'request', 0, '升级前登录');
          const before = await sync(id, 2);
          const history = await create();
          await finish(history);
          await sync(history, 2);
          const key = await request([id]);
          const historicalKey = await request([history]);
          // 模拟升级前按控制事件命名的 HITL 记录，迁移不能另建消息身份。
          await db.query(
            "UPDATE pr_feishu_messages SET event_key='control-999',event=jsonb_set(event,'{key}','\"control-999\"') WHERE run_key=$1 AND event->>'kind'='HITL'",
            [id],
          );
          await db.query(
            await readFile(
              new URL(
                '../migrations/026-feishu-request-cards.sql',
                import.meta.url,
              ),
              'utf8',
            ),
          );
          const migrated = await sync(key, 2);
          assert.deepEqual(
            new Set(migrated.map((row) => row.message_id)),
            new Set(before.map((row) => row.message_id)),
          );
          assert.ok(
            JSON.stringify(
              remote.cards.get(
                migrated.find((row) => row.event.kind === 'SUBMITTED')!
                  .message_id,
              ),
            ).includes('验证状态：等待人工处理'),
          );
          assert.equal((await messages(historicalKey)).length, 0);
          await finish(id);
          await sync(key, 3);
          assert.equal((await messages(id)).length, 0);
        },
      );

      // 范围：真实控制面事件、恢复不新增消息、旧卡片状态和按钮同步；不验证真实飞书渲染。
      await suite.test(
        '提交和首次 HITL 发卡片，恢复原位更新，完成另发报告',
        async () => {
          const id = await create();
          let rows = await sync(id, 1);
          const original = rows[0]!.event;
          await activate(id);
          await control.change(id, WORKER, 'request', 0, '请登录', [
            '登录并确认权限',
          ]);
          await control.change(id, WORKER, 'request', 0, '重复请求');
          await control.change(id, WORKER, 'acknowledge', 1);
          rows = await sync(id, 2);
          for (const row of rows)
            assert.ok(
              JSON.stringify(remote.cards.get(row.message_id)).includes(
                '/#/hitl/',
              ),
            );
          await control.change(id, null, 'resume', 1);
          rows = await sync(id, 2);
          for (const row of rows)
            assert.ok(
              !JSON.stringify(remote.cards.get(row.message_id)).includes(
                '/#/hitl/',
              ),
            );
          const hitl = rows.find((row) => row.event.kind === 'HITL')!;
          assert.ok(
            JSON.stringify(remote.cards.get(hitl.message_id)).includes(
              '执行中',
            ),
          );
          await finish(id, 'COMPLETED', 'FAILED');
          rows = await sync(id, 3);
          assert.deepEqual(
            rows.find((row) => row.event.kind === 'SUBMITTED')!.event,
            original,
          );
          assert.deepEqual(
            new Set(rows.map((row) => row.event.kind)),
            new Set(['SUBMITTED', 'HITL', 'COMPLETED']),
          );
          for (const row of rows) {
            const card = remote.cards.get(row.message_id);
            assert.equal(card.header.title.content, '自动化测试 · 执行完成');
            assert.ok(JSON.stringify(card).includes('验收失败'));
            assert.ok(JSON.stringify(card).includes('/#/reports/'));
          }
          const sent = remote.sends.length;
          await tick();
          await tick();
          assert.equal(remote.sends.length, sent);
        },
      );

      // 范围：快于扫描的多轮人工请求合并为一张卡片；不声称网络能瞬时同步。
      await suite.test('连续两轮 HITL 和恢复复用同一 Case 卡片', async () => {
        const id = await create();
        await activate(id);
        for (const revision of [0, 2]) {
          await control.change(
            id,
            WORKER,
            'request',
            revision,
            `第${revision / 2 + 1}轮处理`,
          );
          await control.change(id, WORKER, 'acknowledge', revision + 1);
          await control.change(id, null, 'resume', revision + 1);
        }
        await finish(id);
        const rows = await sync(id, 3);
        const observed = remote.sends
          .filter((uuid) => rows.some((row) => row.id === uuid))
          .map((uuid) => rows.find((row) => row.id === uuid)!.event.kind);
        assert.deepEqual(observed, ['SUBMITTED', 'HITL', 'COMPLETED']);
        for (const row of rows)
          assert.ok(
            !JSON.stringify(remote.cards.get(row.message_id)).includes(
              '/#/hitl/',
            ),
          );
      });

      // 范围：比较组以本轮 comparison.id 聚合，不能错误关联 sourceTaskId；单组结束不发整例完成。
      await suite.test('双组 Case 仅提交一次，两组结束后才发完成', async () => {
        const key = randomUUID();
        const a = await create(key, 'llm');
        const b = await create(key, 'jev');
        await activate(a);
        await activate(b);
        await control.change(a, WORKER, 'request', 0, 'A 登录');
        await control.change(b, WORKER, 'request', 0, 'B 登录');
        let rows = await sync(key, 2);
        for (const row of rows) {
          const body = JSON.stringify(remote.cards.get(row.message_id));
          assert.ok(body.includes(`处理任务 ${a}`));
          assert.ok(body.includes(`处理任务 ${b}`));
          assert.ok(!body.includes('different-source-task'));
        }
        await finish(a);
        for (let i = 0; i < 3; i++) await tick();
        assert.equal(
          (await messages(key)).some((row) => row.event.kind === 'COMPLETED'),
          false,
        );
        await finish(b, 'TIMED_OUT', 'INCONCLUSIVE');
        rows = await sync(key, 3);
        for (const row of rows) {
          const body = JSON.stringify(remote.cards.get(row.message_id));
          assert.ok(body.includes('执行已结束'));
          assert.ok(body.includes('已超时'));
          assert.ok(body.includes('验收通过'));
          assert.ok(body.includes('证据不足'));
        }
      });

      // 范围：送达回执丢失后跨 API/数据库重启重用 uuid 和原始内容，随后补最新状态；不保证超过一小时仍可去重。
      await suite.test('未知发送结果跨重启恢复并更新到最新状态', async () => {
        const id = await create();
        remote.loseReceipt = true;
        await tick();
        const pending = (await messages(id))[0]!;
        assert.equal(pending.message_id, null);
        assert.ok(pending.send_next_at.getTime() > Date.now() + 8000);
        const sent = remote.sends.length;
        await service.close();
        await db.close();
        db = new Database(url.toString());
        await db.start();
        control = notificationControl(db);
        service = new CaseNotifications(db, config, log, remote);
        await tick();
        assert.equal(remote.sends.length, sent);
        await activate(id);
        await control.change(id, WORKER, 'request', 0, '登录');
        await tick(true);
        const rows = await sync(id, 2);
        assert.equal(
          remote.sends.filter((uuid) => uuid === pending.id).length,
          2,
        );
        assert.equal(remote.originals.size, remote.cards.size);
        for (const row of rows)
          assert.ok(
            JSON.stringify(remote.cards.get(row.message_id)).includes(
              '等待人工处理',
            ),
          );
        assert.ok(!JSON.stringify(rows).includes('/#/hitl/'));
        assert.ok(!JSON.stringify(rows).includes(ADMIN));
        await finish(id);
        await sync(id, 3);
      });

      // 范围：单张旧卡片失败独立退避，其他卡片仍更新；新版本重置失败次数，不模拟飞书实际频控。
      await suite.test(
        '部分旧卡片更新失败不会阻塞其他卡片，状态变化可以重新同步',
        async () => {
          const id = await create();
          let rows = await sync(id, 1);
          const first = rows[0]!.message_id;
          remote.failUpdate = first;
          await activate(id);
          await control.change(id, WORKER, 'request', 0, '登录');
          await tick();
          rows = await messages(id);
          const hitl = rows.find((row) => row.event.kind === 'HITL')!;
          assert.ok(hitl.message_id);
          assert.equal(
            remote.cards.get(first).header.title.content,
            '自动化测试 · 排队中',
          );
          assert.equal(
            remote.cards.get(hitl.message_id).header.title.content,
            '自动化测试 · 等待人工处理',
          );
          for (let i = 0; i < 5; i++) await tick(true);
          assert.equal(
            (await messages(id)).find((row) => row.message_id === first)!
              .update_attempts,
            5,
          );
          const attempted = remote.updates.filter(
            (value) => value === first,
          ).length;
          await tick(true);
          assert.equal(
            remote.updates.filter((value) => value === first).length,
            attempted,
          );
          remote.failUpdate = undefined;
          await finish(id);
          rows = await sync(id, 3);
          for (const row of rows)
            assert.equal(
              remote.cards.get(row.message_id).header.title.content,
              '自动化测试 · 执行完成',
            );
        },
      );

      // 范围：过期链接先移除入口，续期使用新身份；取消直接形成终态，不会发送恢复事件。
      await suite.test('链接过期、轮换和取消同步到旧卡片', async () => {
        const id = await create();
        await activate(id);
        await control.change(id, WORKER, 'request', 0, '登录');
        const rows = await sync(id, 2);
        await db.query(
          "UPDATE pr_interventions SET expires_at=clock_timestamp()-interval '1 second' WHERE execution_id=$1",
          [id],
        );
        await tick();
        for (const row of rows)
          assert.ok(
            !JSON.stringify(remote.cards.get(row.message_id)).includes(
              '/#/hitl/',
            ),
          );
        const next = await control.currentInterventionId(id);
        await tick();
        for (const row of rows)
          assert.ok(
            JSON.stringify(remote.cards.get(row.message_id)).includes(
              `/#/hitl/${next}/`,
            ),
          );
        await finish(id, 'CANCELLED', 'SKIPPED');
        const done = await sync(id, 3);
        assert.equal(
          done.some((row) => row.event.kind === 'RESUMED'),
          false,
        );
        for (const row of done)
          assert.ok(
            !JSON.stringify(remote.cards.get(row.message_id)).includes(
              '/#/hitl/',
            ),
          );
      });

      // 范围：共享验收投影隔离清理故障，缺少验收证据不显示通过；报告由 SQL 夹具生成，不验证 Agent 判定。
      await suite.test(
        '验收结论与 Console 一致，清理失败不覆盖业务结果',
        async () => {
          const id = await create();
          await finish(id);
          await db.query(
            `UPDATE pr_tasks SET definition=definition||$2::jsonb,report=report||$3::jsonb WHERE id=$1`,
            [
              id,
              {
                steps: [{ stepId: 'business' }, { stepId: 'cleanup' }],
                cleanupStepIds: ['cleanup'],
                acceptanceCriteria: [
                  { id: 'visible', stepId: 'business' },
                  { id: 'removed', stepId: 'cleanup' },
                ],
              },
              {
                verdict: 'FAILED',
                steps: [
                  { stepId: 'business', status: 'COMPLETED' },
                  { stepId: 'cleanup', status: 'FAILED' },
                ],
                criteria: [
                  { criterionId: 'visible', verdict: 'PASSED' },
                  { criterionId: 'removed', verdict: 'FAILED' },
                ],
              },
            ],
          );
          const rows = await sync(id, 2);
          for (const row of rows) {
            const card = remote.cards.get(row.message_id);
            assert.ok(JSON.stringify(card).includes('验收通过'));
            assert.equal(card.header.template, 'green');
          }
          const incomplete = await create();
          await finish(incomplete);
          await db.query(
            `UPDATE pr_tasks SET report=jsonb_set(report,'{criteria}','[]') WHERE id=$1`,
            [incomplete],
          );
          const missing = await sync(incomplete, 2);
          for (const row of missing) {
            const card = remote.cards.get(row.message_id);
            assert.ok(JSON.stringify(card).includes('证据不足'));
            assert.equal(card.header.template, 'grey');
          }
        },
      );

      // 范围：真实无法处理事务直接结束 Case；失联执行不提供入口，不模拟 Node 断网和真实飞书。
      await suite.test(
        '租约失效移除入口，人工无法处理直接同步终态',
        async () => {
          const id = await create();
          await activate(id);
          await control.change(id, WORKER, 'request', 0, '需要人工登录');
          await control.change(id, WORKER, 'acknowledge', 1);
          const rows = await sync(id, 2);
          await db.query(
            "UPDATE pr_executions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [id],
          );
          await tick();
          for (const row of rows)
            assert.ok(
              !JSON.stringify(remote.cards.get(row.message_id)).includes(
                '/#/hitl/',
              ),
            );
          await db.query(
            "UPDATE pr_executions SET lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
            [id],
          );
          await control.unable(id, 1, '没有登录权限', config.publicUrl);
          const result = await readCase(db, id);
          assert.equal(result.view.terminal, true);
          assert.equal(
            result.events.some((event) => event.kind === 'RESUMED'),
            false,
          );
          const done = await sync(id, 3);
          for (const row of done) {
            const body = JSON.stringify(remote.cards.get(row.message_id));
            assert.ok(body.includes('没有登录权限'));
            assert.ok(!body.includes('/#/hitl/'));
          }
        },
      );

      // 范围：发送重试上限、未知结果去重窗口、删除及十四天窗口各自停止；不表示能突破飞书限制。
      await suite.test('发送和更新的重试与平台时间边界', async () => {
        const id = await create();
        remote.failSend = true;
        for (let i = 0; i < 6; i++) await tick(true);
        const failed = (await messages(id))[0]!;
        assert.equal(failed.send_attempts, 5);
        assert.equal(
          remote.sends.filter((uuid) => uuid === failed.id).length,
          5,
        );
        remote.failSend = false;
        await finish(id);
        await tick();
        const unknown = await create();
        remote.loseReceipt = true;
        await tick();
        const before = remote.sends.length;
        await db.query(
          "UPDATE pr_feishu_messages SET first_attempt_at=clock_timestamp()-interval '56 minutes' WHERE run_key=$1",
          [unknown],
        );
        await tick(true);
        assert.equal(remote.sends.length, before);
        await finish(unknown);
        await tick();
        const old = await create();
        let rows = await sync(old, 1);
        const oldest = rows[0]!.message_id;
        await db.query(
          "UPDATE pr_feishu_messages SET first_attempt_at=clock_timestamp()-interval '15 days' WHERE run_key=$1",
          [old],
        );
        await activate(old);
        await control.change(old, WORKER, 'request', 0, '登录');
        await tick();
        assert.equal(
          (await messages(old)).find((row) => row.message_id === oldest)!
            .uneditable,
          true,
        );
        rows = await messages(old);
        const active = rows.find((row) => row.event.kind === 'HITL')!;
        remote.deleted = active.message_id;
        await finish(old);
        await tick();
        assert.equal(
          (await messages(old)).find((row) => row.id === active.id)!.uneditable,
          true,
        );
        remote.deleted = undefined;
      });

      // 范围：节点模板、独立清理和首次启用前已存在的任务不推送，切换群不操作旧群消息；不验收真实应用群权限。
      await suite.test('过滤非业务会话并隔离不同群的投递记录', async () => {
        const id = await create();
        await activate(id);
        await control.change(id, WORKER, 'request', 0, '维护');
        await db.query(
          'INSERT INTO pr_node_profiles(id,task_id,node_id) SELECT id,$1,$1 FROM pr_interventions WHERE execution_id=$1',
          [id],
        );
        const cleanup = await create(undefined, undefined, 'cleanup');
        const history = await create();
        await db.query(
          "UPDATE pr_tasks SET created_at='2000-01-01' WHERE id=$1",
          [history],
        );
        for (let i = 0; i < 4; i++) await tick();
        assert.equal((await messages(id)).length, 0);
        assert.equal((await messages(cleanup)).length, 0);
        assert.equal((await messages(history)).length, 0);
        const other = new CaseNotifications(
          db,
          { ...config, feishu: { ...config.feishu!, chatId: 'oc_other' } },
          log,
          remote,
        );
        const count = remote.updates.length;
        await other.tick();
        assert.equal(remote.updates.length, count);
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM pr_feishu_destinations',
            )
          ).rows[0]!.n,
          2,
        );
        await other.close();
        const { feishu: _unused, ...disabled } = config;
        const off = new CaseNotifications(db, disabled, log, remote);
        await off.tick();
        await off.close();
      });

      // 范围：独立扫描器确实启动，关闭取消挂起投递；不模拟操作系统强杀或真实公网断连。
      await suite.test('关闭通知扫描器中断慢发送并保留进度', async () => {
        const id = await create();
        remote.hang = true;
        const count = remote.sends.length;
        await service.start();
        await until(
          () => remote.sends.length,
          (value) => value > count,
        );
        await service.close();
        assert.equal((await messages(id))[0]!.message_id, null);
        assert.ok(
          !JSON.stringify(warnings).includes('private-transport-error'),
        );
        assert.ok(!JSON.stringify(warnings).includes(config.feishu!.appSecret));
      });
    } finally {
      await service.close();
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);

/** 通知夹具没有节点连接：只验证事务内状态和卡片，不声称交接已获真实节点确认。 */
function notificationControl(db: Database) {
  const control = new ExecutionControl(db, ADMIN);
  const change = control.change.bind(control);
  control.change = (...args) =>
    db.transaction((client) => {
      args[10] = client;
      return change(...args);
    });
  return control;
}

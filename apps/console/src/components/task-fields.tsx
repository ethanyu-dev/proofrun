import type { VerificationTask } from '@proofrun/contracts';

/** 当前服务支持的证据类型，截图与网络证据还需执行节点具备对应能力。 */
const EVIDENCE = ['DOM', 'SCREENSHOT', 'NETWORK', 'TRACE'] as const;

/** 三种模式都写入同一任务定义；并行预算按每组计算，不暗示共享浏览器会话。 */
const EXECUTION_MODES = [
  {
    value: 'parallel',
    title: '并行对比',
    description: '纯 LLM 与 LLM + JEV 各运行一组，独立会话与预算。',
  },
  {
    value: 'llm',
    title: '纯 LLM',
    description: '仅运行一组，由 LLM 选择操作、填写内容并验收。',
  },
  {
    value: 'jev',
    title: 'LLM + JEV',
    description: '仅运行一组，由 JEV 选择动作，LLM 填写、纠偏与验收。',
  },
] as const;

/** 编辑完整任务快照；嵌套更新保留 JSON 模式导入的可选配置。 */
export function TaskFields({
  task,
  change,
}: {
  task: VerificationTask;
  change: (task: VerificationTask) => void;
}) {
  const environment = (patch: Partial<VerificationTask['environment']>) =>
    change({ ...task, environment: { ...task.environment, ...patch } });
  // 映射保持非空验收数组；界面禁止删除最后一项或取消最后一种证据。
  const criterion = (
    index: number,
    patch: Partial<VerificationTask['acceptanceCriteria'][number]>,
  ) =>
    change({
      ...task,
      acceptanceCriteria: task.acceptanceCriteria.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ) as VerificationTask['acceptanceCriteria'],
    });
  return (
    <div className="task-fields">
      <fieldset className="execution-mode-picker">
        <legend>执行模式</legend>
        <div className="execution-mode-options">
          {EXECUTION_MODES.map((mode) => (
            <label className="execution-mode-option" key={mode.value}>
              <input
                type="radio"
                name="execution-mode"
                value={mode.value}
                checked={(task.executionMode ?? 'llm') === mode.value}
                onChange={() => change({ ...task, executionMode: mode.value })}
              />
              <span>
                <strong>{mode.title}</strong>
                <span>{mode.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="muted note">
          并行对比会创建两组任务；实际同时运行取决于节点空闲容量。
        </p>
      </fieldset>
      <section className="task-section">
        <h2>验证目标</h2>
        <label>
          目标网址
          <input
            type="url"
            required
            placeholder="https://example.com"
            value={task.target.url}
            onChange={(e) =>
              change({ ...task, target: { url: e.target.value } })
            }
          />
        </label>
        <label>
          任务目标
          <textarea
            required
            rows={4}
            placeholder="描述需要验证的业务流程、检查范围和最终输出。"
            value={task.objective}
            onChange={(e) => change({ ...task, objective: e.target.value })}
          />
        </label>
      </section>
      <section className="task-section">
        <h2>验收标准</h2>
        <p className="muted">
          逐项填写预期结果，执行后将为每项提供结论和证据。
        </p>
        {task.acceptanceCriteria.map((c, i) => (
          <fieldset className="criterion-fields" key={i}>
            <legend>验收项 {i + 1}</legend>
            <div className="task-form-grid">
              <label>
                验收项 ID
                <input
                  required
                  maxLength={128}
                  value={c.id}
                  onChange={(e) => criterion(i, { id: e.target.value })}
                />
              </label>
              <label>
                检查内容
                <input
                  required
                  value={c.description}
                  placeholder="例如：GLM 价格表"
                  onChange={(e) =>
                    criterion(i, { description: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              预期结果
              <textarea
                required
                rows={3}
                value={c.expectedResult}
                placeholder="描述什么结果才算通过，以及需核对的细节。"
                onChange={(e) =>
                  criterion(i, { expectedResult: e.target.value })
                }
              />
            </label>
            <div
              className="evidence-options"
              role="group"
              aria-label={`验收项 ${i + 1} 的证据类型`}
            >
              <span>证据类型</span>
              {EVIDENCE.map((kind) => (
                <label className="check-label" key={kind}>
                  <input
                    type="checkbox"
                    checked={c.evidenceKinds.includes(kind)}
                    disabled={
                      c.evidenceKinds.length === 1 &&
                      c.evidenceKinds.includes(kind)
                    }
                    onChange={(e) =>
                      criterion(i, {
                        evidenceKinds: (e.target.checked
                          ? [...c.evidenceKinds, kind]
                          : c.evidenceKinds.filter(
                              (k) => k !== kind,
                            )) as typeof c.evidenceKinds,
                      })
                    }
                  />
                  {kind}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={task.acceptanceCriteria.length === 1}
              onClick={() =>
                change({
                  ...task,
                  acceptanceCriteria: task.acceptanceCriteria.filter(
                    (_, n) => n !== i,
                  ) as VerificationTask['acceptanceCriteria'],
                })
              }
            >
              移除此项
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            change({
              ...task,
              acceptanceCriteria: [
                ...task.acceptanceCriteria,
                {
                  id: `criterion-${crypto.randomUUID().slice(0, 8)}`,
                  description: '',
                  expectedResult: '',
                  evidenceKinds: ['DOM'],
                },
              ],
            })
          }
        >
          添加验收项
        </button>
      </section>
      <section className="task-section">
        <h2>执行设置</h2>
        <div className="task-form-grid">
          <label>
            环境名称
            <input
              required
              value={task.environment.id}
              onChange={(e) => environment({ id: e.target.value })}
            />
          </label>
          <label>
            节点池
            <input
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={128}
              value={task.environment.nodePool}
              onChange={(e) => environment({ nodePool: e.target.value })}
            />
          </label>
          <label>
            最大动作次数
            <input
              type="number"
              required
              min={1}
              max={10000}
              step={1}
              value={task.budget.maxActions || ''}
              onChange={(e) =>
                change({
                  ...task,
                  budget: {
                    ...task.budget,
                    maxActions: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            总时间预算（分钟）
            <input
              type="number"
              required
              min={1 / 60000}
              max={1440}
              step="any"
              value={task.budget.timeoutMs ? task.budget.timeoutMs / 60000 : ''}
              onChange={(e) =>
                change({
                  ...task,
                  budget: {
                    ...task.budget,
                    timeoutMs: Math.round(Number(e.target.value) * 60000),
                  },
                })
              }
            />
          </label>
        </div>
        <p className="muted">总时间包含排队与等待人工的时间。</p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={task.environment.allowIntervention ?? false}
            onChange={(e) =>
              environment({ allowIntervention: e.target.checked })
            }
          />
          允许人工辅助
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={
              !!(
                task.environment.reuseAuth ?? task.environment.allowIntervention
              )
            }
            disabled={!!task.environment.auth}
            onChange={(e) => environment({ reuseAuth: e.target.checked })}
          />
          自动复用本站登录状态
        </label>
        <p className="muted note">
          人工处理完成后保存登录。后续任务优先沿用原节点；路由变更或节点不可用时可能需要重新登录。并行两组使用同一节点的初始快照和独立浏览器。
        </p>
        <details>
          <summary>高级设置：任务 ID 与登录状态</summary>
          <label>
            任务 ID
            <input
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={128}
              value={task.taskId}
              onChange={(e) => change({ ...task, taskId: e.target.value })}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={!!task.environment.auth}
              onChange={(e) => {
                if (e.target.checked)
                  environment({
                    auth: { nodeId: '', stateId: '', restore: true },
                  });
                else {
                  const { auth: _auth, ...rest } = task.environment;
                  change({ ...task, environment: rest });
                }
              }}
            />
            使用节点登录状态
          </label>
          {task.environment.auth && (
            <div className="task-form-grid">
              <label>
                登录状态所属节点
                <input
                  required
                  pattern="[A-Za-z0-9_-]+"
                  maxLength={128}
                  value={task.environment.auth.nodeId}
                  onChange={(e) =>
                    environment({
                      auth: {
                        ...task.environment.auth!,
                        nodeId: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                登录状态名称
                <input
                  required
                  pattern="[A-Za-z0-9_-]+"
                  maxLength={128}
                  value={task.environment.auth.stateId}
                  onChange={(e) =>
                    environment({
                      auth: {
                        ...task.environment.auth!,
                        stateId: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={task.environment.auth.restore}
                  onChange={(e) =>
                    environment({
                      auth: {
                        ...task.environment.auth!,
                        restore: e.target.checked,
                      },
                    })
                  }
                />
                恢复已有登录状态
              </label>
            </div>
          )}
        </details>
      </section>
    </div>
  );
}

import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import type { VerificationTask } from '@proofrun/contracts';

/** 当前服务支持的证据类型，截图与网络证据还需执行节点具备对应能力。 */
const EVIDENCE = ['DOM', 'SCREENSHOT', 'NETWORK', 'TRACE'] as const;

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
      <p className="muted">由 LLM 执行验证，每个任务使用独立浏览器会话。</p>
      <section className="task-section">
        <h2>验证目标</h2>
        <label>
          目标网址
          <Input
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
          <Textarea
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
                <Input
                  required
                  maxLength={128}
                  value={c.id}
                  onChange={(e) => criterion(i, { id: e.target.value })}
                />
              </label>
              <label>
                检查内容
                <Input
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
              <Textarea
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
                  <Input
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
            <Button
              variant="outline"
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
            </Button>
          </fieldset>
        ))}
        <Button
          variant="outline"
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
        </Button>
      </section>
      <section className="task-section">
        <h2>执行设置</h2>
        <div className="task-form-grid">
          <label>
            环境名称
            <Input
              required
              value={task.environment.id}
              onChange={(e) => environment({ id: e.target.value })}
            />
          </label>
          <label>
            节点池
            <Input
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={128}
              value={task.environment.nodePool}
              onChange={(e) => environment({ nodePool: e.target.value })}
            />
          </label>
          <label>
            最大动作次数
            <Input
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
            <Input
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
          <Input
            type="checkbox"
            checked={task.environment.allowIntervention ?? false}
            onChange={(e) =>
              environment({ allowIntervention: e.target.checked })
            }
          />
          允许人工辅助
        </label>
        <p className="muted note">
          每次任务使用独立临时浏览器；人工辅助仅修改当前会话，不保存登录基准。
        </p>
        <details>
          <summary>高级设置：任务 ID</summary>
          <label>
            任务 ID
            <Input
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={128}
              value={task.taskId}
              onChange={(e) => change({ ...task, taskId: e.target.value })}
            />
          </label>
        </details>
      </section>
    </div>
  );
}

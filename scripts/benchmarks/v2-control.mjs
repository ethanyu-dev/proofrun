import { RealControl } from './real-control.mjs';

/** 真实站点控制端口复用生产宿主，保留分组、步骤及不同类型的真实证据。 */
export class V2Control extends RealControl {
  steps = [];
  /** 仅状态迁移写入进度日志，避免每次保存结论都重复刷屏。 */
  statuses = new Map();
  constructor(host, scenario, directory) {
    super(
      host,
      { origin: new URL(scenario.task.target.url).origin },
      scenario,
      directory,
    );
    this.task = scenario.task;
    this.origins = new Set(
      scenario.task.steps.map((step) => new URL(step.url).origin),
    );
  }
  /** 只允许源任务列出的站点导航；页面与模型不能新增任意目标源。 */
  authorize(operation) {
    if (
      operation.type === 'browser.act' &&
      ['navigate', 'tab.new'].includes(operation.action)
    ) {
      const url = new URL(operation.target);
      if (!this.origins.has(url.origin) || url.username || url.password)
        throw new Error('V2 基准禁止导航到任务之外的站点');
    }
  }
  /** 按真实宿主启动回执证明空白访客 profile，不能用任务 mode 替代节点事实。 */
  async view(execution) {
    return {
      ...(await super.view()),
      ...(this.host.environmentProof
        ? {
            environmentProof: {
              ...this.host.environmentProof,
              sessionId: execution.sessionId,
            },
          }
        : {}),
    };
  }
  /** 保存执行器真实步骤快照；预算仍由既有步骤执行器约束，不在回写时重置。 */
  async recordSteps(_execution, steps) {
    this.steps = structuredClone(steps);
    for (const step of steps) {
      if (this.statuses.get(step.stepId) !== step.status) {
        this.statuses.set(step.stepId, step.status);
        if (step.status !== 'PENDING')
          console.log(`V2 ${this.scenario.id} ${step.stepId} ${step.status}`);
      }
    }
  }
}

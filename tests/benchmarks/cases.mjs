import assert from 'node:assert/strict';
import { finish } from '../agent/fixture.mjs';

/** 固定场景门限独立于本次测量，不能用候选结果自动放宽。 */
export const LIMITS = {
  maxContextChars: 12000,
  maxTurns: 8,
  peakContext: 12000,
};

/** 表单脚本根据当前轮次提出动作，最终业务事实由控制端口独立核对。 */
function form(context, turn) {
  if (turn === 1)
    return {
      type: 'browser.act',
      action: 'fill',
      target: '@e1',
      value: 'Alice',
    };
  if (turn === 2)
    return { type: 'browser.act', action: 'click', target: '@e2' };
  return finish(context);
}
/** 每个场景独立初始化控制端口；模型回复和页面都是合成夹具，不证明真实模型或浏览器质量。 */
export const cases = [
  {
    id: 'form-submit',
    name: '表单填写与单次提交',
    maxRounds: 3,
    scope:
      '验证填写 → 提交 → 重新观察及证据结算；不覆盖真实 DOM、网络写入和模型准确率。',
    prepare() {},
    decide: form,
    verify(control, report) {
      assert.equal(report.verdict, 'PASSED');
      assert.equal(control.value, 'Alice');
      assert.equal(
        control.calls.filter((call) => call.operation.action === 'click')
          .length,
        1,
      );
      assert.equal(control.submitted, true);
    },
  },
  {
    id: 'read-only',
    name: '只读观察与证据结算',
    maxRounds: 1,
    scope: '验证已有证据直接结算且不派发写动作；不证明真实页面内容与业务断言。',
    prepare(control, execution) {
      control.pageText = '当前状态：已就绪';
      execution.task.objective = '读取当前状态并核对已就绪';
      execution.task.acceptanceCriteria[0].expectedResult = '已就绪';
    },
    decide: finish,
    verify(control, report) {
      assert.equal(report.verdict, 'PASSED');
      assert.equal(
        control.calls.filter(
          (call) =>
            call.operation.type === 'browser.act' &&
            call.operation.action !== 'navigate',
        ).length,
        0,
      );
    },
  },
  {
    id: 'invalid-target',
    name: '无效目标拒绝与恢复',
    maxRounds: 4,
    scope:
      '验证非法目标不派发、下一轮携带反馈并恢复提交；不覆盖真实浏览器目标失效时序。',
    prepare() {},
    decide(context, turn) {
      if (turn === 1)
        return { type: 'browser.act', action: 'click', target: '@missing' };
      if (turn === 2) assert(context.feedback.length > 0, '拒绝后必须交付反馈');
      return form(context, turn - 1);
    },
    verify(control, report) {
      assert.equal(report.verdict, 'PASSED');
      assert.equal(
        control.calls.some((call) => call.operation.target === '@missing'),
        false,
      );
      assert.equal(
        control.calls.filter((call) => call.operation.action === 'click')
          .length,
        1,
      );
    },
  },
  {
    id: 'unknown-write',
    name: '未知副作用停止重试',
    maxRounds: 2,
    scope:
      '验证可能已提交的回执不会被重放且不误报通过；不覆盖真实浏览器内部重试与远端去重。',
    prepare(control) {
      control.unknown = true;
    },
    decide: form,
    verify(control, report) {
      assert.notEqual(report.verdict, 'PASSED');
      assert.equal(
        control.calls.filter((call) => call.operation.action === 'click')
          .length,
        1,
      );
    },
  },
  {
    id: 'context-pressure',
    name: '长页面上下文裁剪',
    maxRounds: 3,
    scope:
      '验证长正文压缩、保留七模块与约束且完成循环；不证明裁剪后真实模型仍能理解全部业务。',
    prepare(control) {
      control.pageText = '合成长页面内容：名称、提交及辅助说明。'.repeat(3000);
    },
    decide(context, turn) {
      assert(context.page.text.length < 30000);
      return form(context, turn);
    },
    verify(control, report) {
      assert.equal(report.verdict, 'PASSED');
      assert.equal(control.submitted, true);
      assert.equal(control.value, 'Alice');
    },
  },
];

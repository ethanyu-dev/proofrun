/** 场景升级必须修改版本；旧运行不能用新判定规则静默重新评分。 */
export const SCENARIO_VERSION = 1;

/** 范围：受控页面中的真实交互与独立业务记录；均不代表外部网站泛化或生产验收。 */
export const CASES = [
  {
    id: 'E01',
    kind: 'form',
    title: '普通表单提交',
    description:
      '名称填写 Atlas，点击保存一次，然后点击查询记录核对持久化结果。',
    checks: [['saved', '查询结果显示已保存名称 Atlas。']],
  },
  {
    id: 'E02',
    kind: 'validation',
    title: '输入校验与修正',
    description:
      '邮箱先填写 invalid 并按 Tab，核对错误提示；然后改为 atlas@example.test，保存一次并查询记录。',
    checks: [
      ['invalid', '无效邮箱失焦后显示邮箱格式不正确。'],
      ['saved', '查询结果显示已保存邮箱 atlas@example.test。'],
    ],
  },
  {
    id: 'E03',
    kind: 'select',
    title: '同名选项辨别',
    description:
      '打开配送地点下拉，选择 Harbor（西区），不要选择 Harbor（东区）；点击确认并查询结果。',
    checks: [['selected', '查询结果显示已选择 Harbor（西区），编号 west。']],
  },
  {
    id: 'E04',
    kind: 'virtual',
    title: '虚拟列表滚动',
    description: '滚动城市列表内部，找到第 40 项 Harbor，选择并查询结果。',
    checks: [['selected', '查询结果显示已选择 Harbor，编号 city-40。']],
  },
  {
    id: 'E05',
    kind: 'panels',
    title: '多面板阅读',
    description: '分别展开配送时效和退款方式，阅读两项正文并逐项核对。',
    checks: [
      ['delivery', '配送时效正文为标准配送需要三个工作日。'],
      ['refund', '退款方式正文为退款原路返回。'],
    ],
  },
  {
    id: 'E06',
    kind: 'wizard',
    title: '分阶段配置',
    description:
      '项目名称填写 Atlas，进入下一步，勾选启用通知，保存一次，再查询最终配置。',
    checks: [['saved', '查询结果显示项目 Atlas；通知已启用。']],
  },
  {
    id: 'E07',
    kind: 'async',
    title: '异步提交',
    description:
      '名称填写 Atlas，保存一次，等待处理完成，再查询记录；处理期间不要重复提交。',
    checks: [['saved', '查询结果显示已保存名称 Atlas。']],
  },
  // 范围：可通过独立查询识别错误成功提示；不要求模型猜测不可观察的后台事实。
  {
    id: 'E08',
    kind: 'false-success',
    title: '错误成功提示',
    description:
      '名称填写 Atlas，点击保存一次；即使出现保存成功，也必须点击查询记录验证是否真正保存。',
    checks: [['saved', '查询记录后存在已保存的名称 Atlas。']],
  },
  {
    id: 'E09',
    kind: 'guest',
    title: '访客环境',
    description: '以访客身份打开页面，核对当前身份；不要登录，不要执行写入。',
    checks: [['guest', '页面显示当前身份：访客。']],
  },
  // 范围：固定操作脚本通过真实 HITL 协议补入一次验证码；不覆盖真实 SSO 或人工体验。
  {
    id: 'E10',
    kind: 'human',
    title: '人工登录后继续',
    description:
      '需要人工完成一次验证码登录。登录后点击查询记录，核对账号为测试用户；不要自行猜验证码。',
    checks: [['human', '查询结果显示当前身份：测试用户。']],
  },
  {
    id: 'E11',
    kind: 'groups',
    title: '多分组隔离',
    description: '分别完成甲组与乙组的记录写入与查询，各组只操作自己的页面。',
    checks: [
      ['alpha', '查询结果显示甲组已保存 Atlas-A。'],
      ['beta', '查询结果显示乙组已保存 Atlas-B。'],
    ],
  },
  {
    id: 'E12',
    kind: 'cleanup',
    title: '业务与清理',
    description:
      '名称填写 Atlas，保存一次并查询确认。业务验证完成后按 cleanup 删除记录。',
    checks: [['saved', '查询结果显示已保存名称 Atlas。']],
  },
];

/** 冒烟包含正常、已知缺陷和清理；引擎回执丢失属于独立故障层，不伪装成普通页面变体。 */
export function suite(name) {
  if (name === 'smoke')
    return CASES.filter((c) => ['E01', 'E08', 'E12'].includes(c.id));
  if (name === 'core') return CASES;
  const found = CASES.find((c) => c.id === name);
  if (found) return [found];
  throw new Error(`未知场景集合：${name}`);
}

/** 任务不包含判定器或隐藏真值；步骤身份固定，用服务端冻结后的标准序号进行映射。 */
export function definition(scenario, sampleId, fixtureUrl) {
  const url = `${fixtureUrl}/runs/${sampleId}`;
  const step = (
    stepId,
    description,
    expected,
    type = 'verification',
    suffix = '',
  ) => ({
    stepId,
    type,
    url: url + suffix,
    exec_order: 1,
    description,
    policy: [],
    expected,
  });
  let steps = [
    step(
      'verify',
      scenario.description,
      scenario.checks.map((c) => c[1]),
    ),
  ];
  if (scenario.kind === 'groups') {
    steps = ['alpha', 'beta'].flatMap((group, index) => [
      {
        ...step(
          `setup-${group}`,
          `打开${index ? '乙' : '甲'}组页面，确认本组名称。`,
          [],
          'setup',
          `?group=${group}`,
        ),
        exec_order: index * 2 + 1,
      },
      {
        ...step(
          group,
          `名称填写 Atlas-${index ? 'B' : 'A'}，保存一次，点击查询记录。`,
          [scenario.checks[index][1]],
          'verification',
          `?group=${group}`,
        ),
        exec_order: index * 2 + 2,
      },
    ]);
  }
  if (scenario.kind === 'human') {
    steps.unshift({
      ...step(
        'login',
        '请人工完成验证码登录，确认当前身份为测试用户。',
        [],
        'setup',
      ),
      preconditions: [
        {
          id: 'fixture-login',
          method: 'manual',
          description: '人工完成验证码登录并确认当前身份为测试用户',
        },
      ],
    });
    steps[1].exec_order = 2;
  }
  return {
    caseId: sampleId,
    platform: 'ProofRun 隔离测评应用',
    entry: url,
    description: scenario.description,
    session: { mode: scenario.kind === 'human' ? 'manual' : 'guest' },
    steps,
    cleanup:
      scenario.kind === 'cleanup'
        ? [
            {
              ...step('cleanup', '点击删除记录，然后查询确认记录不存在。', [
                '查询结果显示记录不存在。',
              ]),
              type: undefined,
            },
          ].map(({ type: _, ...value }) => value)
        : [],
  };
}

/** 用冻结 stepId 和序号定位，不通过相似中文文案猜测验收项身份。 */
export function bindings(scenario, frozen) {
  return scenario.checks.map(([key], index) => {
    const stepId = scenario.kind === 'groups' ? key : 'verify';
    const position = scenario.kind === 'groups' ? 0 : index;
    const criteria = frozen.acceptanceCriteria.filter(
      (c) => c.stepId === stepId,
    );
    if (!criteria[position]) throw new Error('冻结任务缺少场景验收项');
    return { key, criterionId: criteria[position].id };
  });
}

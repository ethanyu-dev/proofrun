import type { CommandResult, ExecutionView } from '../client.js';
import { AgentFault } from '../http.js';

/** 可见不等于可点击；动作能力来自节点，旧节点缺失字段时仅作兼容处理。 */
export interface ObservedTarget {
  target: string;
  role: string;
  name: string;
  tag?: string;
  value?: string;
  /** 比较键只用于跨观察差分，不能作为动作身份提交。 */
  comparisonKey?: string;
  visible?: boolean;
  visibilityScope?: string;
  disabled?: boolean;
  operations?: string[];
  expanded?: string | boolean | null;
  checked?: string | boolean | null;
  selected?: string | boolean | null;
  activeRegion?: boolean;
  /** 真实 frame 和语义祖先区域用于排序，不赋予旧区域执行权限。 */
  frame?: string;
  region?: {
    key: string | null;
    role: string;
    name: string;
    ancestors?: Array<{ role: string; name: string }>;
  } | null;
  scroll?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
  } | null;
  options?: unknown;
  /** 由执行器比较实际观察得到，不接受模型声明的变化。 */
  change?: 'added' | 'updated';
}

/** 保留平台实际提供的观察，不从页面文本解析伪造的元素身份。 */
export interface Observation {
  /** 每次观察独立生成，旧身份不能被绑定到新的元素。 */
  observationId: string;
  url: string;
  title: string;
  text: string;
  /** 目标只在该次观察范围内有效。 */
  targets: ObservedTarget[];
  /** DOM 和图片不是同一原子快照，模型必须知道采集限制。 */
  atomic: false;
  /** 当前标签页清单、视口与裁剪标记来自节点；模型不能自行补造。 */
  tabs?: unknown;
  viewport?: unknown;
  truncated?: boolean;
  /** 不同采集范围的缺口原样保留；未加载的页面数据不计作已完整覆盖。 */
  coverage?: Record<string, unknown>;
  /** 节点已脱敏的网络元数据；不能用于推断服务端写入次数。 */
  network?: unknown;
  artifactRefs: Array<{
    artifactId: string;
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK';
    sha256: string;
  }>;
}
/** 观察的数据部分仍是扩展对象，因此在模型边界前进行显式类型检查。 */
export function observation(result: CommandResult): Observation {
  const data = result.data as unknown as Observation;
  if (
    !data ||
    typeof data.observationId !== 'string' ||
    !data.observationId ||
    typeof data.text !== 'string' ||
    typeof data.url !== 'string' ||
    typeof data.title !== 'string' ||
    !Array.isArray(data.targets) ||
    data.targets.some(
      (t) =>
        !t ||
        typeof t.target !== 'string' ||
        typeof t.role !== 'string' ||
        typeof t.name !== 'string' ||
        (t.operations !== undefined &&
          (!Array.isArray(t.operations) ||
            t.operations.some((op) => typeof op !== 'string'))) ||
        (t.comparisonKey !== undefined &&
          typeof t.comparisonKey !== 'string') ||
        (t.frame !== undefined && typeof t.frame !== 'string') ||
        (t.region != null &&
          (typeof t.region !== 'object' ||
            typeof t.region.role !== 'string' ||
            typeof t.region.name !== 'string' ||
            (t.region.ancestors !== undefined &&
              (!Array.isArray(t.region.ancestors) ||
                t.region.ancestors.length > 4 ||
                t.region.ancestors.some(
                  (r) =>
                    !r ||
                    typeof r.role !== 'string' ||
                    typeof r.name !== 'string',
                ))) ||
            (t.region.key !== null && typeof t.region.key !== 'string'))),
    ) ||
    !Array.isArray(data.artifactRefs) ||
    data.artifactRefs.some(
      (r) =>
        !r ||
        typeof r.artifactId !== 'string' ||
        !['DOM', 'SCREENSHOT', 'NETWORK'].includes(r.kind) ||
        typeof r.sha256 !== 'string',
    )
  ) {
    throw new AgentFault('INVALID_OBSERVATION', '浏览器未返回完整的结构化观察');
  }
  return {
    observationId: data.observationId,
    url: data.url,
    title: data.title,
    text: data.text,
    targets: data.targets,
    atomic: false,
    tabs: data.tabs,
    viewport: data.viewport,
    truncated: data.truncated === true,
    ...(data.coverage && typeof data.coverage === 'object'
      ? { coverage: data.coverage }
      : {}),
    ...(data.network ? { network: data.network } : {}),
    artifactRefs: data.artifactRefs.map(({ artifactId, kind, sha256 }) => ({
      artifactId,
      kind,
      sha256,
    })),
  };
}
/** 证据可用性以控制面登记为准，命令回复中的 PENDING 不能被直接引用。 */
export function available(observed: Observation, view: ExecutionView): boolean {
  return (
    observed.artifactRefs.some((r) => r.kind === 'DOM') &&
    observed.artifactRefs.every((r) =>
      view.artifacts.some(
        (a) =>
          a.id === r.artifactId &&
          a.state === 'AVAILABLE' &&
          a.kind === r.kind &&
          a.sha256 === r.sha256,
      ),
    )
  );
}

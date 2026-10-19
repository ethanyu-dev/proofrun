import {
  validateVerificationRequest,
  validateRequestRerun,
  type RequestResultV2,
} from '@proofrun/contracts';
import { ApiError, canonical, digest } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import type { CaseV2Service } from '../cases/v2.js';
import { RequestReader } from './reader.js';

/** 请求只负责归属和一次原子接收，实际执行继续复用 case 服务。 */
export class RequestService {
  constructor(
    /** 复用完整 case 校验和冻结编译，不重写执行规则。 */
    private readonly cases: CaseV2Service,
    /** 请求与全部执行组的唯一事务写入端口。 */
    private readonly tasks: Pick<Coordinator, 'submitCaseBatch'>,
    /** 幂等返回与最终响应使用同一读取投影。 */
    private readonly reader: RequestReader,
  ) {}

  /** 在编译前识别已接收请求，配置撤下后幂等查询仍然有效。 */
  private async replay(
    id: string,
    hash: string,
  ): Promise<RequestResultV2 | null> {
    const existing = await this.reader.identity(id);
    if (!existing) return null;
    if (existing.hash !== hash)
      throw new ApiError(
        409,
        'REQUEST_CONFLICT',
        'requestId 已绑定另一份请求定义',
      );
    return this.reader.get(id);
  }

  /** cases 顺序仅决定首次展示顺序；case 内数组仍按原定义参与哈希。 */
  async submit(input: unknown): Promise<RequestResultV2> {
    if (!validateVerificationRequest(input))
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        '需要 requestId、可选 title 和 1–32 个 case',
      );
    if (new Set(input.cases.map((c) => c.caseId)).size !== input.cases.length)
      throw new ApiError(422, 'INVALID_CASE', '请求内 caseId 不能重复');
    const title = input.title ?? input.requestId;
    const hash = digest(
      canonical({
        title,
        cases: [...input.cases].sort((a, b) =>
          a.caseId.localeCompare(b.caseId),
        ),
      }),
    );
    const replay = await this.replay(input.requestId, hash);
    if (replay) return replay;
    const definitions = await this.cases.prepare(input.cases);
    await this.tasks.submitCaseBatch(definitions, {
      requestId: input.requestId,
      title,
      hash,
    });
    return this.reader.get(input.requestId);
  }

  /** 全部目标必须新建；完整映射与预算选择纳入请求幂等摘要。 */
  async rerun(id: string, input: unknown): Promise<RequestResultV2> {
    if (!validateRequestRerun(input) || input.requestId === id)
      throw new ApiError(
        400,
        'INVALID_RERUN',
        '需要新请求身份和完整 case 映射',
      );
    const source = await this.reader.get(id);
    const sourceIds = new Set(source.cases.map((c) => c.caseId));
    if (
      input.caseIds.length !== sourceIds.size ||
      new Set(input.caseIds.map((c) => c.sourceCaseId)).size !==
        sourceIds.size ||
      new Set(input.caseIds.map((c) => c.caseId)).size !== sourceIds.size ||
      input.caseIds.some(
        (c) => !sourceIds.has(c.sourceCaseId) || sourceIds.has(c.caseId),
      )
    )
      throw new ApiError(
        400,
        'INVALID_RERUN',
        '映射必须覆盖全部来源，且目标身份互不重复并不同于全部旧身份',
      );
    const parameters = {
      sourceRequestId: id,
      caseIds: [...input.caseIds].sort((a, b) =>
        a.sourceCaseId.localeCompare(b.sourceCaseId),
      ),
      budgetMode: input.budgetMode ?? 'current',
      ...(input.timeBudget ? { timeBudget: input.timeBudget } : {}),
    };
    const hash = digest(canonical(parameters));
    const replay = await this.replay(input.requestId, hash);
    if (replay) return replay;
    const mapping = new Map(
      input.caseIds.map((c) => [c.sourceCaseId, c.caseId]),
    );
    const definitions = [];
    for (const member of source.cases)
      definitions.push(
        await this.cases.prepareRerun(
          member.caseId,
          mapping.get(member.caseId)!,
          parameters.budgetMode,
          input.timeBudget,
        ),
      );
    await this.tasks.submitCaseBatch(definitions, {
      requestId: input.requestId,
      title: source.title,
      hash,
      sourceRequestId: id,
      sources: Object.fromEntries(
        input.caseIds.map((c) => [c.caseId, c.sourceCaseId]),
      ),
      rerunParameters: parameters,
    });
    return this.reader.get(input.requestId);
  }
}

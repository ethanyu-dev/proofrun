import type {
  McpTaskCall,
  StepResult,
  VerificationReport,
} from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError, digest } from '../../domain.js';
import type { ArtifactStore } from '../reports/artifacts.js';
import { requireOwned } from './ledger.js';

/** 图像遵循现有节点上限；TRACE 通过受保护下载读取，避免把几十 MiB 灌入模型。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
type EvidenceInput = Extract<
  McpTaskCall,
  { name: 'browser_evidence_read' }
>['arguments'];
/** 仅能读取已交付的同运行证据，数据库中的 AVAILABLE 记录本身不授予访问权限。 */
export class PublicEvidence {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly publicUrl: string,
  ) {}

  async metadata(
    principal: string,
    input: Pick<EvidenceInput, 'runId' | 'evidenceId'>,
  ) {
    await requireOwned(this.db, principal, { kind: 'run', id: input.runId });
    const task = (
      await this.db.query<{
        report: VerificationReport | null;
        steps: StepResult[] | null;
        archived_at: Date | null;
      }>(
        'SELECT report,step_results AS steps,archived_at FROM pr_tasks WHERE id=$1',
        [input.runId],
      )
    ).rows[0]!;
    if (task.archived_at)
      throw new ApiError(410, 'EVIDENCE_EXPIRED', '该运行的证据已清理');
    const refs = new Set([
      ...(task.report?.artifacts.map((ref) => ref.id) ?? []),
      ...(task.report?.steps ?? task.steps ?? []).flatMap((step) => [
        ...step.evidenceRefs,
        ...step.criteria.flatMap((c) => c.evidenceRefs),
      ]),
    ]);
    // 尚未提交进度时，当前外部上下文已交付的截图/DOM 也允许按同运行权限读取。
    const context = (
      await this.db.query(
        'SELECT context FROM pr_external_controllers WHERE run_id=$1 AND principal_id=$2',
        [input.runId, principal],
      )
    ).rows[0]?.context;
    for (const ref of context?.page?.artifactRefs ?? [])
      refs.add(ref.artifactId);
    for (const ref of context?.evidence ?? []) if (ref.id) refs.add(ref.id);
    if (!refs.has(input.evidenceId))
      throw new ApiError(
        404,
        'RESOURCE_NOT_FOUND',
        '证据不属于该运行的已交付结果',
      );
    const row = (
      await this.db.query<{ kind: string; hash: string; size: string | null }>(
        `SELECT a.kind,a.hash,a.size FROM pr_artifacts a JOIN pr_executions e ON e.id=a.execution_id
      WHERE a.id=$1 AND e.task_id=$2 AND a.state='AVAILABLE'`,
        [input.evidenceId, input.runId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', '证据尚不可用');
    return {
      runId: input.runId,
      evidenceId: input.evidenceId,
      kind: row.kind,
      mimeType: row.kind === 'SCREENSHOT' ? 'image/png' : 'application/json',
      sha256: row.hash,
      size: Number(row.size ?? 0),
      uri: `proofrun://runs/${input.runId}/evidence/${input.evidenceId}`,
      downloadUrl: `${this.publicUrl}/v3/runs/${input.runId}/evidence/${input.evidenceId}/download`,
      truncated: false,
    };
  }

  async read(principal: string, input: EvidenceInput) {
    const data = await this.metadata(principal, input);
    if (input.representation !== 'content') {
      if (input.offset !== undefined || input.limit !== undefined)
        throw new ApiError(400, 'INVALID_INPUT', '元数据读取不接受分页');
      return { kind: 'evidence', data };
    }
    if (
      ['TRACE', 'SCREENSHOT'].includes(data.kind) &&
      (input.offset !== undefined || input.limit !== undefined)
    )
      throw new ApiError(400, 'INVALID_INPUT', '二进制证据不支持文本分页');
    if (data.kind === 'TRACE') return { kind: 'evidence', data };
    const artifact = await this.artifacts.read(input.evidenceId);
    const max = data.kind === 'SCREENSHOT' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    let bytes: Buffer;
    if (Buffer.isBuffer(artifact.body)) bytes = artifact.body;
    else {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of artifact.body) {
          const next = Buffer.from(chunk);
          size += next.length;
          if (size > max)
            throw new ApiError(
              422,
              'EVIDENCE_TOO_LARGE',
              '附件请通过受保护下载读取',
            );
          chunks.push(next);
        }
      } finally {
        artifact.body.destroy();
      }
      bytes = Buffer.concat(chunks);
    }
    if (bytes.length > max)
      throw new ApiError(422, 'EVIDENCE_TOO_LARGE', '附件请通过受保护下载读取');
    if (digest(bytes) !== data.sha256)
      throw new ApiError(503, 'EVIDENCE_HASH_MISMATCH', '证据摘要核对失败');
    if (data.kind === 'SCREENSHOT')
      return {
        kind: 'evidence',
        data: {
          ...data,
          size: bytes.length,
          imageBase64: bytes.toString('base64'),
        },
      };
    const text = bytes.toString('utf8');
    const offset = input.offset ?? 0;
    if (offset > text.length)
      throw new ApiError(400, 'INVALID_INPUT', '证据偏移超出正文范围');
    const end = Math.min(text.length, offset + (input.limit ?? 20000));
    return {
      kind: 'evidence',
      data: {
        ...data,
        size: bytes.length,
        text: text.slice(offset, end),
        offset,
        nextOffset: end < text.length ? end : null,
        truncated: offset > 0 || end < text.length,
      },
    };
  }

  /** 下载保留原字节与摘要，鉴权范围与 MCP 证据读取一致。 */
  async download(
    principal: string,
    input: Pick<EvidenceInput, 'runId' | 'evidenceId'>,
  ) {
    const metadata = await this.metadata(principal, input);
    const artifact = await this.artifacts.read(input.evidenceId);
    return { metadata, ...artifact };
  }
}

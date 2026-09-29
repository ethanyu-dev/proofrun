import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PoolClient } from 'pg';
import {
  validateStepResults,
  type StepResult,
  type VerificationReport,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import {
  ApiError,
  canonical,
  digest,
  ID_PATTERN,
  type CommandResult,
} from '../../domain.js';
import type { ExecutionContext } from '../scheduling/state.js';

/** 单张截图上限与节点端一致；流式接收过程中再次计数。 */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
/** Chromium 原始 trace 的最大交付大小。 */
const MAX_TRACE_BYTES = 64 * 1024 * 1024;
/** 只接收节点当前支持的 PNG，不信任单独的 Content-Type 声明。 */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** SHA-256 的规范十六进制表示，避免将任意内容当作摘要。 */
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 证据文件与元数据存储；所有权来自已持久化命令，不来自上传者自行填写。 */
export class ArtifactStore {
  constructor(
    private readonly db: Database,
    private readonly directory: string,
    private readonly publicUrl: string,
  ) {}

  /** 在命令结果事务中登记截图，并将 DOM 观察作为可追溯证据存入数据库。 */
  async register(
    client: PoolClient,
    context: ExecutionContext,
    result: CommandResult,
    observation: boolean,
  ): Promise<CommandResult> {
    const output = structuredClone(result);
    const references = result.data?.artifactRefs ?? [];
    if (!Array.isArray(references) || references.length > 8)
      throw new ApiError(400, 'INVALID_ARTIFACTS', 'Invalid artifact manifest');
    for (const value of references) {
      const ref = value as {
        artifactId?: string;
        kind?: string;
        sha256?: string;
      };
      if (
        !ref ||
        typeof ref.artifactId !== 'string' ||
        !ID_PATTERN.test(ref.artifactId) ||
        !['SCREENSHOT', 'TRACE'].includes(ref.kind ?? '') ||
        typeof ref.sha256 !== 'string' ||
        !HASH_PATTERN.test(ref.sha256)
      )
        throw new ApiError(
          400,
          'INVALID_ARTIFACTS',
          'Invalid screenshot reference',
        );
      await client.query(
        `INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state)
        VALUES($1,$2,$3,$4,$5,$7,$6,'PENDING') ON CONFLICT(id) DO NOTHING`,
        [
          ref.artifactId,
          context.node_id,
          context.id,
          context.session_id,
          result.commandId,
          ref.sha256,
          ref.kind,
        ],
      );
      const owned = await client.query(
        'SELECT 1 FROM pr_artifacts WHERE id=$1 AND node_id=$2 AND command_id=$3 AND hash=$4',
        [ref.artifactId, context.node_id, result.commandId, ref.sha256],
      );
      if (!owned.rowCount)
        throw new ApiError(
          409,
          'ARTIFACT_CONFLICT',
          'Artifact identity already belongs to another command',
        );
    }
    if (observation && result.operationStatus === 'SUCCEEDED') {
      if (
        typeof result.data?.observationId !== 'string' ||
        typeof result.data.text !== 'string'
      )
        throw new ApiError(
          400,
          'INVALID_OBSERVATION',
          'Observation lacks identity or text',
        );
      const content = {
        observationId: result.data.observationId,
        url: result.data.url ?? null,
        title: result.data.title ?? null,
        text: result.data.text,
        targets: result.data.targets ?? [],
        atomic: result.data.atomic ?? false,
        tabs: result.data.tabs ?? [],
        viewport: result.data.viewport ?? null,
        truncated: result.data.truncated ?? false,
        // 采集缺口与原始语义快照属于同一份证据，不能只存在于临时模型上下文中。
        coverage: result.data.coverage ?? null,
        referenceSnapshot: result.data.referenceSnapshot ?? null,
      };
      const bytes = canonical(content);
      const id = randomUUID();
      const hash = digest(bytes);
      await client.query(
        `INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state,size,content,stored_at)
        VALUES($1,$2,$3,$4,$5,'DOM',$6,'AVAILABLE',$7,$8,clock_timestamp())`,
        [
          id,
          context.node_id,
          context.id,
          context.session_id,
          result.commandId,
          hash,
          Buffer.byteLength(bytes),
          content,
        ],
      );
      output.data = {
        ...output.data,
        artifactRefs: [
          ...references,
          { artifactId: id, kind: 'DOM', sha256: hash, status: 'AVAILABLE' },
        ],
      };
    }
    if (
      observation &&
      result.operationStatus === 'SUCCEEDED' &&
      result.data?.network
    ) {
      const content = result.data.network;
      const bytes = canonical(content);
      const id = randomUUID();
      const hash = digest(bytes);
      await client.query(
        `INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state,size,content,stored_at) VALUES($1,$2,$3,$4,$5,'NETWORK',$6,'AVAILABLE',$7,$8,clock_timestamp())`,
        [
          id,
          context.node_id,
          context.id,
          context.session_id,
          result.commandId,
          hash,
          Buffer.byteLength(bytes),
          content,
        ],
      );
      output.data = {
        ...output.data,
        artifactRefs: [
          ...(output.data!.artifactRefs as unknown[]),
          {
            artifactId: id,
            kind: 'NETWORK',
            sha256: hash,
            status: 'AVAILABLE',
          },
        ],
      };
    }
    return output;
  }

  /** 先核实清单和归属，再流式写入、校验、fsync，最后提交存储确认。 */
  async put(
    nodeId: string,
    id: string,
    hash: string,
    body: Readable,
    contentType = 'image/png',
  ): Promise<unknown> {
    if (!ID_PATTERN.test(id) || !HASH_PATTERN.test(hash))
      throw new ApiError(400, 'INVALID_ARTIFACT', 'Invalid artifact identity');
    const row = (
      await this.db.query(
        "SELECT * FROM pr_artifacts WHERE id=$1 AND node_id=$2 AND kind IN ('SCREENSHOT','TRACE')",
        [id, nodeId],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(
        409,
        'MANIFEST_PENDING',
        'Command result manifest must arrive before upload',
      );
    if (
      contentType !==
      (row.kind === 'TRACE'
        ? 'application/vnd.proofrun.trace+json'
        : 'image/png')
    )
      throw new ApiError(
        415,
        'UNSUPPORTED_ARTIFACT',
        'Artifact type differs from manifest',
      );
    if (row.hash !== hash)
      throw new ApiError(
        409,
        'HASH_MISMATCH',
        'Content hash differs from manifest',
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const destination = join(this.directory, id);
    let size = 0;
    let signature = Buffer.alloc(0);
    const checksum = createHash('sha256');
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (
          size > (row.kind === 'TRACE' ? MAX_TRACE_BYTES : MAX_SCREENSHOT_BYTES)
        ) {
          done(
            new ApiError(413, 'ARTIFACT_TOO_LARGE', 'Screenshot exceeds limit'),
          );
          return;
        }
        if (signature.length < PNG_SIGNATURE.length)
          signature = Buffer.concat([signature, chunk]).subarray(
            0,
            PNG_SIGNATURE.length,
          );
        checksum.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        body,
        inspect,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      if (
        (row.kind === 'SCREENSHOT' && !signature.equals(PNG_SIGNATURE)) ||
        checksum.digest('hex') !== hash
      )
        throw new ApiError(
          422,
          'INVALID_CONTENT',
          'PNG signature or SHA-256 mismatch',
        );
      if (row.kind === 'TRACE') {
        let trace: unknown;
        try {
          trace = JSON.parse(await readFile(temporary, 'utf8'));
        } catch {
          throw new ApiError(422, 'INVALID_CONTENT', 'Invalid trace JSON');
        }
        if (
          !trace ||
          typeof trace !== 'object' ||
          !Array.isArray((trace as { traceEvents?: unknown }).traceEvents)
        )
          throw new ApiError(422, 'INVALID_CONTENT', 'Missing trace events');
      }
      const file = await open(temporary, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await this.db.query(
        `UPDATE pr_artifacts SET state=CASE WHEN state='AVAILABLE' THEN state ELSE 'STORED' END,
        size=$2,stored_at=clock_timestamp() WHERE id=$1`,
        [id, size],
      );
      return { artifactId: id, sha256: hash, stored: true };
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /** 节点确认本地交付完成时，控制面必须已经存在真实持久证据。 */
  async available(
    client: PoolClient,
    nodeId: string,
    id: string,
    hash: string,
  ): Promise<void> {
    const result = await client.query(
      "UPDATE pr_artifacts SET state='AVAILABLE' WHERE id=$1 AND node_id=$2 AND hash=$3 AND state IN ('STORED','AVAILABLE')",
      [id, nodeId, hash],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        'ARTIFACT_NOT_STORED',
        'Cannot acknowledge evidence without durable storage',
      );
  }

  /** 下载身份由路由层鉴权；数据库状态未确认的文件不对外宣称可用。 */
  async read(id: string, executionId: string | null = null) {
    if (!ID_PATTERN.test(id))
      throw new ApiError(404, 'ARTIFACT_MISSING', 'Artifact not found');
    const row = (
      await this.db.query(
        "SELECT * FROM pr_artifacts WHERE id=$1 AND state IN ('STORED','AVAILABLE') AND ($2::text IS NULL OR execution_id=$2)",
        [id, executionId],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'ARTIFACT_MISSING', 'Artifact not available');
    return {
      contentType: row.kind !== 'SCREENSHOT' ? 'application/json' : 'image/png',
      body: !['SCREENSHOT', 'TRACE'].includes(row.kind)
        ? Buffer.from(canonical(row.content))
        : createReadStream(join(this.directory, id)),
    };
  }

  /** 验证顺序、稳定身份和证据归属；只验证可审计事实，不代替模型判断业务语义。 */
  async validateSteps(
    client: PoolClient,
    context: ExecutionContext,
    steps: StepResult[],
  ) {
    const invalid = () =>
      new ApiError(422, 'INVALID_STEPS', '步骤身份、顺序、标准或证据无效');
    const definitions = context.definition.steps;
    if (
      !definitions ||
      !validateStepResults(steps) ||
      steps.length !== definitions.length
    )
      throw invalid();
    const previous = (
      await client.query('SELECT step_results FROM pr_tasks WHERE id=$1', [
        context.task_id,
      ])
    ).rows[0]?.step_results as StepResult[] | null;
    const artifacts = (
      await client.query(
        "SELECT id,kind FROM pr_artifacts WHERE execution_id=$1 AND state='AVAILABLE'",
        [context.id],
      )
    ).rows;
    const evidence = new Map(artifacts.map((a) => [a.id, a.kind]));
    let stopped = false;
    for (const [i, step] of steps.entries()) {
      const definition = definitions[i]!;
      if (
        step.stepId !== definition.stepId ||
        (stopped && !['PENDING', 'SKIPPED'].includes(step.status))
      )
        throw invalid();
      const old = previous?.[i];
      if (old?.status === 'COMPLETED' && canonical(old) !== canonical(step))
        throw invalid();
      if (old?.startedAt && old.startedAt !== step.startedAt) throw invalid();
      const expected = context.definition.acceptanceCriteria.filter(
        (c) => c.stepId === step.stepId,
      );
      if (
        step.status === 'COMPLETED' &&
        (step.criteria.length !== expected.length ||
          !step.evidenceRefs.length ||
          !step.startedAt ||
          !step.finishedAt)
      )
        throw invalid();
      if (
        step.startedAt &&
        step.finishedAt &&
        Date.parse(step.finishedAt) < Date.parse(step.startedAt)
      )
        throw invalid();
      if (
        ['PENDING', 'SKIPPED'].includes(step.status) &&
        (step.criteria.length || step.evidenceRefs.length)
      )
        throw invalid();
      if (step.evidenceRefs.some((id) => !evidence.has(id))) throw invalid();
      const seen = new Set<string>();
      for (const criterion of step.criteria) {
        const source = expected.find((c) => c.id === criterion.criterionId);
        if (
          !source ||
          seen.has(criterion.criterionId) ||
          criterion.evidenceRefs.some((id) => !evidence.has(id))
        )
          throw invalid();
        seen.add(criterion.criterionId);
        if (
          ['PASSED', 'FAILED'].includes(criterion.verdict) &&
          source.evidenceKinds.some(
            (kind) =>
              !criterion.evidenceRefs.some((id) => evidence.get(id) === kind),
          )
        )
          throw invalid();
      }
      if (
        step.status !== 'COMPLETED' ||
        (definition.type === 'setup' &&
          step.criteria.some((c) => c.verdict !== 'PASSED'))
      )
        stopped = true;
    }
  }

  /** 报告只能引用本次执行中可用的证据，并覆盖原始任务中的每个验收项。 */
  async validateReport(
    client: PoolClient,
    context: ExecutionContext,
    report: VerificationReport,
  ): Promise<VerificationReport> {
    if (
      report.taskId !== context.task_id ||
      (report.executionDisposition === 'EXECUTED' &&
        report.lifecycle !== 'COMPLETED')
    )
      throw new ApiError(
        422,
        'INVALID_REPORT',
        'Report must belong to this task and preserve execution semantics',
      );
    if (context.definition.steps) {
      if (!report.steps)
        throw new ApiError(422, 'INVALID_REPORT', '结构化任务必须包含逐步结果');
      await this.validateSteps(client, context, report.steps);
      if (
        report.executionDisposition === 'EXECUTED' &&
        report.steps.some((step) => step.status !== 'COMPLETED')
      )
        throw new ApiError(
          422,
          'INVALID_REPORT',
          '未完成所有步骤不能交付正常完成报告',
        );
      for (const step of report.steps) {
        for (const criterion of step.criteria) {
          if (
            canonical(
              report.criteria.find(
                (c) => c.criterionId === criterion.criterionId,
              ),
            ) !== canonical(criterion)
          )
            throw new ApiError(
              422,
              'INVALID_REPORT',
              '步骤与整体验收结论不一致',
            );
        }
      }
      for (const criterion of report.criteria) {
        if (
          !report.steps.some((step) =>
            step.criteria.some((c) => c.criterionId === criterion.criterionId),
          ) &&
          criterion.verdict !== 'SKIPPED'
        )
          throw new ApiError(
            422,
            'INVALID_REPORT',
            '未执行步骤只能标为 SKIPPED',
          );
      }
    } else if (report.steps)
      throw new ApiError(422, 'INVALID_REPORT', '旧任务不接受结构化步骤结果');
    const rows = (
      await client.query(
        "SELECT id,kind,hash FROM pr_artifacts WHERE execution_id=$1 AND state='AVAILABLE'",
        [context.id],
      )
    ).rows;
    const evidence = new Map(rows.map((row) => [row.id as string, row]));
    const criteria = new Map(
      context.definition.acceptanceCriteria.map((c) => [c.id, c]),
    );
    const seen = new Set<string>();
    const included = new Set(report.artifacts.map((a) => a.id));
    if (
      included.size !== report.artifacts.length ||
      report.criteria.length !== criteria.size
    )
      throw new ApiError(
        422,
        'INVALID_REPORT',
        'Duplicate evidence or missing criteria',
      );
    if (
      report.steps?.some((step) =>
        step.evidenceRefs.some((id) => !included.has(id)),
      )
    )
      throw new ApiError(422, 'INVALID_REPORT', '步骤引用了未交付证据');
    for (const artifact of report.artifacts) {
      const source = evidence.get(artifact.id);
      if (
        !source ||
        artifact.kind !== source.kind ||
        artifact.sha256 !== source.hash
      )
        throw new ApiError(
          422,
          'INVALID_REPORT',
          'Evidence is unavailable or belongs to another execution',
        );
    }
    for (const criterion of report.criteria) {
      const expected = criteria.get(criterion.criterionId);
      if (!expected || seen.has(criterion.criterionId))
        throw new ApiError(
          422,
          'INVALID_REPORT',
          'Unknown or duplicated criterion',
        );
      seen.add(criterion.criterionId);
      for (const id of criterion.evidenceRefs)
        if (!included.has(id) || !evidence.has(id))
          throw new ApiError(
            422,
            'INVALID_REPORT',
            'Criterion references missing evidence',
          );
      if (['PASSED', 'FAILED'].includes(criterion.verdict)) {
        const kinds = new Set(
          criterion.evidenceRefs.map((id) => evidence.get(id)?.kind),
        );
        if (expected.evidenceKinds.some((kind) => !kinds.has(kind)))
          throw new ApiError(
            422,
            'INVALID_REPORT',
            'Required evidence kind is absent',
          );
      }
    }
    const verdict = report.criteria.some((c) => c.verdict === 'FAILED')
      ? 'FAILED'
      : report.criteria.every((c) => c.verdict === 'PASSED')
        ? 'PASSED'
        : 'INCONCLUSIVE';
    const executed = report.executionDisposition === 'EXECUTED';
    if (
      (!executed &&
        !context.definition.steps &&
        report.criteria.some((c) => c.verdict !== 'SKIPPED')) ||
      report.verdict !== (executed ? verdict : null)
    )
      throw new ApiError(
        422,
        'INVALID_REPORT',
        'Overall verdict disagrees with criteria',
      );
    return {
      ...report,
      // 终态由控制面决定，吸收取消或截止时间与报告提交的并发竞争。
      lifecycle:
        context.task_state === 'CANCELLED'
          ? 'CANCELLED'
          : context.task_state === 'TIMED_OUT'
            ? 'TIMED_OUT'
            : 'COMPLETED',
      artifacts: report.artifacts.map((a) => ({
        ...a,
        uri: `${this.publicUrl}/v1/artifacts/${a.id}`,
      })),
    };
  }
}

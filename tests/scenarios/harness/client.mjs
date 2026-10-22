import { ID, digest, saveBytes } from './storage.mjs';
import { join } from 'node:path';

/** 有界读取覆盖 API 报告和截图；超限保留错误，不把缺失材料计作通过。 */
const JSON_LIMIT = 8 * 1024 * 1024;
const ARTIFACT_LIMIT = 64 * 1024 * 1024;
const REQUEST_MS = 15_000;

/** 错误只保存 HTTP 状态与固定分类，不输出带凭据的 URL 或响应原文。 */
export class HttpFault extends Error {
  constructor(status) {
    super(`CONTROL_HTTP_${status}`);
    this.status = status;
  }
}

/** 管理凭据只能发送到配置 origin，拒绝重定向和调用方指定的外部证据 URL。 */
export class Control {
  constructor(origin, token) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !token
    )
      throw new Error('控制面配置无效');
    this.origin = url.origin;
    this.token = token;
  }
  async bytes(path, body, limit = JSON_LIMIT) {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('控制面路径无效');
    const response = await fetch(this.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_MS),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpFault(response.status);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async json(path, body) {
    return JSON.parse(await this.bytes(path, body));
  }
  async findRequest(id) {
    try {
      return await this.json(`/v2/requests/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof HttpFault && error.status === 404) return null;
      throw error;
    }
  }
}

/** 采集失败逐项记账；下载成功且摘要正确也不等于图片内容通过业务验收。 */
export async function collect(control, detail, directory) {
  const artifacts = [];
  const errors = [];
  for (const artifact of detail.report?.artifacts ?? []) {
    try {
      if (!ID.test(artifact.id)) throw new Error('INVALID_ARTIFACT_ID');
      const bytes = await control.bytes(
        `/v1/artifacts/${artifact.id}`,
        undefined,
        ARTIFACT_LIMIT,
      );
      if (digest(bytes) !== artifact.sha256)
        throw new Error('ARTIFACT_DIGEST_MISMATCH');
      if (
        artifact.kind === 'SCREENSHOT' &&
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        throw new Error('ARTIFACT_NOT_PNG');
      await saveBytes(join(directory, `artifact-${artifact.id}`), bytes);
      artifacts.push({
        id: artifact.id,
        kind: artifact.kind,
        sha256: artifact.sha256,
        verified: true,
        ...(artifact.kind === 'DOM' ? { text: bytes.toString('utf8') } : {}),
      });
    } catch {
      errors.push(`ARTIFACT_UNAVAILABLE:${artifact.id}`);
    }
  }
  const calls = [];
  for (const execution of detail.executions) {
    try {
      const list = await control.json(
        `/v1/admin/executions/${execution.id}/model-calls`,
      );
      // 元数据足以计算调用量；完整模型正文仍在 API，避免重复落盘潜在敏感输入。
      for (const call of list.calls)
        calls.push({ ...call, executionId: execution.id });
    } catch {
      errors.push('MODEL_CALLS_UNAVAILABLE');
    }
  }
  return { artifacts, calls, errors };
}

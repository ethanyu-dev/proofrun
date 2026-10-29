import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** 单场景本地执行端口；模型请求、观察、截图和命令输出均来自真实适配器。控制面调度仍在进程内。 */
export class RealControl {
  /** 当前宿主、业务服务及场景身份，只允许访问本次合成站点。 */
  constructor(host, site, scenario, evidenceDirectory) {
    this.host = host;
    this.site = site;
    this.scenario = scenario;
    this.directory = evidenceDirectory;
  }
  /** 调用开始与结束在同一 Map 合并，失败也保留已开始的轮次。 */
  calls = new Map();
  /** 真实命令与输出；故障注入另行标记，不冒充自然故障。 */
  commands = [];
  /** 可引用证据的摘要和磁盘文件，用于图片交付前核实。 */
  artifacts = [];
  files = new Map();
  /** 首次注入是否触发及宿主是否真的拒绝旧观察。 */
  injected = false;
  staleRejected = false;
  async recordModelCall(_execution, id, body) {
    if (body.phase === 'start')
      this.calls.set(id, structuredClone(body.record));
    else Object.assign(this.calls.get(id), structuredClone(body.result));
  }
  async recordSteps() {}
  async complete(_execution, report) {
    this.report = report;
  }
  async heartbeat() {
    return { leaseExpiresAt: new Date(Date.now() + 30000).toISOString() };
  }
  async view() {
    return {
      taskState: 'RUNNING',
      state: 'RUNNING',
      controlMode: 'AUTO',
      controlRevision: 0,
      actionCount: this.commands.filter(
        (command) => command.operation.type === 'browser.act',
      ).length,
      closureVerified: false,
      ...(await this.heartbeat()),
      artifacts: this.artifacts,
    };
  }
  async intervene() {
    throw new Error('基础场景不支持人工介入');
  }
  async acknowledge() {
    throw new Error('基础场景不支持人工介入');
  }
  /** 文件由本次真实观察写入，不接受模型指定的本地路径或跨场景证据。 */
  async evidence(kind, bytes, extension) {
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = resolve(this.directory, `${id}.${extension}`);
    await writeFile(path, bytes);
    this.files.set(id, path);
    this.artifacts.push({ id, kind, sha256, state: 'AVAILABLE' });
    return { artifactId: id, kind, sha256 };
  }
  async image(_execution, artifact) {
    const path = this.files.get(artifact.id);
    if (!path) throw new Error('截图不属于本场景');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('截图摘要不匹配');
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
  /** 基础合成套件只允许本场景导航；真实站点套件必须另行提供固定目标约束。 */
  authorize(operation) {
    if (
      operation.type === 'browser.act' &&
      ['navigate', 'tab.new'].includes(operation.action)
    ) {
      const url = new URL(operation.target);
      if (
        url.origin !== this.site.origin ||
        url.pathname !== `/${this.scenario.id}`
      )
        throw new Error('Benchmark 禁止导航到本场景以外的地址');
    }
  }
  /** 在绑定的命令回执上补充证据，扩展不能通过全局最后一条记录寻找当前命令。 */
  async enrichObservation(data) {
    for (const [field, kind] of [
      ['network', 'NETWORK'],
      ['runtime', 'RUNTIME'],
    ]) {
      if (data[field])
        data.artifactRefs.push(
          await this.evidence(
            kind,
            Buffer.from(JSON.stringify(data[field])),
            'json',
          ),
        );
    }
    return data;
  }
  /** 只向生产宿主派发操作；受控的旧观察/丢回执注入保持原始结果可审计。 */
  async command(
    execution,
    id,
    operation,
    timeoutMs,
    signal,
    _revision,
    stepId,
  ) {
    signal?.throwIfAborted();
    this.authorize(operation);
    // 多组模型可以并行返回，命令归属必须按步骤查找，不能借用最后一个兄弟组回复。
    const call = [...this.calls.values()].findLast(
      (entry) => !stepId || entry.stepId === stepId,
    );
    const decisionIndex = call?.decisionIndex ?? 0;
    if (
      this.scenario.id === 'invalid-target' &&
      !this.injected &&
      operation.observationId &&
      operation.type === 'browser.act'
    ) {
      this.injected = true;
      const observed = await this.host.command(
        { type: 'browser.observe' },
        timeoutMs,
      );
      this.commands.push({
        decisionIndex,
        operation: { type: 'browser.observe' },
        status: 'Ok' in observed ? 'SUCCEEDED' : 'FAILED',
        effect: 'Ok' in observed ? 'COMPLETED' : observed.Err.effect,
        origin: 'fault-injection',
        fault: '主动刷新观察使先前目标失效',
      });
      if (!('Ok' in observed)) throw new Error('无法建立旧观察故障注入');
    }
    const record = {
      decisionIndex,
      ...(stepId ? { stepId } : {}),
      ...(call ? { callId: call.id } : {}),
      operation: structuredClone(operation),
      status: 'ERROR',
      effect: 'UNKNOWN',
    };
    this.commands.push(record);
    const raw = await this.host.command(operation, timeoutMs);
    const ok = Object.hasOwn(raw, 'Ok');
    const result = {
      type: 'command.result',
      protocolVersion: '0.1',
      messageId: id,
      commandId: id,
      nodeId: execution.nodeId,
      sessionId: execution.sessionId,
      nodeEpoch: 'local',
      leaseId: execution.id,
      fence: 1,
      operationStatus: ok
        ? 'SUCCEEDED'
        : raw.Err.effect === 'NOT_STARTED'
          ? 'FAILED'
          : 'UNKNOWN',
      effect: ok ? 'COMPLETED' : raw.Err.effect,
      data: ok ? raw.Ok : {},
      ...(!ok ? { error: { code: raw.Err.code, message: raw.Err.code } } : {}),
    };
    if (!ok && raw.Err.code === 'STALE_OBSERVATION') this.staleRejected = true;
    if (ok && operation.type === 'browser.observe') {
      const data = { ...raw.Ok };
      const screenshot = data.localScreenshot;
      delete data.localScreenshot;
      const refs = [
        await this.evidence('DOM', Buffer.from(JSON.stringify(data)), 'json'),
      ];
      if (screenshot) {
        if (!resolve(screenshot).startsWith(resolve(this.host.directory) + sep))
          throw new Error('截图路径不属于本次宿主');
        refs.push(
          await this.evidence('SCREENSHOT', await readFile(screenshot), 'png'),
        );
      }
      result.data = await this.enrichObservation({
        ...data,
        artifactRefs: refs,
      });
    }
    record.result = structuredClone(result.data);
    if (result.error) record.error = result.error.code;
    // 在真实提交已完成后丢弃确认，模拟传输故障；独立 HTTP 账本仍保留实际写入。
    if (
      ok &&
      this.scenario.id === 'unknown-write' &&
      !this.injected &&
      operation.type === 'browser.act' &&
      ['click', 'visual.click', 'press'].includes(operation.action)
    ) {
      for (
        let i = 0;
        i < 20 && !this.site.facts(this.scenario.id).writes.length;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.site.facts(this.scenario.id).writes.length) {
        this.injected = true;
        record.fault = '真实写入完成后注入回执丢失';
        record.nativeStatus = result.operationStatus;
        result.operationStatus = 'UNKNOWN';
        result.effect = 'MAY_HAVE_HAPPENED';
        result.data = {};
      }
    }
    record.status = result.operationStatus;
    record.effect = result.effect;
    return result;
  }
}

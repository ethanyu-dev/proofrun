import type { HitlServer } from '@proofrun/contracts';

/** 交接等待只查询状态；断线采用有上限的退避，不能重放浏览器操作。 */
const HANDOFF_POLL_MS = 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** 授权、控制握手和媒体首帧分别有界；静态页面收到首帧后不按帧率判定失联。 */
const BOOTSTRAP_TIMEOUT_MS = 15000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const FIRST_FRAME_TIMEOUT_MS = 15000;
export type ConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'closed';
/** 页面提供身份及展示回调；连接层只管理传输生命周期。 */
interface Options {
  id: string;
  token: string;
  message: (message: HitlServer) => void;
  closed: () => void;
  error: (message: string) => void;
  status?: (state: ConnectionState) => void;
}
/** 每轮重连重新取得一次性授权；只缓存身份，不保存待重发的输入或交接请求。 */
export class HitlConnection {
  /** 控制、媒体分别认证，同一轮任一失败时共同撤销。 */
  private control: WebSocket | undefined;
  private frames: WebSocket | undefined;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  /** 使被替换连接的迟到回调失效。 */
  private generation = 0;
  /** 只有收到新媒体首帧才重置连续失败次数。 */
  private failures = 0;
  constructor(private readonly options: Options) {
    void this.connect();
  }
  get readyState() {
    return this.control?.readyState ?? WebSocket.CONNECTING;
  }
  send(value: string) {
    this.control?.send(value);
  }

  /** 先使旧回调失效，再关闭连接，避免迟到的 close/error 清理新连接。 */
  private disconnect() {
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.deadline);
    for (const socket of [this.control, this.frames]) {
      if (!socket) continue;
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.control = this.frames = undefined;
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.disconnect();
  }

  private fail(message: string, retry = true) {
    if (this.ended) return;
    this.disconnect();
    this.options.closed();
    const delay = RETRY_DELAYS_MS[this.failures++];
    if (!retry || delay === undefined) {
      this.close();
      this.options.status?.('closed');
      this.options.error(message + (retry ? '，请手动重新连接。' : ''));
      return;
    }
    this.options.status?.('reconnecting');
    this.options.error(
      `${message}，正在重新连接（${this.failures}/${RETRY_DELAYS_MS.length}）。未确认的操作不会重放。`,
    );
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect() {
    const generation = ++this.generation;
    const current = () => !this.ended && generation === this.generation;
    this.options.status?.(this.failures ? 'reconnecting' : 'connecting');
    const abort = new AbortController();
    this.abort = abort;
    try {
      const response = await fetch('/v1/hitl/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.options.id,
          token: this.options.token,
        }),
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
        ]),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      });
      const result = await response.json();
      if (!current()) return;
      if (!response.ok) {
        this.fail(
          result.message ?? '无法取得节点连接授权',
          ![401, 403, 410].includes(response.status),
        );
        return;
      }
      if (!result.direct) {
        // 完成消息或已提交交接只查询，不自动重发 complete/unable。
        if (result.state.type !== 'state') this.close();
        this.options.message(result.state);
        if (result.state.type === 'state')
          this.timer = setTimeout(() => void this.connect(), HANDOFF_POLL_MS);
        return;
      }
      const { controlUrl, frameUrl, nodeId, id, token } = result.direct;
      const control = new WebSocket(controlUrl);
      this.control = control;
      const authenticate = JSON.stringify({
        type: 'authenticate',
        nodeId,
        id,
        token,
      });
      let authenticated = false;
      this.deadline = setTimeout(() => {
        if (current()) this.fail('节点连接确认超时');
      }, HANDSHAKE_TIMEOUT_MS);
      control.onopen = () => {
        if (current()) control.send(authenticate);
      };
      control.onmessage = (event) => {
        if (!current()) return;
        let message: HitlServer;
        try {
          message = JSON.parse(event.data) as HitlServer;
        } catch {
          this.fail('节点返回了无效数据');
          return;
        }
        if (message.type === 'error' && !authenticated) {
          this.fail(message.message);
          return;
        }
        if (message.type === 'completed' || message.type === 'unable')
          this.close();
        this.options.message(message);
        if (message.type !== 'state' || this.frames || !current()) return;
        authenticated = true;
        clearTimeout(this.deadline);
        this.options.status?.('connected');
        // 媒体必须依附已认证控制连接；握手成功但没有首帧也需要退出等待。
        let receivedFrame = false;
        const frames = new WebSocket(frameUrl);
        this.frames = frames;
        this.deadline = setTimeout(() => {
          if (current()) this.fail('浏览器画面加载超时');
        }, FIRST_FRAME_TIMEOUT_MS);
        frames.onopen = () => {
          if (current()) frames.send(authenticate);
        };
        frames.onmessage = (event) => {
          if (!current()) return;
          try {
            const frame = JSON.parse(event.data) as HitlServer;
            if (frame.type === 'error') {
              this.fail(frame.message);
              return;
            }
            if (frame.type !== 'frame') return;
            clearTimeout(this.deadline);
            if (!receivedFrame) {
              receivedFrame = true;
              this.failures = 0;
              this.options.error('');
            }
            this.options.message(frame);
          } catch {
            this.fail('节点返回了无效画面');
          }
        };
        frames.onerror = () => {
          if (current()) this.fail('无法连接节点画面');
        };
        frames.onclose = () => {
          if (current()) this.fail('画面连接已断开');
        };
      };
      control.onerror = () => {
        if (current()) this.fail('无法连接浏览器节点');
      };
      control.onclose = () => {
        if (current()) this.fail('控制连接已断开');
      };
    } catch (error) {
      if (current())
        this.fail(error instanceof Error ? error.message : '无法建立节点连接');
    }
  }
}

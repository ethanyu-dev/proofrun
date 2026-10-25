import type { HitlServer } from '@proofrun/contracts';

/** 直连握手之前只轮询控制面状态，不提交或重放任何浏览器操作。 */
const HANDOFF_POLL_MS = 1000;
interface Options {
  id: string;
  token: string;
  message: (message: HitlServer) => void;
  closed: () => void;
  error: (message: string) => void;
}
/** 一次人工连接包含独立控制/媒体 socket；处理链接凭据只发送给同源 API。 */
export class HitlConnection {
  private control: WebSocket | undefined;
  private frames: WebSocket | undefined;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private finalizing = false;
  constructor(private readonly options: Options) {
    void this.connect();
  }
  get readyState() {
    return this.control?.readyState ?? WebSocket.CONNECTING;
  }
  send(value: string) {
    const type = JSON.parse(value).type;
    if (type === 'complete' || type === 'unable') this.finalizing = true;
    this.control?.send(value);
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    clearTimeout(this.timer);
    for (const socket of [this.control, this.frames]) {
      if (!socket) continue;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }
  private fail(message?: string) {
    if (this.ended) return;
    if (message) this.options.error(message);
    this.close();
    this.options.closed();
  }
  private async connect() {
    try {
      const response = await fetch('/v1/hitl/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.options.id,
          token: this.options.token,
        }),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(15000),
        ]),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      });
      const result = await response.json();
      if (this.ended) return;
      if (!response.ok)
        throw new Error(result.message ?? '无法取得节点连接授权');
      if (!result.direct) {
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
      control.onopen = () => control.send(authenticate);
      control.onmessage = (event) => {
        let message: HitlServer;
        try {
          message = JSON.parse(event.data) as HitlServer;
        } catch {
          this.fail('节点返回了无效数据');
          return;
        }
        if (message.type === 'state' && message.finalizing)
          this.finalizing = true;
        this.options.message(message);
        // 控制连接确认后才允许媒体连接附着，避免媒体凭证抢先占有操作权。
        if (message.type === 'state' && !this.frames && !this.ended) {
          const frames = new WebSocket(frameUrl);
          this.frames = frames;
          frames.onopen = () => frames.send(authenticate);
          frames.onmessage = (frame) => {
            try {
              this.options.message(JSON.parse(frame.data) as HitlServer);
            } catch {
              this.fail('节点返回了无效画面');
            }
          };
          frames.onerror = () => {
            if (!this.finalizing)
              this.fail('无法连接节点画面，请检查节点域名、证书和网络');
          };
          frames.onclose = () => {
            if (!this.finalizing) this.fail('节点画面连接已断开，请重新连接');
          };
        }
      };
      control.onerror = () =>
        this.fail('无法直连浏览器节点，请检查节点域名、证书和网络');
      control.onclose = () => this.fail();
    } catch (error) {
      if (!this.ended)
        this.fail(error instanceof Error ? error.message : '无法建立节点连接');
    }
  }
}

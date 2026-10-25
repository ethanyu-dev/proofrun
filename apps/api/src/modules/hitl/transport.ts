import WebSocket from 'ws';

/** 慢客户端只保留最新画面，不累积待发送帧。 */
const FRAME_BUFFER_BYTES = 2 * 1024 * 1024;
/** 为状态和回执预留缓冲，长期堵塞时断线，不能静默丢失控制消息。 */
const CONTROL_BUFFER_BYTES = 64 * 1024;
/** 静态页面不一定再产生下一帧，定时检查排空并限制旧画面的持续时间。 */
const FRAME_RETRY_MS = 100;
const FRAME_STALL_MS = 5000;

/** 每个连接最多缓存一帧；关闭或撤权时同时释放计时器和画面。 */
interface PendingFrame {
  /** 已编码的最新画面，后续帧直接替换。 */
  encoded: string;
  /** 首次积压时间，不能因持续新帧而无限延长。 */
  since: number;
  /** 只调度一个有界重试，不重放浏览器输入。 */
  timer?: ReturnType<typeof setTimeout>;
  /** 原连接关闭时撤销延迟发送。 */
  close: () => void;
}
const pendingFrames = new WeakMap<WebSocket, PendingFrame>();

/** 撤权必须立即丢弃未发送的画面，不能等浏览器或 TCP 完成关闭。 */
export function discardFrame(socket: WebSocket): void {
  const pending = pendingFrames.get(socket);
  if (!pending) return;
  clearTimeout(pending.timer);
  socket.off('close', pending.close);
  pendingFrames.delete(socket);
}

/** 排空后补发最后状态；若持续积压，关闭连接让前端清空旧画面并提示重连。 */
function flushFrame(socket: WebSocket, pending: PendingFrame): void {
  if (pendingFrames.get(socket) !== pending) return;
  if (socket.readyState !== WebSocket.OPEN) {
    discardFrame(socket);
    return;
  }
  if (
    socket.bufferedAmount + Buffer.byteLength(pending.encoded) <=
    FRAME_BUFFER_BYTES
  ) {
    discardFrame(socket);
    socket.send(pending.encoded);
  } else if (Date.now() - pending.since >= FRAME_STALL_MS) {
    discardFrame(socket);
    socket.terminate();
  } else {
    pending.timer = setTimeout(
      () => flushFrame(socket, pending),
      FRAME_RETRY_MS,
    );
    pending.timer.unref();
  }
}

/** 自动观看与人工处理共用背压；仅合并画面，其他消息保留独立发送额度。 */
export function sendStreamMessage(
  socket: WebSocket,
  value: { type: string; [key: string]: unknown },
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const encoded = JSON.stringify(value);
  const buffered = socket.bufferedAmount + Buffer.byteLength(encoded);
  if (value.type === 'frame') {
    if (Buffer.byteLength(encoded) > FRAME_BUFFER_BYTES) {
      discardFrame(socket);
      socket.terminate();
      return;
    }
    if (buffered > FRAME_BUFFER_BYTES) {
      let pending = pendingFrames.get(socket);
      if (pending) pending.encoded = encoded;
      else {
        pending = {
          encoded,
          since: Date.now(),
          close: () => discardFrame(socket),
        };
        pendingFrames.set(socket, pending);
        socket.once('close', pending.close);
        flushFrame(socket, pending);
      }
      return;
    }
    discardFrame(socket);
  }
  if (buffered > FRAME_BUFFER_BYTES + CONTROL_BUFFER_BYTES) {
    discardFrame(socket);
    socket.terminate();
    return;
  }
  socket.send(encoded);
}

/** 跟踪画面连接的关闭与错误；业务层仍负责撤权和租约结束。 */
export function trackStreamSocket(
  sockets: Set<WebSocket>,
  socket: WebSocket,
): void {
  sockets.add(socket);
  socket.on('error', () => socket.terminate());
  socket.once('close', () => {
    discardFrame(socket);
    sockets.delete(socket);
  });
}

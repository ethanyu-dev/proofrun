import WebSocket from 'ws';
import type { HitlServer } from '@proofrun/contracts';

/** 慢客户端只丢弃可被下一帧替代的画面。 */
const FRAME_BUFFER_BYTES = 2 * 1024 * 1024;
/** 为状态和回执预留缓冲，长期堵塞时断线，不能静默丢失控制消息。 */
const CONTROL_BUFFER_BYTES = 64 * 1024;

/** 帧可以降级丢弃；命令回执、错误与完成通知必须送出或明确断线。 */
export function sendHitlMessage(socket: WebSocket, value: HitlServer): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const encoded = JSON.stringify(value);
  const buffered = socket.bufferedAmount + Buffer.byteLength(encoded);
  if (value.type === 'frame' && buffered > FRAME_BUFFER_BYTES) return;
  if (buffered > FRAME_BUFFER_BYTES + CONTROL_BUFFER_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(encoded);
}

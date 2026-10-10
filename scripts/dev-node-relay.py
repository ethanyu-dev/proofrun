"""保留 Docker 节点的回环入口，通过校验证书的 TLS 连接 Mac API。"""

import asyncio
import ssl
from pathlib import Path

# 端口与本地启动器配套；不修改节点的身份、凭据或业务权限。
LOCAL_PORT = 4100
HOST_PORT = 4443
HOST_NAME = "host.docker.internal"
CERTIFICATE_NAME = "proofrun-local-relay"
CERTIFICATE = Path(__file__).resolve().parent.parent / ".proofrun/runtime/local-relay.crt"


async def copy_stream(reader, writer):
    """传递原始 HTTP/WebSocket 字节，断开时不缓存或重放业务请求。"""
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()


async def relay(reader, writer):
    """每条节点连接独立建立 TLS；任意一端关闭即回收两端。"""
    upstream = None
    tasks = []
    try:
        context = ssl.create_default_context(cafile=str(CERTIFICATE))
        peer, upstream = await asyncio.wait_for(
            asyncio.open_connection(
                HOST_NAME, HOST_PORT, ssl=context, server_hostname=CERTIFICATE_NAME
            ),
            timeout=10,
        )
        tasks = [
            asyncio.create_task(copy_stream(reader, upstream)),
            asyncio.create_task(copy_stream(peer, writer)),
        ]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, asyncio.TimeoutError):
        print("本机 API 转发不可用，等待节点正常重连", flush=True)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        if upstream is not None:
            upstream.close()


async def main():
    """只监听容器回环，供本容器内已配对的 Browser Node 使用。"""
    server = await asyncio.start_server(relay, "127.0.0.1", LOCAL_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

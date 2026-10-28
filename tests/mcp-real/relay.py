"""将容器回环上的专用节点入口转发到宿主测试 API；只转发字节，不改写协议。"""
import asyncio
import sys


async def relay(reader, writer):
    """连接关闭时收拢双向复制，避免测试结束后留下连接任务。"""
    remote_reader, remote_writer = await asyncio.open_connection('host.docker.internal', int(sys.argv[1]))

    async def copy(source, target):
        try:
            while data := await source.read(65536):
                target.write(data)
                await target.drain()
        finally:
            target.close()

    await asyncio.gather(copy(reader, remote_writer), copy(remote_reader, writer), return_exceptions=True)


async def main():
    """端口由宿主选择；容器只监听回环，不向网络暴露管理接口。"""
    server = await asyncio.start_server(relay, '127.0.0.1', int(sys.argv[1]))
    print('relay.ready', flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())

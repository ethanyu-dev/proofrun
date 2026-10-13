#!/usr/bin/env python3
"""真实节点容量基准：隔离 stdio supervisor、systemd 会话、Chromium、DOM 与截图。
只访问回环夹具；模型用可配置等待模拟，不代表真实模型限流、线上站点或完整控制面吞吐。
"""

import argparse
import concurrent.futures as futures
import http.server
import fcntl
import json
import math
import os
from pathlib import Path
import platform
import queue
import re
import shutil
import signal
import sqlite3
import statistics
import subprocess
import threading
import time
import uuid

# 留出系统与线上节点余量；测试用独立 home，不读取凭据、认证快照或业务数据。
MIN_FREE_MB = 3072
COMMAND_MS = 15000
LEASE_MS = 120000
PROFILE_LEVELS = [1, 2, 4, 8, 12, 16]
GROUP_LEVELS = [1, 2, 4, 6, 8]
# 信号只停止测试派发，让 finally 继续走正式会话关闭。
CANCELLED = threading.Event()


def percentile(values, fraction):
    """样本分位数用于描述本次运行，不把短测尾延迟当作长期 SLA。"""
    return (
        sorted(values)[
            min(len(values) - 1, max(0, math.ceil(len(values) * fraction) - 1))
        ]
        if values
        else 0
    )


def memory():
    """读取可用物理内存，避免把可回收缓存计作浏览器占用。"""
    data = dict(re.findall(r"^(\w+):\s+(\d+)", Path("/proc/meminfo").read_text(), re.M))
    return int(data["MemTotal"]) / 1024, int(data["MemAvailable"]) / 1024


def cpu():
    """整机 CPU 包含并存工作负载；不能归因为本测试专属用量。"""
    values = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:9]))
    return sum(values), values[3] + values[4]


def production_idle(home):
    """只读检查原节点账本；一旦有非关闭会话，停止继续施压。"""
    path = home / "node.db"
    if not path.exists():
        raise RuntimeError("找不到原节点账本，无法确认空闲")
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        return (
            db.execute(
                "SELECT count(*) FROM sessions WHERE state != 'CLOSED'"
            ).fetchone()[0]
            == 0
        )


class Page(http.server.BaseHTTPRequestHandler):
    """本机确定性页面包含表格和交互，允许验证 tab 路由和观察引用。"""

    def log_message(self, *_):
        pass

    def do_GET(self):
        marker = self.path.split("?")[0]
        body = '<html lang="zh-CN"><title>容量测试</title><style>body{font:16px sans-serif}td{padding:4px}</style>'
        body += (
            "<h1>"
            + marker
            + "</h1><input aria-label=\"测试输入\"><button onclick=\"document.querySelector('#result').textContent='已完成 '+document.querySelector('input').value\">确认</button><p id=\"result\">待完成</p><table>"
        )
        body += "".join(
            f"<tr><td>测试项目 {i}</td><td>固定说明与多语言样本 Example 日本語</td><td>{i * 3}</td></tr>"
            for i in range(200)
        )
        body += "</table></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        try:
            self.wfile.write(body.encode())
        except (BrokenPipeError, ConnectionResetError):
            # 保护性停止关闭浏览器时，客户端可以先于夹具响应断开。
            pass


class Node:
    """复用正式节点命令路径；接收线程将异步结果分发到对应请求，并 ACK 去重。"""

    def __init__(self, root, binary, engine, chrome):
        self.root, self.pending = root, {}
        self.write_lock, self.pending_lock = threading.Lock(), threading.Lock()
        self.heartbeat, self.ready, self.closed = {}, threading.Event(), False
        self.log = (root / "node.log").open("w")
        config = root / "node.toml"
        config.write_text(
            "\n".join(
                [
                    f"home = {json.dumps(str(root / 'state'))}",
                    f"agent_browser_bin = {json.dumps(str(engine))}",
                    f"chrome_bin = {json.dumps(str(chrome))}",
                    "capacity = 32",
                    "max_lease_ms = 120000",
                    "max_session_ms = 3600000",
                    "artifact_limit_bytes = 2147483648",
                    "allow_unverified_writes = true",
                ]
            )
            + "\n"
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith("PROOFRUN_")}
        self.process = subprocess.Popen(
            [str(binary), "--config", str(config), "serve", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            bufsize=1,
            env=env,
        )
        threading.Thread(target=self.read, daemon=True).start()
        if not self.ready.wait(20):
            raise RuntimeError("独立节点未就绪，检查 node.log")

    def send(self, value):
        """仅写本次创建的节点管道，多线程命令不能交叉输出 JSON。"""
        with self.write_lock:
            self.process.stdin.write(json.dumps(value) + "\n")
            self.process.stdin.flush()

    def read(self):
        """仅接收元数据，证据留在独立测试目录，不上传生产控制面。"""
        try:
            for line in self.process.stdout:
                value = json.loads(line)
                if value.get("type") == "node.heartbeat":
                    self.heartbeat = value
                    self.ready.set()
                if value.get("messageId"):
                    self.send({"type": "ack", "messageId": value["messageId"]})
                with self.pending_lock:
                    waiter = self.pending.get(value.get("commandId"))
                if waiter and value.get("type") == "command.result":
                    waiter.put(value)
        finally:
            self.closed = True

    def call(self, session, kind, **fields):
        """每个命令有独立 ID、超时和结果；失败不重放有副作用的动作。"""
        command_id, waiter = uuid.uuid4().hex, queue.Queue()
        with self.pending_lock:
            self.pending[command_id] = waiter
        try:
            hb = self.heartbeat
            self.send(
                {
                    "protocolVersion": "0.1",
                    "commandId": command_id,
                    "nodeId": hb["nodeId"],
                    "nodeEpoch": hb["nodeEpoch"],
                    "sessionId": session,
                    "leaseId": "lease-" + session,
                    "fence": 1,
                    "timeoutMs": COMMAND_MS,
                    "command": {"type": kind, **fields},
                }
            )
            value = waiter.get(timeout=50)
            if value.get("operationStatus") != "SUCCEEDED":
                raise RuntimeError(
                    json.dumps(
                        {
                            "kind": kind,
                            "status": value.get("operationStatus"),
                            "error": value.get("error"),
                        }
                    )
                )
            return value.get("data", {})
        finally:
            with self.pending_lock:
                self.pending.pop(command_id, None)

    def stop(self):
        """关闭 stdin 触发正式 shutdown，等待会话清理，不触碰线上服务。"""
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=90)
        self.log.close()


def trial(
    args,
    root,
    profiles,
    concurrency,
    repetition,
    binary,
    engine,
    chrome,
    production_home,
):
    """每档固定每个 profile 的组数和动作数，模拟等待在浏览器串行锁外发生。"""
    directory = root / f"p{profiles}-g{concurrency}-r{repetition}"
    directory.mkdir()
    if not production_idle(production_home):
        raise RuntimeError("原节点存在任务，请空闲后再测")
    total_mb, initial_free = memory()
    reserve = max(MIN_FREE_MB, total_mb * 0.20)
    if initial_free < reserve:
        raise RuntimeError("可用内存低于保留阈值")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    node = Node(directory, binary, engine, chrome)
    stop, sampling_done = threading.Event(), threading.Event()
    metrics, errors, latencies, waits, durations, opened = [], [], [], [], [], []
    active, active_lock = set(), threading.Lock()
    started = time.monotonic()

    def monitor():
        """整机内存触底或生产出现任务即停止派发；已有命令有界退出。"""
        previous = cpu()
        while not sampling_done.wait(1):
            current = cpu()
            busy = 100 * (
                1 - (current[1] - previous[1]) / max(1, current[0] - previous[0])
            )
            previous = current
            _, available = memory()
            metrics.append(
                {
                    "seconds": time.monotonic() - started,
                    "availableMb": available,
                    "cpuPercent": busy,
                }
            )
            if CANCELLED.is_set():
                errors.append("用户中止测试")
                stop.set()
            if available < reserve or not production_idle(production_home):
                errors.append("资源保护触发：内存不足或生产节点出现任务")
                stop.set()

    def renew():
        """长测试续租独立会话，结束后不再续租，保留节点失联回收机制。"""
        while not sampling_done.wait(25):
            with active_lock:
                sessions = list(active)
            for session in sessions:
                try:
                    node.call(
                        session,
                        "session.renew",
                        leaseRequestId=node.heartbeat["leaseRequestId"],
                        leaseTtlMs=LEASE_MS,
                    )
                except Exception as error:
                    errors.append("续租失败：" + str(error))
                    stop.set()

    def profile(index):
        """真实独立 browser profile；内部组使用串行命令锁和各自 tabScope。"""
        session, lock = "bench-" + uuid.uuid4().hex, threading.Lock()
        profile_start = time.monotonic()
        try:
            if stop.is_set():
                return
            node.call(
                session,
                "session.open",
                leaseRequestId=node.heartbeat["leaseRequestId"],
                leaseTtlMs=LEASE_MS,
                maxDurationMs=3600000,
            )
            opened.append(session)
            with active_lock:
                active.add(session)

            def command(group, kind, **fields):
                queued = time.monotonic()
                with lock:
                    if stop.is_set():
                        raise RuntimeError("测试已停止")
                    executing = time.monotonic()
                    result = node.call(
                        session, kind, tabScope="group-" + str(group), **fields
                    )
                    latencies.append(time.monotonic() - executing)
                    waits.append(executing - queued)
                    return result

            def group(number):
                marker = f"/profile-{index}/group-{number}"
                command(
                    number,
                    "browser.act",
                    action="navigate",
                    target=f"http://127.0.0.1:{server.server_port}" + marker,
                )
                observation = command(number, "browser.observe", screenshot=True)
                if not observation["url"].endswith(marker):
                    raise RuntimeError("tab 路由错误")
                target = next(
                    t["target"]
                    for t in observation["targets"]
                    if t.get("name") == "测试输入"
                )
                if stop.wait(args.think):
                    raise RuntimeError("测试已停止")
                value = f"p{index}g{number}"
                command(
                    number,
                    "browser.act",
                    action="fill",
                    target=target,
                    value=value,
                    observationId=observation["observationId"],
                )
                observation = command(number, "browser.observe", screenshot=True)
                if value not in json.dumps(observation, ensure_ascii=False):
                    raise RuntimeError("tab 内容或观察引用错误")
                target = next(
                    t["target"]
                    for t in observation["targets"]
                    if t.get("name") == "确认"
                )
                if stop.wait(args.think):
                    raise RuntimeError("测试已停止")
                command(
                    number,
                    "browser.act",
                    action="click",
                    target=target,
                    observationId=observation["observationId"],
                )
                observation = command(number, "browser.observe", screenshot=True)
                if "已完成 " + value not in observation["text"] or not observation[
                    "url"
                ].endswith(marker):
                    raise RuntimeError("点击结果或 tab 隔离错误")

            with futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                for result in futures.as_completed(
                    [pool.submit(group, n) for n in range(args.groups)]
                ):
                    result.result()
            durations.append(time.monotonic() - profile_start)
        except Exception as error:
            errors.append(str(error))
            stop.set()
        finally:
            with active_lock:
                active.discard(session)
            if session in opened:
                try:
                    node.call(session, "session.close")
                except Exception as error:
                    errors.append("关闭失败：" + str(error))
                    stop.set()

    threads = [
        threading.Thread(target=monitor, daemon=True),
        threading.Thread(target=renew, daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        with futures.ThreadPoolExecutor(max_workers=profiles) as pool:
            for result in futures.as_completed(
                [pool.submit(profile, i) for i in range(profiles)]
            ):
                result.result()
    finally:
        sampling_done.set()
        for thread in threads:
            thread.join(timeout=55)
        node.stop()
        server.shutdown()
        server.server_close()
    elapsed = time.monotonic() - started
    with sqlite3.connect(directory / "state/node.db") as db:
        states = dict(db.execute("SELECT state,count(*) FROM sessions GROUP BY state"))
    if any(state != "CLOSED" and count for state, count in states.items()):
        errors.append("会话关闭未核实：" + json.dumps(states))
    row = {
        "profiles": profiles,
        "groupConcurrency": concurrency,
        "groupsPerProfile": args.groups,
        "repetition": repetition,
        "thinkSeconds": args.think,
        "elapsedSeconds": round(elapsed, 3),
        "completedProfiles": len(durations),
        "profilesPerMinute": round(len(durations) * 60 / elapsed, 3),
        "profileP95Seconds": round(percentile(durations, 0.95), 3),
        "commandP95Seconds": round(percentile(latencies, 0.95), 3),
        "queueP95Seconds": round(percentile(waits, 0.95), 3),
        "cpuMeanPercent": round(statistics.mean(m["cpuPercent"] for m in metrics), 2)
        if metrics
        else 0,
        "cpuP95Percent": round(percentile([m["cpuPercent"] for m in metrics], 0.95), 2),
        "initialAvailableMb": round(initial_free),
        "minAvailableMb": round(
            min([m["availableMb"] for m in metrics] or [initial_free])
        ),
        "errors": errors,
        "sessionStates": states,
        "commandSamples": len(latencies),
    }
    (directory / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    (directory / "result.json").write_text(
        json.dumps(row, ensure_ascii=False, indent=2) + "\n"
    )
    # 仅删除本次独立节点的证据和 profile，保留账本与日志用于复核。
    if not errors:
        for name in ("sessions", "artifacts"):
            shutil.rmtree(directory / "state" / name, ignore_errors=True)
    return row


def setting(text, name):
    """优先标准 TOML 解析；Python 3.10 只接受常见的单行路径字符串，复杂写法明确拒绝。"""
    try:
        import tomllib

        return tomllib.loads(text)[name]
    except ImportError:
        match = re.search(
            r"^"
            + re.escape(name)
            + r'\s*=\s*("[^"\n]*"|\x27[^\x27\n]*\x27)\s*(?:#.*)?$',
            text,
            re.M,
        )
        if not match:
            raise RuntimeError("配置路径无法解析，请用 --chrome 显式指定浏览器路径")
        return json.loads(match[1]) if match[1].startswith('"') else match[1][1:-1]


def main():
    """逐档加压，任何错误停止后续档位；不会自动修改生产并发配置。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=["smoke", "profile", "capacity", "matrix"], default="matrix"
    )
    parser.add_argument("--profiles", type=int, nargs="+", default=PROFILE_LEVELS)
    parser.add_argument("--concurrency", type=int, nargs="+", default=GROUP_LEVELS)
    parser.add_argument("--groups", type=int, default=6)
    parser.add_argument("--think", type=float, default=3)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux" or os.getuid() == 0:
        parser.error("请在 Linux 节点以原运行用户执行，不要 sudo")
    if (
        any(not 1 <= p <= 32 for p in args.profiles)
        or any(not 1 <= g <= 8 for g in args.concurrency)
        or not 1 <= args.groups <= 32
        or not 0 <= args.think <= 30
        or not 1 <= args.repeat <= 10
    ):
        parser.error("参数超出支持范围")
    # 同一用户只允许一个基准运行，避免多次测试相互污染和叠加负载。
    lock_path = Path.home() / ".local/share/proofrun-benchmark.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    benchmark_lock = lock_path.open("a")
    fcntl.flock(benchmark_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: CANCELLED.set())
    if args.mode == "smoke":
        args.groups, args.think, args.repeat = 2, 0, 1
    config = (Path.home() / ".config/proofrun/node.toml").read_text()
    production_home = Path(setting(config, "home"))
    binary = Path.home() / ".local/lib/proofrun-node/current/bin/proofrun-node"
    engine = Path(setting(config, "agent_browser_bin"))
    chrome = args.chrome or Path(setting(config, "chrome_bin"))
    root = (
        args.output
        or Path.home() / ("proofrun-benchmark-" + time.strftime("%Y%m%d-%H%M%S"))
    ).resolve()
    root.mkdir(parents=True, exist_ok=False)
    build = json.loads(subprocess.check_output([str(binary), "build-info"], text=True))
    (root / "environment.json").write_text(
        json.dumps(
            {
                "build": build,
                "machine": platform.machine(),
                "cpus": os.cpu_count(),
                "memoryMb": memory()[0],
                "arguments": vars(args)
                | {"chrome": str(args.chrome), "output": str(root)},
                "scope": "真实节点/systemd/Chromium；本机页面；模型等待为模拟；不含 API、证据上传或真实模型",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    if args.mode == "smoke":
        points = [(1, 2)]
    elif args.mode == "profile":
        points = [(1, g) for g in args.concurrency]
    elif args.mode == "capacity":
        points = [(p, args.concurrency[0]) for p in args.profiles]
    else:
        points = [(1, g) for g in args.concurrency] + [
            (p, 2) for p in args.profiles if p != 1
        ]
    print("结果目录：" + str(root), flush=True)
    for p, g in points:
        for repetition in range(1, args.repeat + 1):
            if CANCELLED.is_set():
                raise SystemExit("测试已中止")
            row = trial(
                args, root, p, g, repetition, binary, engine, chrome, production_home
            )
            with (root / "results.jsonl").open("a") as output:
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(json.dumps(row, ensure_ascii=False), flush=True)
            if row["errors"]:
                raise SystemExit("本档存在错误，已停止后续加压；详见结果和 node.log")
            time.sleep(2)
    print("完成。结果为此夹具与等待模型下的测量，不等同线上最优并发。", flush=True)


if __name__ == "__main__":
    main()

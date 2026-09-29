#!/usr/bin/env python3
"""安装已校验的 Linux 节点包；版本目录与持久数据分离，不安装控制面。"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
from urllib.parse import urlsplit

# 解包同时限制成员数和展开大小，拒绝链接及越界路径。
MAX_MEMBERS = 100
MAX_BYTES = 256 * 1024 * 1024
SERVICE = "proofrun-node.service"
VERSION_PATTERN = r"node-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?"
ARCHES = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}


def run(*args, check=True, env=None):
    """凭据只经文件传递；子进程参数不经过 shell。"""
    return subprocess.run(
        args, check=check, text=True, capture_output=True, timeout=60, env=env
    )


def unpack(package, expected, destination, arch):
    """先校验整个包，再校验归档边界和平台；未通过时不能执行包内文件。"""
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("SHA-256 格式无效")
    with package.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError("安装包 SHA-256 不匹配")
    with tarfile.open(package, "r:gz") as archive:
        members = archive.getmembers()
        if len(members) > MAX_MEMBERS or sum(m.size for m in members) > MAX_BYTES:
            raise ValueError("安装包超出大小限制")
        seen = set()
        for member in members:
            name = PurePosixPath(member.name)
            if (
                name.is_absolute()
                or ".." in name.parts
                or str(name) in seen
                or not (member.isfile() or member.isdir())
            ):
                raise ValueError("安装包包含重复、越界路径或特殊文件")
            seen.add(str(name))
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    manifest = json.loads((destination / "release.json").read_text())
    if (
        manifest.get("format") != 1
        or manifest.get("arch") != arch
        or manifest.get("os") != "linux"
    ):
        raise ValueError("安装包平台或格式不匹配")
    if not re.fullmatch(VERSION_PATTERN, manifest.get("version", "")):
        raise ValueError("安装包版本无效")
    for binary in ("proofrun-node", "agent-browser"):
        path = destination / "bin" / binary
        if not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError(f"安装包缺少可执行文件 {binary}")
    return manifest


def idle(home):
    """非 CLOSED 会话均阻止升级，包括尚未核实关闭的隔离会话。"""
    path = home / "node.db"
    if path.exists():
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            if db.execute(
                "SELECT count(*) FROM sessions WHERE state != 'CLOSED'"
            ).fetchone()[0]:
                raise RuntimeError(
                    "节点仍有活动或未核实关闭的会话；请停止派发并等待清理后升级"
                )


def unit_quote(path):
    """systemd 参数使用独立引号，并转义 %，不能让路径成为 unit 指令。"""
    return (
        '"'
        + str(path).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
        + '"'
    )


def configure(path, current, home, args):
    """首次生成配置；已有配置保持原样，防止升级丢失池、登录状态或自定义限制。"""
    if path.exists():
        existing = tomllib.loads(path.read_text())
        checks = [
            (
                args.api.rstrip("/") + "/v1/artifacts" if args.api else None,
                existing.get("artifact_upload_url"),
            ),
            (args.pool, existing.get("pool")),
            (
                str(Path(args.chrome).resolve()) if args.chrome else None,
                existing.get("chrome_bin"),
            ),
        ]
        if any(value is not None and value != saved for value, saved in checks):
            raise ValueError("已有配置不能通过安装参数覆盖，请直接编辑 node.toml")
        return
    parsed = urlsplit(args.api or "")
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "首次安装需要 --api HTTPS_ORIGIN，例如 https://proofrun.example.com"
        )
    chrome = Path(
        args.chrome or shutil.which("chromium") or shutil.which("google-chrome") or ""
    )
    if not chrome.is_file() or not os.access(chrome, os.X_OK):
        raise ValueError("首次安装需要已安装的 Chromium/Chrome，使用 --chrome 指定路径")

    def quote(value):
        """JSON 基本文本转义兼容此处 TOML 字符串，路径和参数不能注入配置字段。"""
        return json.dumps(str(value), ensure_ascii=False)

    origin = args.api.rstrip("/")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    text = "\n".join(
        [
            "# 安装器仅在首次安装时创建；升级保留本文件和节点数据。",
            f"home = {quote(home)}",
            f"gateway_url = {quote('wss://' + parsed.netloc + '/v1/nodes/connect')}",
            f"artifact_upload_url = {quote(origin + '/v1/artifacts')}",
            f"pool = {quote(args.pool or 'internal')}",
            "capacity = 2",
            'credential_file = "credential.json"',
            f"agent_browser_bin = {quote(current / 'bin/agent-browser')}",
            f"chrome_bin = {quote(chrome.resolve())}",
            "allow_unverified_writes = false",
            "",
        ]
    )
    with path.open("x") as output:
        os.chmod(path, 0o600)
        output.write(text)


def main():
    """暂存、检查、停止、切换、启动；新版本启动后不猜测数据格式可以回滚。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--api")
    parser.add_argument("--pool")
    parser.add_argument("--chrome")
    parser.add_argument("--pairing-token-file", type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux" or os.getuid() == 0:
        raise ValueError("请在 Linux 上使用普通运行用户安装，不要 sudo 执行安装器")
    arch = ARCHES.get(platform.machine())
    if not arch:
        raise ValueError("仅支持 Linux x64 / arm64")
    run("systemctl", "--user", "show-environment")
    if (
        run(
            "loginctl", "show-user", str(os.getuid()), "-p", "Linger", "--value"
        ).stdout.strip()
        != "yes"
    ):
        raise ValueError("请先由管理员执行 loginctl enable-linger <运行用户>")
    root = Path.home() / ".local/lib/proofrun-node"
    config = Path.home() / ".config/proofrun/node.toml"
    default_home = Path.home() / ".local/share/proofrun-node"
    unit = Path.home() / ".config/systemd/user" / SERVICE
    current = root / "current"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "install.lock").open("a") as install_lock:
        fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=root) as temporary:
            staging = Path(temporary)
            manifest = unpack(args.package, args.sha256, staging, arch)
            if manifest["version"] != args.version:
                raise ValueError("安装包版本与请求的 release 不匹配")
            configure(config, current, default_home, args)
            settings = tomllib.loads(config.read_text())
            home = Path(settings["home"])
            if not home.is_absolute():
                raise ValueError("node.toml 的 home 必须是绝对路径")
            home.mkdir(parents=True, exist_ok=True, mode=0o700)
            credential = home / settings.get("credential_file", "credential.json")
            if args.pairing_token_file and credential.exists():
                raise ValueError("节点已配对；升级不能重新配对或覆盖身份")
            expected_start = f"ExecStart={unit_quote(current / 'bin/proofrun-node')} --config {unit_quote(config)} serve"
            if unit.exists() and expected_start not in unit.read_text().splitlines():
                raise ValueError("已有同名 service 不属于此安装器，请先迁移旧服务配置")
            idle(home)
            probe_env = dict(
                os.environ,
                PROOFRUN_AGENT_BROWSER_BIN=str(staging / "bin/agent-browser"),
            )
            # 不接受环境变量偷偷改写数据目录，检查和服务必须针对同一 home。
            for key in ("PROOFRUN_NODE_HOME", "PROOFRUN_CHROME_BIN"):
                probe_env.pop(key, None)
            probe = json.loads(
                run(
                    str(staging / "bin/proofrun-node"),
                    "--config",
                    str(config),
                    "doctor",
                    env=probe_env,
                ).stdout
            )
            if not probe.get("dependencyChecksPassed"):
                raise RuntimeError(f"节点依赖检查失败：{probe.get('errors')}")
            release = root / "releases" / manifest["version"]
            release.parent.mkdir(exist_ok=True)
            if release.exists():
                if (release / "package.sha256").read_text().strip() != args.sha256:
                    raise ValueError("同版本已存在但摘要不同，拒绝覆盖")
            else:
                (staging / "package.sha256").write_text(args.sha256 + "\n")
                # 暂存与版本目录位于同一文件系统，避免中断留下半个不可变版本。
                staging.rename(release)
            was_active = (
                run(
                    "systemctl", "--user", "is-active", "--quiet", SERVICE, check=False
                ).returncode
                == 0
            )
            old = current.resolve() if current.is_symlink() else None
            switched = False
            started = False
            try:
                idle(home)
                if was_active:
                    run("systemctl", "--user", "stop", SERVICE)
                # 停止后用与 Rust 相同的 flock 排除其它 supervisor，再核实账本。
                with (home / "node.lock").open("a") as node_lock:
                    fcntl.flock(node_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    idle(home)
                    pending = root / "current.pending"
                    pending.unlink(missing_ok=True)
                    pending.symlink_to(release)
                    pending.replace(current)
                    switched = True
                    unit.parent.mkdir(parents=True, exist_ok=True)
                    if not unit.exists():
                        unit.write_text(
                            "[Unit]\nDescription=ProofRun browser node\nAfter=network-online.target\n\n[Service]\nType=exec\n"
                            f"ExecStart={unit_quote(current / 'bin/proofrun-node')} --config {unit_quote(config)} serve\n"
                            "UnsetEnvironment=PROOFRUN_NODE_HOME PROOFRUN_AGENT_BROWSER_BIN PROOFRUN_CHROME_BIN\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
                        )
                run("systemctl", "--user", "daemon-reload")
                if args.pairing_token_file:
                    run(
                        str(current / "bin/proofrun-node"),
                        "--config",
                        str(config),
                        "pair",
                        "--pairing-token-file",
                        str(args.pairing_token_file.resolve()),
                        env=probe_env
                        | {
                            "PROOFRUN_AGENT_BROWSER_BIN": str(
                                current / "bin/agent-browser"
                            )
                        },
                    )
                if credential.exists():
                    started = True
                    run("systemctl", "--user", "enable", "--now", SERVICE)
                    time.sleep(3)
                    run("systemctl", "--user", "is-active", "--quiet", SERVICE)
                    # active 仅证明进程存活；控制面在线与浏览器业务验收仍须从 Console 确认。
                    print(
                        f"{manifest['version']} 已安装，服务运行中；请在 Console 确认节点在线。"
                    )
                else:
                    print(f"{manifest['version']} 已安装，等待配对；配置：{config}")
                (root / "install.json").write_text(
                    json.dumps(
                        {
                            "version": manifest["version"],
                            "sha256": args.sha256,
                            "previous": str(old) if old else None,
                        },
                        indent=2,
                    )
                    + "\n"
                )
            except BaseException:
                if started:
                    run("systemctl", "--user", "stop", SERVICE, check=False)
                    print(
                        "新版本启动失败，已停止服务。保留旧程序与全部数据；请检查日志，不自动回滚可能已迁移的 SQLite。",
                        file=sys.stderr,
                    )
                else:
                    if switched and old:
                        pending = root / "current.pending"
                        pending.unlink(missing_ok=True)
                        pending.symlink_to(old)
                        pending.replace(current)
                    if was_active:
                        run("systemctl", "--user", "start", SERVICE, check=False)
                raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 不输出子进程捕获内容，避免配对回执进入安装日志。
        raise SystemExit(f"安装失败：{error}")

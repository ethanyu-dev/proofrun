#!/usr/bin/env python3
"""将 Linux 原生节点与固定引擎打包；构建阶段不读取部署配置或登录状态。"""

import argparse
import hashlib
import json
import platform
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import tomllib

# 发布包只包含明确列出的运行资产，禁止从工作目录递归复制私有数据。
ROOT = Path(__file__).resolve().parents[2]
ARCHES = {"x86_64": ("x64", 62), "aarch64": ("arm64", 183), "arm64": ("arm64", 183)}
ENGINE_VERSION = "0.38.1"


def main():
    """版本绑定 Cargo 主版本，预发布后缀由 release 标签表达。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / ".proofrun/release")
    args = parser.parse_args()
    base = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["package"][
        "version"
    ]
    if not re.fullmatch(
        r"node-v" + re.escape(base) + r"(?:-[A-Za-z0-9.-]+)?", args.version
    ):
        raise ValueError("release 标签必须与 Cargo 版本一致，可添加预发布后缀")
    arch, machine = ARCHES[platform.machine()]
    header = args.binary.read_bytes()[:20]
    if (
        header[:6] != b"\x7fELF\x02\x01"
        or struct.unpack("<H", header[18:20])[0] != machine
    ):
        raise ValueError("节点二进制必须是当前架构的 Linux ELF")
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="proofrun-pack-") as temporary:
        stage = Path(temporary)
        (stage / "bin").mkdir()
        shutil.copy2(args.binary, stage / "bin/proofrun-node")
        subprocess.run(
            [
                "node",
                str(ROOT / "scripts/download-test-engine.mjs"),
                arch,
                str(stage / "bin/agent-browser"),
            ],
            check=True,
        )
        # 原生引擎再分发时随包附带该固定版本的许可文本。
        subprocess.run(
            [
                "curl",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "-fsSL",
                "--max-time",
                "60",
                f"https://raw.githubusercontent.com/vercel-labs/agent-browser/v{ENGINE_VERSION}/LICENSE",
                "-o",
                str(stage / "AGENT_BROWSER_LICENSE"),
            ],
            check=True,
        )
        manifest = {
            "format": 1,
            "version": args.version,
            "arch": arch,
            "os": "linux",
            "minimumGlibc": "2.36",
            "engineVersion": ENGINE_VERSION,
            "sourceCommit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
        }
        (stage / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
        package = args.output / f"proofrun-node-linux-{arch}.tar.gz"
        with tarfile.open(package, "w:gz") as archive:
            for path in sorted(stage.rglob("*")):
                archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
    for name in ("install.sh", "install-node.py"):
        shutil.copy2(ROOT / "scripts/node-release" / name, args.output / name)
    # 不收集旧 SHA256SUMS，防止摘要文件把自身写入校验集合。
    assets = [package, args.output / "install.sh", args.output / "install-node.py"]
    checksums = (
        "\n".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}"
            for path in assets
        )
        + "\n"
    )
    (args.output / f"SHA256SUMS-{arch}").write_text(checksums)
    print(package)


if __name__ == "__main__":
    main()

"""安装器的真实文件/SQLite 回归；systemd、doctor 和网络用夹具，不代表 VM 验收。"""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "installer", ROOT / "scripts/node-release/install-node.py"
)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    """使用临时 home 和假进程入口，检查升级边界而不操作开发机用户服务。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "user"
        self.home.mkdir()
        self.chrome = self.root / "chromium"
        self.chrome.write_text("#!/bin/sh\nexit 0\n")
        self.chrome.chmod(0o755)
        self.active = False
        self.fail_start = False
        self.calls = []

    def package(self, version="node-v0.1.0", unsafe=None):
        """构建最小归档，只覆盖布局和完整性，不模拟 ELF 或真实浏览器能力。"""
        path = self.root / (version + ".tar.gz")
        if path.exists() and unsafe is None:
            return path, hashlib.sha256(path.read_bytes()).hexdigest()
        data = {
            "release.json": json.dumps(
                {"format": 1, "version": version, "arch": "x64", "os": "linux"}
            ),
            "bin/proofrun-node": "#!/bin/sh\n",
            "bin/agent-browser": "#!/bin/sh\n",
        }
        if unsafe:
            data[unsafe] = "outside"
        with tarfile.open(path, "w:gz") as archive:
            for name, content in data.items():
                info = tarfile.TarInfo(name)
                info.size = len(content.encode())
                info.mode = 0o755
                archive.addfile(info, io.BytesIO(content.encode()))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def fake_run(self, *args, check=True, env=None):
        """仅模拟服务进程状态；SQLite、归档和原子路径切换仍使用真实文件系统。"""
        self.calls.append(args)
        code, output = 0, ""
        if args[0] == "loginctl":
            output = "yes\n"
        elif args[-1] == "doctor":
            output = '{"dependencyChecksPassed":true}'
        elif "is-active" in args:
            code = 0 if self.active else 3
        elif "stop" in args:
            self.active = False
        elif "enable" in args:
            code = 1 if self.fail_start else 0
            self.active = code == 0
        elif "start" in args:
            self.active = True
        if check and code:
            raise subprocess.CalledProcessError(code, args)
        return subprocess.CompletedProcess(args, code, output, "")

    def install(self, version="node-v0.1.0", first=False):
        """运行真实 main；仅替换操作系统身份和外部进程边界。"""
        package, digest = self.package(version)
        args = [
            "install-node.py",
            "--package",
            str(package),
            "--sha256",
            digest,
            "--version",
            version,
        ]
        if first:
            args += [
                "--api",
                "https://proofrun.example.test",
                "--chrome",
                str(self.chrome),
            ]
        with (
            patch.object(installer.Path, "home", return_value=self.home),
            patch.object(installer.platform, "system", return_value="Linux"),
            patch.object(installer.platform, "machine", return_value="x86_64"),
            patch.object(installer.os, "getuid", return_value=1000),
            patch.object(installer, "run", side_effect=self.fake_run),
            patch.object(installer.time, "sleep"),
            patch.object(sys, "argv", args),
        ):
            installer.main()

    def test_reject_checksum_and_traversal(self):
        # 范围：校验失败或越界归档不产生目录外文件；不覆盖网络下载或签名信任。
        package, digest = self.package(unsafe="../escaped")
        target = self.root / "stage"
        target.mkdir()
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            installer.unpack(package, "0" * 64, target, "x64")
        with self.assertRaisesRegex(ValueError, "越界"):
            installer.unpack(package, digest, target, "x64")
        self.assertFalse((self.root / "escaped").exists())

    def test_reject_symlinks_and_wrong_arch(self):
        # 范围：链接不能改变后续解包目标，错误架构不能进入执行阶段；不运行本机 ELF。
        package, _ = self.package()
        with tarfile.open(package, "w:gz") as archive:
            info = tarfile.TarInfo("bin")
            info.type = tarfile.SYMTYPE
            info.linkname = "/tmp"
            archive.addfile(info)
        target = self.root / "stage"
        target.mkdir()
        with self.assertRaisesRegex(ValueError, "特殊文件"):
            installer.unpack(
                package, hashlib.sha256(package.read_bytes()).hexdigest(), target, "x64"
            )
        package, digest = self.package("node-v0.1.1")
        with self.assertRaisesRegex(ValueError, "平台"):
            installer.unpack(package, digest, target, "arm64")

    def test_first_install_repeat_upgrade_preserve_state(self):
        # 范围：重复安装与升级保留自定义配置、身份及登录态，旧版本仍可定位；不证明真实服务在线。
        self.install(first=True)
        config = self.home / ".config/proofrun/node.toml"
        config.write_text(config.read_text() + "# 自定义注释\n")
        data = self.home / ".local/share/proofrun-node"
        (data / "credential.json").write_text('{"token":"fixture-only"}')
        (data / "node-id").write_text("persistent-node-id")
        (data / "auth").mkdir()
        (data / "auth/state.json").write_text('{"cookies":[]}')
        original = config.read_bytes()
        self.install(first=True)
        self.install("node-v0.1.1")
        current = self.home / ".local/lib/proofrun-node/current"
        self.assertEqual(current.resolve().name, "node-v0.1.1")
        self.assertTrue((current.parent / "releases/node-v0.1.0").exists())
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual((data / "node-id").read_text(), "persistent-node-id")
        self.assertEqual((data / "auth/state.json").read_text(), '{"cookies":[]}')
        self.assertTrue(self.active)

    def test_active_session_blocks_upgrade_before_stop(self):
        # 范围：隔离和活动会话同样阻止升级，拒绝发生在停止服务之前；不模拟真实命令派发竞争。
        self.install(first=True)
        data = self.home / ".local/share/proofrun-node"
        with sqlite3.connect(data / "node.db") as db:
            db.execute("CREATE TABLE sessions(state TEXT)")
            db.execute("INSERT INTO sessions VALUES('QUARANTINED')")
        self.active = True
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "会话"):
            self.install("node-v0.1.1")
        self.assertFalse(any("stop" in call for call in self.calls))
        self.assertTrue(self.active)

    def test_start_failure_keeps_data_and_stops_new_service(self):
        # 范围：新版本启动失败不自动恢复旧 SQLite 或继续运行；不证明未来迁移可逆。
        self.install(first=True)
        data = self.home / ".local/share/proofrun-node"
        (data / "credential.json").write_text('{"token":"fixture-only"}')
        self.active, self.fail_start = True, True
        with self.assertRaises(subprocess.CalledProcessError):
            self.install("node-v0.1.1")
        self.assertFalse(self.active)
        self.assertEqual(
            (data / "credential.json").read_text(), '{"token":"fixture-only"}'
        )
        self.assertEqual(
            (self.home / ".local/lib/proofrun-node/current").resolve().name,
            "node-v0.1.1",
        )


if __name__ == "__main__":
    unittest.main()

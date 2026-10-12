"""发布身份检查回归：执行临时 CLI 夹具，不构建 ELF、下载引擎或代替 Linux 发布验收。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("builder", ROOT / "scripts/node-release/build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class BuildIdentityTests(unittest.TestCase):
    """隔离进程输出验证身份绑定，拒绝标签正确但二进制或提交不匹配的包。"""

    def test_binary_identity_must_match_release(self):
        """验证版本、完整 SHA 与固定引擎逐项绑定；不模拟真实浏览器动作。"""
        version, commit = "node-v0.1.0-alpha.6", "a" * 40
        expected = {"version": version, "sourceCommit": commit, "engineVersion": builder.ENGINE_VERSION}
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "node-fixture"
            for changed in [None, {"version": "0.1.0-dev"}, {"sourceCommit": "b" * 40}, {"sourceCommit": None}, {"engineVersion": "0.1.0"}]:
                with self.subTest(changed=changed):
                    data = expected | (changed or {})
                    binary.write_text("#!/bin/sh\n[ \"$1\" = build-info ] || exit 1\ncat <<'JSON'\n" + json.dumps(data) + "\nJSON\n")
                    binary.chmod(0o755)
                    if changed:
                        with self.assertRaisesRegex(ValueError, "编译身份"):
                            builder.verify_build(binary, version, commit)
                    else:
                        builder.verify_build(binary, version, commit)

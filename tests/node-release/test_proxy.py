"""代理修复脚本的文件与退出码回归；网络、Nginx 和 systemd 均为夹具，不代表生产验收。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

# 测试只复制脚本到临时目录并替换配置路径，永不写入真实 /etc 或 /var/backups。
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/node-release/repair-node-proxy.sh"
MARKER = "# managed-by: proofrun-node-proxy-9444-v1"


class ProxyTests(unittest.TestCase):
    """使用真实 Bash 和临时配置，验证预检、应用、回滚与公网失败分支。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "proxy.conf"
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.calls = self.root / "calls"
        self.script = self.root / "repair.sh"
        self.script.write_text(
            SCRIPT.read_text()
            .replace("readonly CONFIG=/etc/nginx/conf.d/proofrun-node-direct.conf", f"readonly CONFIG='{self.config}'")
            .replace("readonly BACKUP_ROOT=/var/backups", f"readonly BACKUP_ROOT='{self.backups}'")
        )
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # 只替换外部依赖的返回值；文件备份、恢复、配置生成由原 Bash 真实执行。
        stub = "#!" + sys.executable + "\n" + r'''
import os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['PROXY_TEST_CALLS'], 'a') as f:
    f.write(name + ' ' + ' '.join(args) + '\n')
if name == 'uname': print('Linux')
elif name == 'id': print('0')
elif name == 'nginx':
    if '-T' in args: print('include /etc/nginx/conf.d/*.conf;')
    elif os.environ.get('PROXY_TEST_CONFIG_FAIL'): sys.exit(1)
elif name == 'ss':
    if os.environ.get('PROXY_TEST_PORT_BUSY'): print('LISTEN occupied')
elif name == 'systemctl': pass
elif name == 'curl':
    url = args[-1]
    public_failure = url.startswith('https:') and os.environ.get('PROXY_TEST_PUBLIC_FAIL')
    node_failure = ':9310/' in url and os.environ.get('PROXY_TEST_NODE_FAIL')
    code = '502' if public_failure or node_failure else ('200' if url.endswith('/healthz') else '101')
    if '-D' in args: pathlib.Path(args[args.index('-D')+1]).write_text('HTTP/1.1 '+code+' status\r\n')
    output = args[args.index('-o')+1]
    if output != '/dev/null': pathlib.Path(output).write_text('ok\n' if code == '200' else 'bad gateway')
    if '-w' in args: print(code, end='')
'''
        for command in ["uname", "id", "nginx", "ss", "systemctl", "curl"]:
            path = self.bin / command
            path.write_text(stub)
            path.chmod(0o755)

    def run_script(self, apply=False, **options):
        """在临时依赖环境执行脚本；返回完整诊断供断言，不连接节点或 AWS。"""
        env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "PROXY_TEST_CALLS": str(self.calls), **options}
        args = ["bash", str(self.script), "--domain", "node.example.com"]
        if apply:
            args.append("--apply")
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)

    def test_check_never_changes_config_or_service(self):
        """范围：只读模式不写配置或调用服务变更；握手成功由夹具返回，不证明实际首帧。"""
        self.config.write_text("existing\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.config.read_text(), "existing\n")
        self.assertNotIn("systemctl ", self.calls.read_text())

    def test_apply_scopes_routes_and_preserves_headers(self):
        """范围：新代理只放行三个 WebSocket 路径并透传 Origin；不验证真实 TLS/授权。"""
        result = self.run_script(apply=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        config = self.config.read_text()
        self.assertIn("listen 9444 default_server", config)
        self.assertIn("proxy_pass http://127.0.0.1:9310", config)
        self.assertIn("proxy_set_header Origin $http_origin", config)
        self.assertIn("location ~ ^/(hitl/control|hitl/frames|live/frames)$", config)
        self.assertIn("location / { return 404; }", config)
        self.assertNotIn("proofrun-node.service", self.calls.read_text())

    def test_failed_config_restores_previous_file(self):
        """范围：配置校验失败恢复已有托管文件并保留备份；systemd 回滚结果使用夹具。"""
        original = MARKER + "\nold configuration\n"
        self.config.write_text(original)
        result = self.run_script(apply=True, PROXY_TEST_CONFIG_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), original)
        self.assertEqual(len(list(self.backups.glob("*/proofrun-node-direct.conf"))), 1)

    def test_public_failure_keeps_verified_local_proxy(self):
        """范围：公网 502 返回独立失败码并保留已验证本机配置；不推测真实 ALB 故障原因。"""
        result = self.run_script(apply=True, PROXY_TEST_PUBLIC_FAIL="1")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertTrue(self.config.exists())
        self.assertIn("不能宣称实时画面已修复", result.stdout)
        self.assertIn("HTTP、端口 9444", result.stdout)

    def test_node_failure_prevents_mutation(self):
        """范围：节点入口不可用时不安装代理、不操作服务；不诊断真实 Node 进程。"""
        result = self.run_script(apply=True, PROXY_TEST_NODE_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.config.exists())
        self.assertNotIn("nginx ", self.calls.read_text())
        self.assertNotIn("systemctl ", self.calls.read_text())

    def test_foreign_config_and_busy_port_are_preserved(self):
        """范围：拒绝覆盖他人配置及已有端口；不模拟实际进程归属或 Linux 权限边界。"""
        self.config.write_text("foreign configuration")
        result = self.run_script(apply=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), "foreign configuration")
        self.config.unlink()
        result = self.run_script(apply=True, PROXY_TEST_PORT_BUSY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.config.exists())


if __name__ == "__main__":
    unittest.main()

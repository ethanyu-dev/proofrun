#!/usr/bin/env bash
# 验证范围：在一次性 Linux systemd 容器内运行假引擎会话与回环网关集成场景。
# 不包含真实 Chrome、生产 TLS 或内网 VM 部署验收。
set -euo pipefail
root_dir=$(cd "$(dirname "$0")/../.." && pwd)
container_name="proofrun-node-test-$$"
image_name="proofrun-node-systemd-test:local"
cleanup() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker build -f "$root_dir/tests/browser-node/Dockerfile" -t "$image_name" "$root_dir"
# 临时容器运行 systemd/cgroup 集成测试时需要 privileged 权限。
docker run -d --name "$container_name" --label proofrun.test=browser-node \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v "$root_dir:/workspace:ro" -w /workspace -e CARGO_TARGET_DIR=/target "$image_name" >/dev/null
docker exec "$container_name" bash -c 'for attempt in {1..30}; do systemctl start user@1000.service && exit 0; sleep 1; done; exit 1'
docker exec "$container_name" cargo build --locked --workspace
for suite in systemd_integration gateway_integration; do
  docker exec "$container_name" runuser -u proofrun -- \
    env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    python3 "tests/browser-node/$suite.py"
done

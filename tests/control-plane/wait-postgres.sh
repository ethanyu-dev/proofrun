#!/usr/bin/env bash
# 仅等待本次测试容器的正式 TCP 实例；初始化用的 Unix socket 实例不代表服务已就绪。
set -euo pipefail
postgres_name=${1:?需要测试容器名}
# 默认等待三十轮；第二个参数供有界超时回归缩短等待。
max_attempts=${2:-30}
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  if docker exec "$postgres_name" pg_isready -h 127.0.0.1 -U postgres -d proofrun; then
    exit 0
  fi
  if ((attempt < max_attempts)); then sleep 1; fi
done
echo "测试 PostgreSQL 正式 TCP 实例未就绪：$postgres_name" >&2
# 先输出独占测试容器的状态与日志，再由调用方清理，避免只留下静默的 exit 1。
docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}' "$postgres_name" >&2 || true
docker logs --tail 80 "$postgres_name" >&2 || true
exit 1

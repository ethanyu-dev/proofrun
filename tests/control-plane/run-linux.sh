#!/usr/bin/env bash
# 默认验证独立 PostgreSQL、API/Rust Node/systemd 和故障浏览器夹具。
# PROOFRUN_TEST_REAL_AGENT=true 切换为真实 Chromium 和执行 Agent，模型仍使用本地脚本。
# 仅创建本脚本独占的容器和网络，退出时删除；不读取现有数据库或节点凭据。
set -euo pipefail
root_dir=$(cd "$(dirname "$0")/../.." && pwd)
test_id="proofrun-control-test-$$"
real_agent=${PROOFRUN_TEST_REAL_AGENT:-false}
evaluation=${PROOFRUN_TEST_EVALUATION:-false}
if [[ "$evaluation" == true ]]; then
  test "$real_agent" == true
  evaluation_output=${PROOFRUN_EVAL_OUTPUT:?需要独立的新结果目录}
  mkdir -m 700 "$evaluation_output"
fi
if [[ "${PROOFRUN_TEST_FULL_LINUX:-false}" == true && "$real_agent" != true ]]; then
  echo '完整 Linux 回归需要 PROOFRUN_TEST_REAL_AGENT=true' >&2
  exit 1
fi
mounts=(-v "$root_dir:/workspace:ro")
offline=()
if [[ -n "${PROOFRUN_TEST_CARGO_REGISTRY:-}" ]]; then
  mounts+=(-v "$PROOFRUN_TEST_CARGO_REGISTRY:/usr/local/cargo/registry:ro")
  offline=(--offline)
fi
engine_env=(XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus)
driver="tests/control-plane/linux_integration.py"
network_name="$test_id-net"
postgres_name="$test_id-pg"
node_name="$test_id-node"
image_name="proofrun-node-systemd-test:local"
cleanup() {
  cleanup_status=$?
  if [[ "$evaluation" == true ]]; then
    if ! docker cp "$node_name:/tmp/proofrun-evaluation-output/." "$evaluation_output/" >/dev/null 2>&1; then
      echo '测评材料复制失败，不能将本次运行视为完整交付' >&2
      if [[ "$cleanup_status" == 0 ]]; then cleanup_status=1; fi
    fi
  fi
  docker rm -fv "$node_name" "$postgres_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  exit "$cleanup_status"
}
trap cleanup EXIT
cd "$root_dir"
pnpm build:devpass
pnpm --filter @proofrun/contracts build
pnpm --filter @proofrun/api build
if [[ "$real_agent" == true ]]; then pnpm --filter @proofrun/agent build; fi
if [[ "${PROOFRUN_TEST_SKIP_IMAGE_BUILD:-false}" != true ]]; then
  docker build -f tests/browser-node/Dockerfile -t "$image_name" .
fi
if [[ "$real_agent" == true ]]; then
  # 显式传入与容器架构匹配的原生 CLI；不下载或替换开发机上现有引擎。
  engine_bin=${PROOFRUN_TEST_AGENT_BROWSER:?设置固定为 0.38.1 的 Linux 原生 agent-browser 路径}
  engine_bin=$(cd "$(dirname "$engine_bin")" && pwd)/$(basename "$engine_bin")
  test -x "$engine_bin"
  image_name="proofrun-agent-chromium-test:local"
  if [[ "${PROOFRUN_TEST_SKIP_IMAGE_BUILD:-false}" != true ]]; then
    docker build -f tests/agent/Dockerfile -t "$image_name" .
  fi
  mounts+=(-v "$engine_bin:/opt/agent-browser:ro")
  engine_env+=(PROOFRUN_AGENT_BROWSER_BIN=/opt/agent-browser PROOFRUN_CHROME_BIN=/usr/bin/chromium)
  driver="tests/agent/linux_real_browser.py"
  if [[ "${PROOFRUN_TEST_HITL:-false}" == true ]]; then driver="tests/hitl/linux_real_browser.py"; fi
  if [[ "$evaluation" == true ]]; then driver="tests/scenarios/linux_evaluation.py"; fi
fi
docker network create --label proofrun.test=control-plane "$network_name" >/dev/null
docker run -d --name "$postgres_name" --network "$network_name" --label proofrun.test=control-plane \
  -e POSTGRES_PASSWORD=proofrun-isolated-test -e POSTGRES_DB=proofrun postgres:17 >/dev/null
bash tests/control-plane/wait-postgres.sh "$postgres_name"
# privileged 只供一次性测试容器中的 systemd/cgroup 使用；真实 VM 使用普通用户服务。
docker run -d --name "$node_name" --network "$network_name" --label proofrun.test=control-plane \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  "${mounts[@]}" -w /workspace -e CARGO_TARGET_DIR=/target "$image_name" >/dev/null
docker exec "$node_name" bash -c 'for attempt in {1..30}; do systemctl start user@1000.service && exit 0; sleep 1; done; exit 1'
# 离线调试可显式使用已缓存工具链；默认仍遵循仓库固定版本。
toolchain=()
if [[ -n "${PROOFRUN_TEST_RUST_TOOLCHAIN:-}" ]]; then
  toolchain=("+$PROOFRUN_TEST_RUST_TOOLCHAIN")
fi
# macOS 自带 Bash 3 在 nounset 下不能直接展开空数组；未配置覆盖时不传入占位空参数。
docker exec "$node_name" cargo ${toolchain[@]+"${toolchain[@]}"} --version
# 真实浏览器必须使用发布默认路径；故障引擎仅在显式夹具构建中可用。
fixture_features=()
if [[ "$real_agent" != true ]]; then fixture_features=(--features protocol-fixtures); fi
docker exec "$node_name" cargo ${toolchain[@]+"${toolchain[@]}"} build --locked ${offline[@]+"${offline[@]}"} --workspace ${fixture_features[@]+"${fixture_features[@]}"}
# 只传递评测所需白名单；不挂载开发凭据文件，也不将秘密展开到命令行。
evaluation_env=()
if [[ "$evaluation" == true ]]; then
  for name in PROOFRUN_EVAL_HTTPS_PROXY PROOFRUN_EVAL_MODEL_KIND PROOFRUN_EVAL_MODE PROOFRUN_EVAL_SUITE PROOFRUN_EVAL_REPEAT PROOFRUN_EVAL_SAMPLE_MS PROOFRUN_EVAL_MAX_CALLS PROOFRUN_MODEL_BASE_URL PROOFRUN_MODEL_API_KEY PROOFRUN_MODEL PROOFRUN_MODEL_VISION PROOFRUN_MODEL_TOKEN_PARAMETER PROOFRUN_MODEL_THINKING PROOFRUN_MODEL_MAX_TOKENS PROOFRUN_MODEL_REASONING_EFFORT; do
    evaluation_env+=(-e "$name")
  done
fi
docker exec ${evaluation_env[@]+"${evaluation_env[@]}"} "$node_name" runuser -u proofrun -- \
  env "${engine_env[@]}" \
  "PROOFRUN_DATABASE_URL=postgresql://postgres:proofrun-isolated-test@$postgres_name:5432/proofrun" \
  python3 "$driver"

if [[ "$evaluation" == true ]]; then exit 0; fi

if [[ "$real_agent" == true ]]; then
  # DOM 坐标与 Cookie 清理采用真实 Chromium，独立 profile；不接触生产站点。
  dom_test_bin=$(docker exec "$node_name" cargo ${toolchain[@]+"${toolchain[@]}"} test --locked ${offline[@]+"${offline[@]}"} -p proofrun-node --lib --no-run --message-format=json | python3 -c 'import json,sys; artifacts=[json.loads(line) for line in sys.stdin]; print(next(item["executable"] for item in artifacts if item.get("reason")=="compiler-artifact" and item.get("profile",{}).get("test") and item.get("executable") and "lib" in item["target"]["kind"]))')
  docker exec "$node_name" runuser -u proofrun -- env PROOFRUN_TEST_CHROME=/usr/bin/chromium "$dom_test_bin" native_dom_preserves_language_and_clicks_visible_portion --ignored
  # 真实 Chromium 的临时身份隔离与网络元数据验证，不使用模型夹具结论代替业务验收。
  docker exec "$node_name" runuser -u proofrun -- \
    env "${engine_env[@]}" PROOFRUN_TEST_BINARY=/target/debug/proofrun-node \
    python3 tests/browser-node/auth_network_smoke.py
fi

if [[ "${PROOFRUN_TEST_FULL_LINUX:-false}" == true ]]; then
  # 复用隔离容器与编译产物；各脚本自行创建会话、数据库或临时 profile。
  # systemd/gateway 使用故障引擎，能力和 HITL 使用真实 Chromium，均不访问业务账号。
  for suite in tests/browser-node/input_network_smoke.py tests/browser-node/profile_tabs_smoke.py tests/browser-node/external_account_smoke.py tests/browser-node/systemd_integration.py tests/browser-node/gateway_integration.py tests/browser-node/capabilities_smoke.py tests/hitl/linux_real_browser.py; do
    suite_env=("${engine_env[@]}")
    suite_binary=/target/debug/proofrun-node
    if [[ "$suite" == tests/browser-node/systemd_integration.py || "$suite" == tests/browser-node/gateway_integration.py ]]; then
      # 配置文件指定故障引擎；真实引擎环境变量优先级更高，必须在此移除。
      # 单独保存夹具二进制，后续真实浏览器仍运行默认构建。
      if ! docker exec "$node_name" test -x /target/fixtures/debug/proofrun-node; then
        docker exec "$node_name" env CARGO_TARGET_DIR=/target/fixtures cargo ${toolchain[@]+"${toolchain[@]}"} build --locked ${offline[@]+"${offline[@]}"} --workspace --features protocol-fixtures
      fi
      suite_binary=/target/fixtures/debug/proofrun-node
      suite_env=(XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus)
    fi
    docker exec "$node_name" runuser -u proofrun -- \
      env -u PROOFRUN_AGENT_BROWSER_BIN -u PROOFRUN_CHROME_BIN "${suite_env[@]}" PROOFRUN_TEST_BINARY="$suite_binary" \
      "PROOFRUN_DATABASE_URL=postgresql://postgres:proofrun-isolated-test@$postgres_name:5432/proofrun" \
      python3 "$suite"
  done
fi

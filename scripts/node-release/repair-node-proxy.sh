#!/usr/bin/env bash
# 检查并修复 ALB 后面的节点 HTTP 代理；不重启 Node、不触碰会话或修改云端网络配置。
set -euo pipefail
umask 077
# 部分 sudo/会话环境未包含系统管理目录，避免把已安装的 nginx、ss 误判为缺失。
export PATH="${PATH}:/usr/sbin:/sbin"

# 与节点默认回环入口及现有 ALB 代理部署约定一致，不向公网直接暴露节点监听。
readonly NODE_PORT=9310
readonly PROXY_PORT=9444
readonly CONFIG=/etc/nginx/conf.d/proofrun-node-direct.conf
readonly BACKUP_ROOT=/var/backups
readonly MARKER='# managed-by: proofrun-node-proxy-9444-v1'
readonly WS_KEY='dGhlIHNhbXBsZSBub25jZQ=='
readonly PATHS=(/live/frames /hitl/control /hitl/frames)
domain=''
apply=0
changed=0
had_config=0
was_active=0
backup=''
staged=''

usage() {
  echo "用法：sudo bash $0 --domain agent-browser-runtime.pplabs.tech [--apply]"
  echo '默认只检查；--apply 仅修复本机 Nginx，ALB 应使用 HTTP:9444，健康检查 /healthz。'
}
while (( $# )); do
  case "$1" in
    --domain) [[ $# -ge 2 ]] || { usage; exit 1; }; domain=$2; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done
# 限定纯域名，避免把路径、端口或 Nginx 配置片段插入生成文件。
[[ $domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $domain == *.* ]] || { usage; exit 1; }
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || { echo '请在目标 Linux 节点机上用 sudo 执行。'; exit 1; }
command -v curl >/dev/null
command -v systemctl >/dev/null
work=$(mktemp -d)

# 本机校验失败时恢复配置；公网探测失败不能证明本机配置错误，因此本机验收后不自动回退。
cleanup() {
  local status=$?
  trap - EXIT
  if (( changed )); then
    echo '本机代理校验失败，正在恢复原配置。' >&2
    if (( had_config )); then cp -p "$backup" "$CONFIG"; else rm -f "$CONFIG"; fi
    if (( was_active )); then
      nginx -t && systemctl reload nginx || echo '恢复后的 reload 失败，请检查 Nginx 日志。' >&2
    else
      systemctl stop nginx || true
    fi
  fi
  if [[ -n $staged ]]; then rm -f "$staged"; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

# 只验证 WebSocket HTTP 握手，不发送身份凭据或浏览器输入；101 不等于已取得媒体首帧。
probe_ws() {
  local url=$1 label=$2 code
  : >"$work/headers"
  curl --noproxy '*' --http1.1 -sS --connect-timeout 3 --max-time 5 \
    -D "$work/headers" -o /dev/null \
    -H "Host: $domain" -H 'Origin: https://proofrun.ethankit.com' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $WS_KEY" \
    "$url" 2>"$work/curl-error" || true
  code=$(awk '/^HTTP\// {code=$2} END {print code}' "$work/headers")
  printf '%s：HTTP %s\n' "$label" "${code:-无响应}"
  [[ $code == 101 ]]
}

# 健康检查同时核对响应正文，不能将其他站点返回的 200 当成节点代理正常。
probe_health() {
  local url=$1 label=$2 code
  : >"$work/body"
  code=$(curl --noproxy '*' -sS --connect-timeout 3 --max-time 8 \
    -H "Host: $domain" -o "$work/body" -w '%{http_code}' "$url" 2>"$work/curl-error") || true
  printf '%s：HTTP %s\n' "$label" "${code:-无响应}"
  [[ $code == 200 && $(cat "$work/body") == ok ]]
}

echo "目标：${domain}；模式：$([[ $apply == 1 ]] && echo 修复 || echo 只读检查)"
node_ok=1
for path in "${PATHS[@]}"; do
  probe_ws "http://127.0.0.1:$NODE_PORT$path" "Node $NODE_PORT$path" || node_ok=0
done
if (( ! node_ok )); then
  echo 'Node 回环入口未通过。未修改代理；请以节点运行用户检查 proofrun-node.service 状态及日志。'
  exit 1
fi

if (( apply )); then
  if ! command -v nginx >/dev/null; then
    echo '未安装 Nginx。请先通过发行版软件源安装 nginx，再运行此脚本；本次未修改配置。'
    exit 1
  fi
  nginx -T >"$work/nginx-config" 2>"$work/nginx-error" || { cat "$work/nginx-error"; exit 1; }
  grep -Eq '^[[:space:]]*include[[:space:]]+"?/etc/nginx/conf.d/\*\.conf"?[[:space:]]*;' "$work/nginx-config" || {
    echo '现有 Nginx 未引入标准 conf.d 目录，未修改配置。'; exit 1;
  }
  if [[ -e $CONFIG || -L $CONFIG ]]; then
    [[ -f $CONFIG && ! -L $CONFIG ]] && grep -Fxq "$MARKER" "$CONFIG" || {
      echo "已有非本脚本管理的配置 ${CONFIG}，未覆盖。"; exit 1;
    }
    had_config=1
    mkdir -p "$BACKUP_ROOT"
    backup_dir=$(mktemp -d "$BACKUP_ROOT/proofrun-node-proxy-XXXXXXXX")
    backup=$backup_dir/proofrun-node-direct.conf
    cp -p "$CONFIG" "$backup"
    echo "原配置备份：$backup"
  else
    command -v ss >/dev/null
    if ss -H -ltn "sport = :$PROXY_PORT" | grep -q .; then
      echo "$PROXY_PORT 已有其他监听，未覆盖或停止任何服务。"; exit 1;
    fi
  fi
  if systemctl is-active --quiet nginx; then was_active=1; fi
  cat >"$work/proxy.conf" <<EOF
$MARKER
server {
    listen $PROXY_PORT default_server;
    server_name $domain;
    server_tokens off;
    client_max_body_size 32k;
    access_log off;
    location = /healthz {
        default_type text/plain;
        return 200 "ok\n";
    }
    location ~ ^/(hitl/control|hitl/frames|live/frames)\$ {
        proxy_pass http://127.0.0.1:$NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header Origin \$http_origin;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 30s;
    }
    location / { return 404; }
}
EOF
  staged=$(mktemp "${CONFIG}.pending.XXXXXXXX")
  install -m 0644 "$work/proxy.conf" "$staged"
  changed=1
  mv -f "$staged" "$CONFIG"
  staged=''
  nginx -t
  if (( was_active )); then systemctl reload nginx; else systemctl start nginx; fi
fi

local_ok=1
probe_health "http://127.0.0.1:$PROXY_PORT/healthz" "代理 $PROXY_PORT/healthz" || local_ok=0
for path in "${PATHS[@]}"; do
  probe_ws "http://127.0.0.1:$PROXY_PORT$path" "代理 $PROXY_PORT$path" || local_ok=0
done
if (( ! local_ok )); then
  echo '本机代理未通过。只读检查可加 --apply 修复；修复模式会恢复原配置。'
  exit 1
fi
# 从这里开始本机配置已经验证；外部 ALB 故障保留已验证的本机配置供管理员继续排查。
changed=0
public_ok=1
probe_health "https://$domain/healthz" '公网 /healthz' || public_ok=0
for path in "${PATHS[@]}"; do
  probe_ws "https://$domain$path" "公网 $path" || public_ok=0
done
if (( ! public_ok )); then
  echo '本机 Node 与代理均通过，但公网未通过；不能宣称实时画面已修复。'
  echo "请核对 ALB：域名 $domain 的监听规则指向本节点；目标协议 HTTP、端口 ${PROXY_PORT}；健康检查 HTTP /healthz，成功码 200。"
  echo "若目标组协议为 HTTPS，请改用匹配本机明文代理的 HTTP 目标组；本脚本不修改 ALB、安全组或防火墙。"
  echo '请把以上检查结果发回；不要发送节点凭据、密钥或完整环境变量。'
  exit 2
fi
echo '本机及公网握手均通过。请返回 Console 点击「重新连接画面」，以实际收到首帧为最终验证。'

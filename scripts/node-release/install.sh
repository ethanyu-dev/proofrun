#!/usr/bin/env bash
# 下载固定 release 内的包和安装器；控制面由 Railway 独立部署。
set -euo pipefail
readonly REPOSITORY=ethanyu-dev/proofrun
version=''
args=()
while (($#)); do
  case "$1" in
    --version) version=${2:?需要 release 版本}; shift 2 ;;
    --api|--pool|--chrome|--pairing-token-file) args+=("$1" "${2:?参数缺少值}"); shift 2 ;;
    -h|--help) echo '用法：bash install.sh [--version node-v0.1.0] [--api https://域名 --pool internal --chrome /usr/bin/chromium] [--pairing-token-file 文件]'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo '仅支持 Linux' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3, 11), "需要 Python 3.11+"'
case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo '仅支持 x64 / arm64' >&2; exit 1 ;;
esac
# latest 只解析一次，后续资产全部绑定同一 tag，避免发布更新时混用版本。
if [[ -z "$version" ]]; then
  resolved=$(curl --proto '=https' --proto-redir '=https' -fsSL --max-time 30 -o /dev/null -w '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest")
  version=${resolved##*/}
fi
[[ "$version" =~ ^node-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo '无有效节点 release，请用 --version 指定 node-vX.Y.Z（可带预发布后缀）' >&2; exit 1; }
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
package="proofrun-node-linux-$arch.tar.gz"
for asset in SHA256SUMS install-node.py "$package"; do
  curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 15 --max-time 180 --retry 2 \
    "https://github.com/$REPOSITORY/releases/download/$version/$asset" -o "$temporary/$asset"
done
# 仅校验本机需要的资产，拒绝缺失或重复摘要条目。
checksum() {
  python3 - "$temporary/SHA256SUMS" "$1" <<'PY'
import pathlib, re, sys
rows = [line.split() for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
values = [row[0] for row in rows if len(row) == 2 and row[1] == sys.argv[2]]
assert len(values) == 1 and re.fullmatch('[a-f0-9]{64}', values[0]), '资产摘要缺失或重复'
print(values[0])
PY
}
installer_hash=$(checksum install-node.py)
package_hash=$(checksum "$package")
printf '%s  %s\n' "$installer_hash" "$temporary/install-node.py" | sha256sum --check --status
python3 "$temporary/install-node.py" --package "$temporary/$package" --sha256 "$package_hash" --version "$version" "${args[@]}"

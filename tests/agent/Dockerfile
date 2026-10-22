# 独立构建层只安装图片依赖，不向 systemd 运行镜像加入包管理器。
FROM node:24-bookworm-slim AS native-dependencies
COPY apps/agent/package.json /tmp/proofrun-agent-package.json
RUN node -e 'const {spawnSync}=require("node:child_process"); const version=require("/tmp/proofrun-agent-package.json").dependencies.sharp; const result=spawnSync("npm",["install","--prefix","/opt/proofrun-native","--no-package-lock","--no-save","sharp@"+version],{stdio:"inherit"}); if(result.error) throw result.error; process.exit(result.status??1)'

FROM proofrun-node-systemd-test:local
# 仅测试镜像包含 Chromium；生产镜像和 VM 安装策略由部署环境决定。
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
# 中文回退字体单独成层，更新字体时不重复安装浏览器；截图不依赖宿主机字体。
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk && fc-cache -f && rm -rf /var/lib/apt/lists/*
# 宿主机挂载的依赖可能来自 macOS；为截图预处理提供与 Agent 同版本的 Linux 原生依赖。
COPY --from=native-dependencies /opt/proofrun-native /opt/proofrun-native
ENV NODE_PATH=/opt/proofrun-native/node_modules

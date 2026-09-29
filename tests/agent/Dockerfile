FROM proofrun-node-systemd-test:local
# 仅测试镜像包含 Chromium；生产镜像和 VM 安装策略由部署环境决定。
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
# 中文回退字体单独成层，更新字体时不重复安装浏览器；截图不依赖宿主机字体。
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk && fc-cache -f && rm -rf /var/lib/apt/lists/*

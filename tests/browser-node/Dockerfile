FROM node:24-bookworm-slim AS node-runtime
FROM rust:1.98.0-bookworm
# 此镜像仅用于隔离的集成测试，systemd 必须作为 PID 1。
# Node.js 用来运行同一容器中的真实控制面，不进入生产 Browser Node。
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd python3 cmake && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 proofrun \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/proofrun
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

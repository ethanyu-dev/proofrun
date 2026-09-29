# 两个副本均设 PROOFRUN_API_HA=true；地址示例为同机双进程，跨主机请换成内网地址。
# 主备共享数据库、密钥和证据目录；ready 只有持锁并健康的活动副本返回 200。
{$PROOFRUN_DOMAIN} {
    @control path /v1/* /health/*
    handle @control {
        reverse_proxy {$PROOFRUN_API_A:127.0.0.1:4101} {$PROOFRUN_API_B:127.0.0.1:4102} {
            health_uri /health/ready
            health_status 200
            health_interval 1s
            health_timeout 1s
            fail_duration 2s
            # 不配置 HTTP 请求自动重试，未知写入只按平台命令身份恢复。
        }
    }
    handle {
        root * /opt/proofrun/apps/console/dist
        try_files {path} /index.html
        file_server
    }
    header X-Content-Type-Options nosniff
}

-- 仅保存访问元数据；查询参数、凭据与正文均不得进入访问记录。
CREATE TABLE pr_access_logs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  ip inet,
  kind text NOT NULL CHECK (kind IN ('console_login', 'http')),
  method text NOT NULL,
  route text NOT NULL,
  status_code integer NOT NULL,
  duration_ms double precision NOT NULL
);

-- 时间索引用于保留期清理，组合索引服务登录和来源 IP 筛选。
CREATE INDEX pr_access_logs_at ON pr_access_logs(at);
CREATE INDEX pr_access_logs_kind_id ON pr_access_logs(kind, id DESC);
CREATE INDEX pr_access_logs_ip_id ON pr_access_logs(ip, id DESC);

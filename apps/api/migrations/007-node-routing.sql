-- 域名映射属于资源池；撤销节点后保留规则，避免任务静默改派到其他机器。
CREATE TABLE pr_node_routes (
  pool text NOT NULL,
  hostname text NOT NULL,
  node_id text NOT NULL REFERENCES pr_nodes(id),
  PRIMARY KEY(pool, hostname)
);
CREATE INDEX pr_node_routes_owner ON pr_node_routes(node_id);
-- 编辑版本防止多个管理员互相覆盖域名配置。
ALTER TABLE pr_nodes ADD COLUMN routing_revision integer NOT NULL DEFAULT 0;

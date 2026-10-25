-- 节点准入由 Node 根据资源决定；删除不再参与派发的历史固定容量字段。
ALTER TABLE pr_nodes DROP COLUMN capacity;

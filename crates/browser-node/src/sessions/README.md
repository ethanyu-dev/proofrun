# Sessions

已实现容量准入、会话生命周期、独立引擎 session / profile、内部 host、systemd 进程监管和关闭确认。

会话内串行，跨会话按许可并发。CLI 退出不代表 daemon 或浏览器退出。超时撤权、终止进程和确认关闭是不同步骤；未确认关闭前保留占用状态。

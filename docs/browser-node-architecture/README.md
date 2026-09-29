# Browser Node 结构图

本文件集中维护 Browser Node 在 ProofRun 中的位置及其内部结构。图中的箭头表示目标数据流；标注的实现状态以当前代码为准。节点、最小控制面和执行 Agent 已接通；模型服务与型号可配置，Console 已接入任务、节点查询与报告证据。

## 在项目中的位置

```mermaid
flowchart LR
  U[上层 Agent<br/>定义目标、环境和验收标准]
  UI[Console<br/>任务、节点查询与报告]

  subgraph CP[控制面 · apps/api · 首版已实现]
    API[任务状态、全局队列、路由与租约<br/>最终报告归控制面]
    G[节点网关<br/>主动连接与持久结果]
  end

  A[验证执行 Agent · apps/agent<br/>选择页面操作并按既定标准判定<br/>可配置模型 · 有界执行循环]

  subgraph LOCAL[内网执行环境]
    N[Browser Node · Rust<br/>主动连接、准入、会话监管<br/>去重恢复与证据交付 · 首版已实现]
    E[agent-browser CLI / daemon<br/>独立 Chrome 会话]
    B[内网业务系统]
  end

  U -->|VerificationTask| API
  UI <-->|查看任务与报告| API
  API -.->|派发验证任务| A
  A -.->|结构化浏览器请求| G
  A -.->|逐项验收结果与证据引用| API
  N -->|主动建立 WSS、心跳与结果| G
  G -->|通过已有连接下发命令| N
  N -->|有限浏览器操作| E
  E -->|页面访问| B
  API -.->|汇总验收结论| UI

  classDef ready fill:#e6f5ee,stroke:#239a7d,stroke-width:2px,color:#173b31;
  classDef scaffold fill:#f1f4f9,stroke:#9baac0,stroke-width:1.5px,color:#32445f;
  class N,API,G ready;
  class UI,A scaffold;
```

Browser Node 只返回浏览器操作事实与证据，不定义验收标准，也不把操作成功判定为业务验收通过。控制面拥有全局任务状态和最终报告；执行 Agent 负责页面决策与逐项验收。

## Browser Node 内部结构

```mermaid
flowchart TB
  CP[控制面节点网关<br/>apps/api]
  TARGET[内网业务系统]

  subgraph NODE[proofrun-node · 一个可部署的 Rust 二进制]
    GW[gateway/mod.rs<br/>主动连接、心跳、ACK、重连]
    ENTRY[node.rs<br/>Schema、身份与租约校验<br/>先登记、再派发、后提交]
    STORE[(store.rs · SQLite<br/>会话意图、命令去重、结果 outbox)]
    SESS[sessions/mod.rs<br/>本机容量、租约、取消与串行准入]
    PROC[process.rs<br/>systemd 创建、关闭与 cgroup 核实]
    ART[artifacts.rs<br/>PNG 暂存、SHA-256、上传回执]

    subgraph CGROUP[每个会话独立的 systemd service / cgroup v2]
      HOST[session-host<br/>同一二进制的内部模式<br/>有界 JSONL 管道]
      ENG[engine/mod.rs<br/>固定 CLI 参数与观察目标映射]
      CLI[agent-browser CLI<br/>每次操作短暂启动]
      DAEMON[agent-browser daemon + 独立 Chrome<br/>会话期间常驻]
      HOST --> ENG --> CLI --> DAEMON
    end

    GW -->|下发命令| ENTRY
    ENTRY -->|派发前登记、提交终态| STORE
    STORE -->|未确认结果重送| GW
    ENTRY -->|会话准入| SESS
    SESS -->|启动与关闭| PROC
    PROC -->|监管进程范围| HOST
    SESS -->|浏览器操作、续租和关闭| HOST
    ENG -->|截图文件| ART
  end

  CP <-->|WSS：命令、心跳、结果与 ACK| GW
  ART -->|HTTPS 上传；核对持久化回执| CP
  DAEMON -->|浏览器访问| TARGET
```

同一会话内只执行一个浏览器操作，续租和关闭可绕过操作队列。CLI 退出不等于浏览器关闭；只有核实原 systemd 进程范围已清空或消失，节点才释放容量。命令在派发前写入 SQLite，重启后未提交的结果报告为 `UNKNOWN`，不重放浏览器动作。截图在存储回执核对并提交后才标记为可用并删除本地文件。

写动作当前默认关闭。节点层的命令去重不能证明 agent-browser 在“业务已提交但响应丢失”时不会内部重试；真实控制面联调已通过；真实 Linux Chrome 和内网 VM 仍待验收。

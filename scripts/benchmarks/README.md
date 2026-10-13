# Browser Node 容量基准

`node_capacity.py` 在 Linux 节点上测量独立 profile 数量与 profile 内分组并发。仅依赖 Python 3.10+ 标准库和已安装的 ProofRun Browser Node、Chrome、用户 systemd。

## 运行

使用原节点运行用户，不要 sudo。先停止提交新任务，确保 Console 中节点无活动会话：

```bash
python3 node_capacity.py --mode smoke
python3 node_capacity.py --mode matrix --repeat 2
```

默认矩阵先以 1 个 profile 测分组并发 1、2、4、6、8，再以分组并发 2 测 profile 数量 2、4、8、12、16。每个 profile 固定完成 6 个独立分组；每组包含导航、填写、点击和三次真实 DOM/截图采集，两次模拟模型等待各 3 秒。可调整：

```bash
# 固定分组并发，对比节点容量；每个点重复 3 次。
python3 node_capacity.py --mode capacity --profiles 4 8 12 16 --concurrency 2 --repeat 3

# 固定 1 个 profile，对比分组并发。
python3 node_capacity.py --mode profile --groups 8 --concurrency 2 4 6 8 --repeat 3

# 去掉模型等待，测浏览器密集操作压力；应单独分析，不能混入 3 秒等待曲线。
python3 node_capacity.py --mode capacity --profiles 1 2 4 8 12 16 --concurrency 2 --think 0 --repeat 2
```

已完成分组的 tab 当前保留到整个 profile 结束，因此内存随分组总数增长，不能只按同时运行的组数估算。

`--groups` 控制每个 profile 的总分组数量，`--think` 控制每次模拟模型等待秒数。`--output` 必须指定尚不存在的目录。配置采用默认 `~/.config/proofrun/node.toml`；Python 3.10 支持标准单行路径字符串，自定义 TOML 写法可改用 Python 3.11。

## 测量范围

包含真实发布二进制的 stdio 命令入口、SQLite、systemd/cgroup 会话、agent-browser、Chromium、tab 切换、DOM 观察与截图写入。每个 profile 内浏览器命令串行，模拟模型等待在锁外发生，与当前分组执行的主要排队关系一致。检查填写和点击结果的 tab 归属及会话最终 CLOSED。

不包含生产 API 调度、Railway worker 数量、远程证据上传、真实模型请求及限流、业务站点脚本/网络负载或生产身份状态。因此只能据此选出特定工作负载的候选容量，不能宣称获得所有线上任务的全局最优值。页面为 200 行表格和输入交互的本机夹具，重型应用需要另做代表性验收。多语言页面的共享 Cookie 等业务干扰也不属于此性能基准。

## 隔离与停止

- 读取原节点配置中的路径及会话数量，不读取凭据或登录快照。
- 每档启动独立数据目录、节点身份、systemd 会话和浏览器 profile，只访问本机随机端口页面，不连接生产控制面，不修改生产 capacity。
- 每秒检查物理内存及原节点账本。低于 3 GiB 或总内存 20% 的较大值，或生产出现未关闭会话，即停止继续派发并回收测试会话；在途命令有超时。这不是绝对的瞬时峰值内存保护，因此应在空闲节点逐档测试。
- 同一用户的测试使用独占锁；Ctrl+C / SIGTERM 停止继续派发并执行正常回收。
- 命令、正确性或关闭检查出现任何错误，停止后续档位。正常结束通过正式节点 shutdown 清理；独立会话同时有短租约保护。
- 成功档位清除本次产生的截图/profile，只保留结果、账本和日志；失败档位保留现场。原节点服务始终不被重启或停止。

## 结果

默认保存在 `~/proofrun-benchmark-日期时间/`：

- `environment.json`：二进制版本、机器信息与测试参数。
- `results.jsonl`：每档吞吐、耗时、命令及锁等待 P95、整机 CPU、可用内存和错误。
- `p*-g*-r*/metrics.json`：每秒资源采样。
- `p*-g*-r*/node.log`、`state/node.db`：诊断与会话关闭依据。

比较相同 groups/think 参数、同一硬件下的重复试验。优先选择无错误、关闭均核实、内存留有余量且吞吐提升开始放缓之前的档位；同时检查尾延迟。所有 CPU/内存指标为整机测量，存在其它服务负载时不应将差异全部归因于浏览器。容量不是 worker 数；一个 worker 当前一次仅执行一个任务，部署的 worker 数量和模型配额也需满足所选总并发。

## 单任务延迟参考

2026-10-13，Ubuntu 22.04、8 vCPU、15224 MiB 内存、无 swap，节点版本 `node-v0.1.0-alpha.8`、引擎 `0.38.1`。下列每档重复两次，均使用每组两次 3 秒模拟模型等待；耗时为 `profileP95Seconds` 的两轮均值，包含会话创建与业务操作，不包含会话关闭。单 profile 下该指标就是该 profile 的业务耗时。

| 同时运行 profile 数 | 每个 profile 总组数 | 分组并发 | profile 业务耗时 | 整机平均 CPU | 最低可用内存 |
| ------------------- | ------------------- | -------- | ---------------- | ------------ | ------------ |
| 1                   | 5                   | 2        | 20.74 秒         | 3.93%        | 13886 MiB    |
| 1                   | 5                   | 5        | 8.44 秒          | 8.96%        | 13880 MiB    |
| 1                   | 8                   | 4        | 15.62 秒         | 7.28%        | 13810 MiB    |
| 1                   | 8                   | 8        | 9.30 秒          | 10.74%       | 13791 MiB    |
| 12                  | 8                   | 8        | P95 19.63 秒     | 87.66%       | 9005 MiB     |

这组夹具支持把单任务默认分组并发提高到最多 8：5 组任务耗时缩短约 59%，8 组任务相对并发 4 缩短约 40%。12 个 profile 同时满载时 CPU 已接近瓶颈，命令排队 P95 约 4.7 秒，不应据此继续提高节点容量。真实模型配额、重型页面和远程网络未纳入测量，上述比例不是线上任务加速保证。

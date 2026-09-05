# 任务二 GUI 手动走查留证（codebuddy-live-5）

> 2026-08-31 · 分支 v2.0.x · MemoryProxy :8097 + MemoryCore :8420 + CodeBuddy CN v4.11.2
> 模型 `deepseek-v4-flash` → `proxy-memory-agent` → `http://127.0.0.1:8097/codebuddy/default`
> 走查步骤见本地未入库文档 `docs/codebuddy-gui-walkthrough.md`；本目录为走查截图 + 索引。

## 会话

- **会话 key**：`0e8f2545825c4a73a7afd678c6cb1899`
- **身份**：team-coudtbobez / agt-coudeqdh9q（default-agent-admin）/ task-covxoq8e1r（云主机迁移平台 v1）
- **DB 证据链**（`asset_event`）：`recalled 21 · selected 13 · injected 165 · used 8`
  - selected(decision=**rerank**) 5 条：memory-hub-asset-guide(0.802) → cloud-migration-postmortems(0.728, 可信1.00/效果0.90) → team-coding-standards(0.616) → cloud-migration-tool-guide(0.606) → **migration-expert-tips(0.590, 来源 agt-jyeano3vah=跨 agent)**
  - selected(decision=direct-read) 8 条：get-by-name / scenario-read（模型实际打开）
  - used 8 条：cloud-migration-tool-guide / cloud-migration-batch-planning / cloud-migration-postmortems / memory-hub-asset-guide / team-coding-standards（get-by-name）+ 云主机迁移-一键迁移工具.md（scenario/read）

## 截图索引

| 文件 | 走查步骤 | 内容 | 核验点 |
|---|---|---|---|
| `r2-gui-task2-01.png` | Step 1 | 会话初始化表单「是否关联团队资产」→「是」→ 选择 Agent + 任务 | ✅ 表单触发，身份匹配 |
| `r2-gui-task2-02.png` | Step 1 | 注册后模型自我介绍「已加载团队资产」+ 迁移平台简介（含 ACL bug） | ✅ 注册完成，任务二块进上下文（日志 prewarm hits=5） |
| `r2-gui-task2-03.png` | Step 2 | 迁移复用问题 → 模型深度思考 + `skill-bridge/get-by-name` + `memory-bridge/atomic/search`，生成 checklist 制品 | ✅ 模型真实使用团队资产 |
| `r2-gui-task2-04.png` | Step 2 | 迁移检查清单结果：停机窗口评估 / VSS 快照 / **反模式（来源 postmortems v2）「ACL 校验在快照前执行…直接命中刚发现的 bug」** | ✅ 模型引用推荐资产并关联当前问题 |
| `r2-gui-task2-05.png` | Step 3 | `mem:receipt`：应用资产 23项 · 证据链 召回21/选中13/注入165/使用8 · 有效性 复用2/待验证5/参考16 · 会话信号 3轮/bridge15次 | ✅ 与 DB 一致 |
| `r2-gui-task2-06.png` | Step 3 | 回执续：cloud-migration-tool-guide（召回→选中→注入→使用）；**migration-expert-tips 来源 agt-jyeano3vah**（跨 agent，已选中待采用）；云主机迁移-一键迁移工具.md（选中→使用） | ✅ 跨 agent 来源标注 + 阶段链完整 |
| `r2-gui-task2-07.png` | Step 4 | Panel「Asset Receipts」页，会话 `0e8f2545825c..c6cb1899 · 207事件` 选中 | ✅ Panel 可视化回执页 |

## 说明 / 边界

- **推荐→使用闭环**：模型用 `skill-bridge/get-by-name` 打开了任务二推荐的多项资产，并把 postmortems 反模式直接关联到当前 ACL bug——任务二价值在真实 GUI 成立。
- **低置信口径已统一（P1 收尾 2026-09-01）**：走查当时 risk.ts 用**原始 core score**（-bm25≈0 < 0.5）判低置信、任务二重排用**归一化加权总分**（0.590 ≥ 阈值）选中，两个口径并存。P1 已改为 **risk.ts 优先用六维归一化加权分**（selected `evidence.rerank.weightedScore`），同会话数据重渲回执不再标低置信——「低置信 + 已推荐」矛盾消除。此条目保留作为口径统一的复盘记录。
- injected=165 为每轮 session_init 缓存块命中重打（既有行为，多次轮次累加）。
- 本机无迁移工具代码仓库，走查用「迁移复用」问题（见本地未入库文档 docs/codebuddy-gui-walkthrough.md Step 2 说明）。

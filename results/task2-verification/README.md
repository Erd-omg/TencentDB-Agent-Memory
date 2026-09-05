# 任务二「面向新任务的检索与最小上下文」验证留证

2026-08-31 · 分支 v2.0.x · MemoryProxy :8097 + MemoryCore :8420 + CodeBuddy CLI

## GUI 手动走查（真实 CodeBuddy CN，会话 `0e8f2545825c4a73a7afd678c6cb1899`）

任务：云主机迁移平台 v1（team-coudtbobez / agt-coudeqdh9q / task-covxoq8e1r）。走查步骤见本地未入库文档 `docs/codebuddy-gui-walkthrough.md`。

**证据链（DB `asset_event`）**：`recalled 21 · selected 13 · injected 165 · used 8`。

- **任务二六维重排 selected(decision=rerank) 5 条**（与 e2e 一致）：
  memory-hub-asset-guide(w=0.802) → cloud-migration-postmortems(0.728, 可信1.00/历史效果0.90=真实 validated 数据) → team-coding-standards(0.616) → cloud-migration-tool-guide(0.606) → **migration-expert-tips(0.590, 来源 agt-jyeano3vah=跨 agent)**。全部 trim=false。
- **推荐→使用闭环真实发生**：模型用 skill-bridge/get-by-name 打开 cloud-migration-tool-guide / cloud-migration-postmortems / memory-hub-asset-guide、memory-bridge/scenario-read 读「云主机迁移-一键迁移工具.md」→ used=8。
- **selected 语义区分正确**：5 条 rerank(decision="rerank"+六维分) vs 8 条 direct-read(get-by-name/scenario-read)。
- injected=165 为每轮缓存块命中重打（既有行为，多次轮次累加）。**P0/P1 收尾后回执默认按资产去重展示**（`注入 5` 而非 165），`mem:receipt --full` 才显示事件计数。

## e2e 证据（`node scripts/verify-task2-retrieval.mjs`）

会话 `sess-task2-*`（headerAutoSelect 直达 team-coudtbobez / agt-coudeqdh9q / task-covxoq8e1r）。

`results/task2-verification/rerank-table.json` 校准产物（六维加权总分，selectedThreshold=0.55）：

| rank | 资产 | 桶 | 来源 | 加权总分 | 入选 |
|---|---|---|---|---|---|
| 1 | memory-hub-asset-guide | 项目约定 | self | 0.802 | ✓ |
| 2 | cloud-migration-postmortems | 失败经验 | self | 0.728 | ✓ |
| 3 | team-coding-standards | 项目约定 | self | 0.616 | ✓ |
| 4 | cloud-migration-tool-guide | 历史方案 | self | 0.606 | ✓ |
| 5 | migration-expert-tips | 项目约定 | **agt-jyeano3vah** | 0.590 | ✓ |

关键点：
- **跨 agent 推荐**：migration-expert-tips（另一 agent 沉淀）入选且来源标注为 `agt-jyeano3vah` ≠ self → 团队资产可追溯复用。
- **recalled 闭包（P1）**：注入器检索候选落 recalled，e2e 断言 `recalled ⊇ selected ⊇ injected` 子集闭包。
- **历史效果真实数据**：cloud-migration-postmortems 可信度 1.00 / 效果 0.90 —— asset_event 表历史 validated/used 事件跨会话聚合驱动六维重排。
- 任务分类：task-covxoq8e1r 描述"迁移...ACL 兼容问题" → `devops` → 桶优先级 历史方案>失败经验>Skill>项目约定>产品知识>代码知识。
- 证据链：recalled(5) → selected(decision=rerank) 5 条（dims 六维齐 / weightedScore / rank / threshold / trimmedByBudget）→ 全部 kept → injected。
- 注入块缓存在 `proxy_kv`（KvHookCacheRepo，storage=sqlite），键 `ttl/<space>/<user>/<agent>/<session>/inj-hook/task2-selected-assets-injector.json`。

## 单测
`cd MemoryProxy && pnpm vitest run` → **26 文件 / 184 用例全绿**（原 119 + 任务二 52 + P0/P1 5 + ⑦⑨ 8）。
新增：task-router / categorize / budget / query / rerank / task2-injector（+ recalled 闭包 / shouldRefreshCache 决策）/ risk（低置信归一化口径）/ receipt（叙事段 + 去重 + Panel 深链）。

## 后续增强（⑦⑨，2026-09-03）
- **⑦ mid-session 重排**：`shouldRefreshCache` 缓存命中咨询——话题分类漂移 / 超 refreshEveryTurns 轮 → 重跑 execute() 换新块（探针实测 `drift devops→refactor` 生效）。
- **⑨ Panel 深链**：`mem:receipt` 输出 `panel.url/#/evidence?session=<key>`；Panel 证据页 `?session=` 预选（前端已重建）。

## demo 截图
`node scripts/shot-task234-demo.mjs` → `results/task234-demo/panel1-retrieve-trim.png`（面板1 真实口径：相关度=归一化 core score + 六维加权 + 双条件 selected + 真实注入块 mock）、`panel2-evidence-chain.png`（selected 已具备）。

## GUI 走查清单（CodeBuddy CN，CGEvent 驱动，Accessibility 已授）

前置：CodeBuddy 已配 `proxy-memory-agent` → `http://127.0.0.1:8097/codebuddy/default`；`injection.externalGatewayUrl: "http://127.0.0.1:8097"`。

1. 启动 CodeBuddy CN，新建会话（或重启后首次输入）。
2. 粘贴任务（用 `swift /tmp/gui.swift` paste/type，中文需 keyboardSetUnicodeString）：
   「请修复云主机迁移平台里 Windows ACL 校验失败的 bug：校验当前在快照前执行导致校验失效。」→ 回车。
3. 等待回复；proxy 日志应出现：
   - `[injection] ✓ Hook "task2-selected-assets-injector" successfully injected 1 block(s) at point "system.suffix" (cacheStrategy=session_init)`
   - `[task2-selected-assets] prewarm task=… query=… hits=N kept=N trimmed=N`
   - `[asset-event] … selected`（DB `asset_event` 表 `decision=rerank`）
4. 截窗口：`screencapture -l <WID> results/task2-verification/r2-gui-task2-input.png` / `-answer.png`。
5. 回执复查：消息里发 `mem:receipt`，确认回执含该会话 selected(decision=rerank) 资产（Panel 证据页 `:8125/#/evidence` 亦可见）。
6. 收尾：`node scripts/verify-task2-retrieval.mjs` 全绿截图留证。

> 注意：GUI 逐字打字需 Accessibility（`AXIsProcessTrusted=true`）；CodeBuddy 窗口在另一 Space 时先 activate；中文用 swift type 而非 osascript keystroke。

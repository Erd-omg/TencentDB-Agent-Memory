# 交付总览 · 面向 AI Coding 的团队资产可感知复用系统（赛题四）

> 状态日期：2026-09-07 ｜ 分支：`v2.0.x`

---

## 1. 这是什么

一套叠加在 **MemoryProxy**（TypeScript 源码代理，CodeBuddy/OpenAI 协议）上的「团队资产感知复用层」：

- 模型写代码时会话中，系统**主动检索**团队沉淀的 Skill / 对话记忆 / 产品知识（wiki），经六维重排后以**紧凑指针块**注入上下文；
- 模型侧打开推荐资产 → `used`；任务收尾 `mem:finalize` 把 **真实 git diff + 真实 `node --test`** 结果写回 → `validated`；
- 全程以 `asset_event` 事件表为**单一事实源**，支撑使用回执、低置信风险提示与人工纠正回流（`mem:correct`）。

一句话亮点：**不只是"推给你"，而是"推给你 + 你真的用了 + 用完有真实测试背书，且把效果回流给下一次推荐"。** 复用维度已覆盖**团队内跨 agent 与跨用户**（同团队共享 skill，见 §5 边界）。

---

## 2. 实现状态矩阵

图例：`✅` 已实现并通过验证；`⚠` 部分/需注意；`◻` 未实现。

| 子系统 | 状态 |
|---|---|
| 任务二：任务分类路由 + 主动检索 + **多源候选池**（team-skill / chat-memory / wiki）+ 六维重排 + 预算裁剪 + 注入指针 + ⑦ mid-session 刷新 | ✅ |
| 任务三：证据事件链（recalled→…→validated→corrected）+ used 归因 + `mem:finalize`（真代码+真测试→validated，**保守归因判据**）+ `mem:validate`（**防伪证三入口**）+ `mem:correct` | ✅ |
| 任务四：`mem:receipt`（两口径）+ 自动收尾回执 + `mem:receipt --json`（`distinct_stage_counts`）+ **mem 命令统一 Markdown 版式** + **Panel 证据页复用共享 AssetCard 组件（asset-domain 收敛，防任务六第三套卡）** + **回执两档**（默认对外平实：类别分组+作用/为什么适用/分风险；`--full` 技术明细：答赛题 5 问——类型/阶段/更新时间/有效性/风险/使用位置/决策证据/证据细节/归因+双计数+链提醒加粗；末尾 `--json` 导出入口） | ✅ |
| 任务二/三：**跨用户复用增益验证（真双用户 e2e）** | ✅ |
| 可信度/历史效果聚合过滤（同 team + 90 天窗口） | ✅ |
| 配置单源（`config.example.yaml` ↔ `config.ts` DEFAULT ↔ demo 常量，脚本校验） | ✅ |
| 任务五（反事实评测）/ 任务六（contributed 闭环） | ◻ |

---

## 3. 验证速览

| 验证 | 命令/位置 | 结果 |
|---|---|---|
| 单元测试 | `cd MemoryProxy && pnpm vitest run` | ✅ **214 passed / 29 files**（2026-09-07） |
| 配置单源 | `node scripts/check-config-drift.mjs` | exit=0 |
| 多源检索 e2e | `node scripts/verify-task2-retrieval.mjs` | ✅（双条件不变式 + wiki 无 used/validated 硬断言） |
| 证据链 e2e | `node scripts/verify-task3-evidence.mjs` | ✅（`validated ⊆ used∪selected` 防伪证） |
| **真仓库+真测试 E2E** | `node scripts/verify-task4-realfix.mjs` | ✅ 红→绿 |
| **跨用户复用 e2e** | `node scripts/verify-cross-user-reuse.mjs` | ✅ |


---

## 4. 运行环境

| 组件 | 端口/位置 | 备注 |
|---|---|---|
| MemoryProxy | `:8097` | 本地跑通用 `config.yaml`；参考配置见 `config.example.yaml` |
| MemoryCore | `:8420`（docker） | 检索/BM25（当前非 RRF） |
| MemoryKnowledge | `:8421` | wiki 产品知识，多源候选的 wiki 源 |
| Panel | Web 前端 | EvidencePage 证据页 |
| 夹具仓库 | 本地独立 git 仓库（工程外，位置由 `finalize.taskRepos` 指定） | bug 基线仓库，`mem:finalize` E2E 用（不随本仓库提交） |
| 事件库 | 本地 sqlite `asset_event` 表 | 证据链单一事实源 |

---

## 5. 边界概要与诚实清单

- **复用维度**：团队内跨 agent + 跨用户（同团队共享 skill，真双用户 e2e 已验证）；边界 = 个人记忆（chat-memory/profile）不参与跨用户复用；不把他人 validated 展示为本人已验证。
- **证据强度**：finalize 归因是启发式非因果（已加保守判据防"大 diff 摊分"）；wiki 源 proxy 无回看 → wiki 证据链停在 recalled/selected/injected、永不落 used/validated；`validated` 须确实 used（防伪证）。
- **事件语义**：事件计数 vs 按资产去重是两口径（回执/Panel 用去重；`--json` 顶层 `distinct_stage_counts` 为去重口径）；`corrected` 只降效果分、不参与归因；回执不展示 Panel 深链（CodeBuddy webview 打不开外链）。
- **未覆盖**：任务五（反事实评测）、任务六（contributed 闭环）未实现。

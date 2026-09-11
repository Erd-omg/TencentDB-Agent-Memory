# 交付总览 · 面向 AI Coding 的团队资产可感知复用系统（赛题四）

> 状态日期：2026-09-10 ｜ 分支：`feat/memory-reuse-finalize-receipt`

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
| 任务一：历史经验学习 —— 自建 `demo-corpus`（12 会话/10 文档/7 产品知识/3 代码引用）+ manifest 七项元数据基线 + ground-truth 候选标注（7 条人工 approve/reject）+ `validate-corpus`/`inventory-corpus` 校验盘点（26 条预期资产、六桶分布、candidate 覆盖 12/12）+ 复用 `asset-import.ts` 导入 + **实际落库 e2e（recall 上限 94.4%，skill 0→13，根因 `--target` 用法修正）+ `resolveSkillAgentId` 语义锁定** | ✅ |
| 任务二：任务分类路由 + 主动检索 + **多源候选池**（team-skill / chat-memory / wiki）+ 六维重排 + 预算裁剪 + 注入指针 + ⑦ mid-session 刷新 | ✅ |
| 任务三：证据事件链（recalled→…→validated→corrected）+ used 归因 + `mem:finalize`（真代码+真测试→validated，**diff 基准防御链** `diffBase`→HEAD→HEAD~1 兜底会话中途已提交 + **保守归因判据**，归因 token 集=name+正文/摘要）+ `mem:validate`（**防伪证三入口**）+ `mem:correct` | ✅ |
| 任务四：`mem:receipt`（两口径）+ 自动收尾回执 + `--json`（`distinct_stage_counts`）+ **mem 命令统一 Markdown 版式** + **Panel 证据页共享 AssetCard（asset-domain 收敛）** + 风险文案 **messageKey i18n**（消除中英混排）+ **长文自然断点折叠/展开** + **回执 Markdown 导出**（`.md` 下载） | ✅ |
| 任务二/三：**跨用户复用增益验证（真双用户 e2e）** | ✅ |
| 可信度/历史效果聚合过滤（同 team + 90 天窗口） | ✅ |
| 配置单源（`config.example.yaml` ↔ `config.ts` DEFAULT ↔ demo 常量，脚本校验）+ **retrieval 配置 fail-fast 校验**（六维权重和=1、各维∈[0,1]、阈值/正数参数）+ **token 估算分语言档**（CJK 1 字/token、拉丁/代码 4 字符/token，替代 len/3 对英文高估） | ✅ |
| 任务五：`contributed` 证据链终点写入（finalize exit0 + 保守归因通过 → validated 同批追加 contributed）+ 主对照①（用 vs 不用团队资产）on/off 复跑脚本与 A/B/C/D 报告 + **净收益讨论（18.9 倍成本性质）** + **B3 空心命中诚实标注** + **次对照②版本机制验证（`get(version=N)` 回滚读历史版本）** | ✅ |
| 任务五/二消费闭环：`contributed` 纳入 rerank 历史效果/可信度（不再死数据）+ 回执效果状态升级「已验证且本次贡献」 | ✅ |
| 任务六：候选资产生成器（`evidence/propose.ts`，零 LLM）+ `mem:propose` / `mem:review {list,show,apply,reject,supersede}` 审核 CLI + finalize 回流钩子 + 候选门控（`include_candidates=false`） | ✅ |
| 任务六：提案（proposal）机制（§8.5）—— `mem:proposal {create,list}` + `review apply` 联动目标资产原子变更（deprecate/downgrade/revise） | ✅ |

---

## 3. 验证速览

| 验证 | 命令/位置 | 结果 |
|---|---|---|
| 单元测试 | `cd MemoryProxy && pnpm vitest run` | ✅ **270 passed / 34 files**（2026-09-12） |
| 配置单源 | `node scripts/check-config-drift.mjs` | exit=0 |
| 语料校验 | `node scripts/validate-corpus.mjs` | exit=0（session jsonl 配对锚点 + 文档非空） |
| 语料盘点 | `node scripts/inventory-corpus.mjs` | ✅（`results/corpus-inventory.json`：26 条预期资产、六桶分布、七项元数据齐备、candidate 12/12） |
| **任务一实际落库 e2e** | `node scripts/asset-import-e2e.mjs` | ✅（`results/task1-e2e/report.json`：recall 上限 0.944，skill 0→13 落库） |
| **resolveSkillAgentId 语义锁定** | `node scripts/verify-resolve-skill-agent-id.mjs` | exit=0（`--target agent` 绑定 agent、`--target team` 兜底 userId） |
| 多源检索 e2e | `node scripts/verify-task2-retrieval.mjs` | ✅（双条件不变式 + wiki 无 used/validated 硬断言） |
| 证据链 e2e | `node scripts/verify-task3-evidence.mjs` | ✅（`validated ⊆ used∪selected` 防伪证） |
| **真仓库+真测试 E2E** | `node scripts/verify-task4-realfix.mjs` | ✅ 红→绿 |
| **跨用户复用 e2e** | `node scripts/verify-cross-user-reuse.mjs` | ✅ |
| **任务五 on/off 对照** | `node scripts/task5-compare.mjs --mode on/off` + `node scripts/task5-compare-report.mjs` | ✅（`results/task5-compare/report.md`：on 3/3 vs off 0/3） |
| **任务五版本对照（次对照②）** | `node scripts/task5-version-compare.mjs` | ✅（`results/task5-compare/version/version-compare.json`：`v_head_vs_v1_differ: true`） |
| **任务六候选生成/审核单测** | `propose.test.ts` 等（`pnpm vitest run`） | ✅ |


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
- **证据强度**：finalize 归因是启发式非因果（已加保守判据防"大 diff 摊分"）；归因 token 集=资产 name+正文/摘要（非命名文本资产不再因无 tag 被低估）；wiki 源 proxy 无回看 → wiki 证据链停在 recalled/selected/injected、永不落 used/validated；`validated` 须确实 used（防伪证）。
- **finalize diff 基准**：默认 `git diff` 对比提交点取 `diffBase`（缺省 HEAD）→ 兜底 HEAD~1，解决会话中途已提交导致 diff 为空；`--base`/`taskRepos.diffBase` 可显式指定；坏 ref/非法 base 拒绝并报错，避免静默空 diff 误判「无变更」。
- **事件语义**：事件计数 vs 按资产去重是两口径（回执/Panel 用去重；`--json` 顶层 `distinct_stage_counts` 为去重口径）；`corrected` 只降效果分、不参与归因；回执不展示 Panel 深链（CodeBuddy webview 打不开外链）。
- **任务五边界**：主对照①（on/off）已落地；次对照②（版本对照）**已完成「版本机制验证」**（`get(version=N)` 可回滚读历史版本、v_head vs v_1 内容不同），但「注入 v_head vs v_1 跑同一任务的完整 agentic 对照」仍留后续（复用 `task5-compare.mjs` 循环，需 FIX_REPO 夹具 + LLM）；对照③④⑤ 为开放项。实验小样本、仅趋势呈现、不做显著性声明；成本对比（on 组 token ≈ off 组 18.9 倍）的净收益讨论见 `results/task5-compare/report.md` §D.1。B3 为「方向对但未落 used」的空心命中，不纳入证据链闭合叙事（报告 §B 已单独标注）。
- **任务六边界**：候选生成/审核走 proxy 侧规则生成器（零 LLM）+ `mem:review apply` 直接 `skill/create`。提案（proposal）机制已落地（`mem:proposal` 命令族）；`proposed/reviewed/published` 独立回流事件仍留后续。
- **任务一边界**：`inventory-corpus` 的 26 条是「**预期抽取基线**」（manifest `expected_assets` 人工标注）；`asset-import-e2e.mjs` 已把语料真实导入隔离 team/agent 并逐条核对，**recall 上限 94.4%**（36 预期/34 命中/2 未覆盖，2 条为 sess-mig-009 的 Windows VSS/ACL，根因待分析）。语义核对用「关键词交集」启发式，故措辞用「recall 上限」而非精确 recall。

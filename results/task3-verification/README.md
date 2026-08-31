# 任务三 F1–F4 · 资产使用链路记录与可信归因 —— 端到端实测

> 2026-08-27 首跑 · 分支 v2.0.x · 本地 MemoryProxy(:8097) + MemoryCore(:8420) + CodeBuddy 接入
> 在 8-26 基线（injected/used/validated + asset_event 表 + mem:receipt/validate）之上，实测 F1–F4 改动。
> **2026-08-28 重跑刷新 `evidence-chain.txt`**（二轮"证据锚定"修复后）：`[4]` 不再过早触发自动回执
> （`自动回执=未触发`），改为有 used/selected 证据后连续 2 轮无工具才触发；单测 18 文件 / 113 用例全绿。

## 验证目标

确认 F1–F4 在真实链路语义正确、证据链闭环、回执展示准确：

- **F1** `recalled`/`selected` 阶段：search 命中→recalled（只是候选）；定向读取（get-by-name/files/read）→selected；memory `atomic/search` 从 used 降级为 recalled。
- **F2** used 收紧：search 不再宣称"使用"；`UsedEventSource` 增 decision/code_diff/outcome → evidence（资产→决策→结果 归因）。
- **F3** `mem:correct`：用户主动纠正→corrected(source=user)，只允许纠正已进入证据链的资产。
- **F4** 证据链完整性校验：validated 无 used→🔴 error；used 缺前置→🟡 warning；回执状态降级 + ⚠️ 提醒。

## 复现

```bash
node scripts/verify-task3-evidence.mjs   # 全链路实测（断言失败 exit≠0）
cd MemoryProxy && pnpm vitest run        # 单测：18 文件 / 113 用例
```

## 结果（evidence-chain.txt，exit=0 全断言通过）

| F | 断言 | 结果 |
|---|---|---|
| F1 | `skill/search` → **recalled**（5 skill，不含 used） | ✅ 召回 10（5 skill + 5 memory） |
| F1 | `skill/get-by-name` → **selected + used**（定向读取=使用） | ✅ 选中 1 · 使用 1 |
| F1 | `memory/atomic/search` → **recalled**（非 used） | ✅ 5 条 recalled |
| F2 | search 命中不宣称 used（used-from-search=0） | ✅ |
| F2 | used 事件 evidence 带 tool_call（bridge/endpoint/query） | ✅ |
| F3 | `mem:correct skl-…` → corrected(source=user, 附原因) | ✅ |
| F3 | `mem:correct skl-nonexistent` → 前置拦截（防凭空纠正） | ✅ |
| F4 | 回执含 ⚠️ 证据链完整性提醒（🔴 validated-无-used） | ✅ |
| F4 | validated-无-used 资产状态降级 ⚠️ 已标记验证（缺使用证据） | ✅ |
| F4 | cloud-migration-tool-guide 走完 `召回→选中→注入→使用→已验证` ✅ | ✅ |

### 回执最终形态（节选）

```
应用资产：11 项（Skill 5 · Profile 1 · Chat-Memory 5）
证据链计数：召回 10 · 选中 1 · 注入 10 · 使用 1 · 已验证 5 · 已纠正 1

■ Skill · cloud-migration-tool-guide v1 · 来源 self
  阶段：召回 → 选中 → 注入 → 使用 → 已验证     ← 完整链（被真实使用后才 ✅）
  状态：✅ 已验证
  最新证据：[command] exit=0 PASS skl-6Xgq7P22VjxO.md: frontmatter + 27 lines of body

■ Skill · memory-hub-asset-guide v1 · 来源 self
  阶段：召回 → 注入 → 已验证                  ← 缺 used → 过度归因被 F4 抓出
  状态：⚠️ 已标记验证（缺使用证据）
  最新证据：[command] exit=0 PASS skl-8yYETDkrSndn.md: …

■ Skill · migration-expert-tips v1 · 来源 team   ← 跨 agent 检索 + 用户纠正
  阶段：召回 → 已验证 → 已纠正
  状态：❌ 需修正

■ Chat-Memory · … · 来源 agt-coudeqdh9q
  阶段：召回                                 ← memory 召回=候选，不宣称使用
  状态：—
  最新证据：memory-bridge/atomic/search · query="迁移 踩坑 快照 VSS"

⚠️ 证据链完整性提醒：
  🔴 [error] 资产 skl-… 标记为「已验证」但没有 used 事件——仅注入/召回不能支撑「验证有效」…
```

## 实测中发现并修正的问题

1. **验证脚本 get-by-name 字段错误**：`<skill_tools>` 配方用 `{"skill_name": …}`，脚本误发 `{"name": …}` → core 拒收（HTTP 200 信封 + code≠0）→ selected/used 事件缺失。改对字段后 `召回→选中→注入→使用→已验证` 完整链路出现。**这是脚本 bug，非 F1–F4 代码问题**。
2. **DB 断言漏选 `asset_type` 列**：`queryEvents` SELECT 缺 `asset_type` → memory recalled 断言恒 0。补列后通过。

## 证据链与代码落点（F1–F4 增量）

| F | 实现 | 文件 |
|---|---|---|
| F1 | `emitRecalledEvents` / `emitSelectedEvents`；skill-bridge 三集合分派（`SUBPATH_RECALLS/SELECTS/USES_ASSET`）；memory-bridge search→recalled | `src/evidence/used-evidence.ts`、`src/skill/skill-bridge.ts`、`src/memory/memory-bridge.ts` |
| F2 | `UsedEventSource` 增 decision/code_diff/outcome → evidence；`AssetEventEvidence` 增 outcome；`SUBPATH_USES_ASSET` 移除 search | `src/evidence/used-evidence.ts`、`src/db/asset-event.ts`、`src/skill/skill-bridge.ts` |
| F3 | `mem:correct <assetId> [原因]`，前置校验 + evidence.source=user | `src/mem-command/commands/correct.ts`、`index.ts`、`parser.ts`、`types.ts`、`help.ts` |
| F4 | `validateChain`/`validateChains`（纯函数）；回执追加 ⚠️ 提醒 + effectStatus 降级 | `src/evidence/chain-validator.ts`、`src/mem-command/commands/receipt.ts` |

## 诚实边界

- F2 的 `decision/code_diff/outcome` 接口与 emit 已就位，但 **bridge 打点当前只填 tool_call**（decision/outcome 未从任何源传入）——归因字段留待决策/diff 钩子接入。
- memory 定向读取（`atomic/query` / `scenario/read`）**已于 2026-08-28 补上 selected+used**（D1，见 docs §15.4 与上表 [5c]）；本条旧边界已不成立。
- `contributed`（任务五/六）未实现。

---

# 任务四深化（2026-08-27）—— 有效性判定 · 风险 · 决策归因 · 自动收尾

## 新增能力

| 模块 | 内容 | 文件 |
|---|---|---|
| **A 有效性判定** | 行为信号（used 复用数/跨 turn）× 结果信号（validated/corrected）交叉 → `✅已通过测试验证 / 🔄已被复用 / ⏳已采用待验证 / 💤仅背景参考 / ❌需修正 / ⚠️已标记验证(缺使用证据)` | `src/evidence/effectiveness.ts` |
| **D 风险维度** | 低置信(score<0.5) / 可能过期(corrected后仍用) / 多来源 | `src/evidence/risk.ts` |
| **C 决策归因** | 回执展示「决策证据=工具调用」；diff/outcome 诚实标注不可得 | `receipt.ts` |
| **B 自动收尾** | 连续 2 轮无 tool_calls → 自动追加简短回执（每会话一次） | `src/evidence/task-completion.ts`、`receipt-summary.ts`、`handler.ts` |
| **CH 结果信号** | 本地 docker ClickHouse（需设 CLICKHOUSE_USER/PASSWORD）；proxy 幂等建表 | `config.yaml` clickhouse 段 |

## 回执新增展示（纯文本合并）

```
应用资产：11 项（Skill 5 · Profile 1 · Chat-Memory 5）
证据链计数：召回 10 · 选中 1 · 注入 10 · 使用 1 · 已验证 5 · 已纠正 1
有效性：已验证 1 · 复用 0 · 待验证 0 · 参考 9 · 需修正 1

■ Skill · cloud-migration-tool-guide v1 · 来源 self
  阶段：召回 → 选中 → 注入 → 使用 → 已验证
  有效性：✅ 已通过测试验证
  风险：[medium] 低置信（召回相关度最低 0.00（< 0.5））；[low] 多来源（来自 self / team）
  决策证据：工具调用 skill-bridge/get-by-name
  最新证据：[command] exit=0 PASS skl-6Xgq7P22VjxO.md: frontmatter + 27 lines of body

■ Skill · migration-expert-tips v1 · 来源 team
  阶段：召回 → 已验证 → 已纠正
  有效性：❌ 需修正
```

## 自动收尾回执（B 实测）

```
📋 资产使用回执（自动）
本次应用资产 7 项 · 有效性：已验证 0 / 复用 0 / 待验证 1 / 参考 6
关键采用：cloud-migration-tool-guide
（输入 `mem:receipt` 查看完整回执）
```

- 触发：注册轮 + 下一轮无工具调用 = 连续 2 轮 → 自动追加（proxy 日志 `[auto-receipt] TRIGGER`）。
- ✅ 流式路径已接入（2026-08-27）：`createUsageTapTransform` 在 SSE `data: [DONE]` **之前**插入回执块（`doneHeld`），经 `scripts/probe-auto-receipt.mjs` + 真实 CodeBuddy GUI 走查（results/codebuddy-live-3/）双重验证。


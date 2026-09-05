# 真实 CodeBuddy CN GUI 会话验证 · 任务三/四新功能全量走查（codebuddy-live-3）

> 时间：2026-08-27 19:00–19:35 · 客户端 **CodeBuddy CN v4.11.2**（Electron）
> 会话 `752c16e0a1ec4d419e8c9ec6ab068f24` · 模型 `proxy-memory-agent` → `http://127.0.0.1:8097/codebuddy/default`（源码 proxy :8097 → docker core :8420）
> 用户 `usr-coud7corvg` · agent `agt-coudeqdh9q`（default-agent-admin）· team `team-coudtbobez`
> 结论：**任务三（asset_event 证据链 recalled/selected/injected/used/validated/corrected + mem:receipt/validate/correct）与任务四（有效性 A / 风险 D / 决策归因 C / 自动回执 B / CH 会话信号）在真实 GUI 全链路验证通过。**

## 验证矩阵（每项新功能 → 自动化 + GUI 证据位置）

| 新功能 | 单测 | e2e（verify-task3-evidence） | GUI 走查 | DB/日志证据 |
|---|---|---|---|---|
| asset_event 表 + stage 聚合 | `assetEventRepo`/`evidence-chain` ✅ | [5b] 直查 DB ✅ | — | `evidence-db.jsonl`（98 事件） |
| injected（三注入器打标） | `evidenceObserver` ✅ | [5b] ✅ | Step 2 | injected=66（多轮 6 资产/轮） |
| recalled（F1） | `recall-select` ✅ | [5b] ✅ | Step 3 `skill_search` | recalled=17（含跨 agent migration-expert-tips） |
| selected（F1） | `recall-select` ✅ | [5b] ✅ | Step 3 `skill_view` | selected=4 |
| used 收紧（F2） | `usedEvidence`/`used-narrow` ✅ | [5b] ✅ | Step 3 | used=4（全为 get-by-name，search 不宣称 used） |
| validated（真实命令） | `validation` ✅ | [7] ✅ | Step 5 `mem:validate` | validated=6（evidence 带 test_result 命令） |
| corrected + 防凭空（F3） | `correct-command` ✅ | [7] ✅ | Step 6 | corrected=1（source=user）；skl-nonexistent 拦截 0 事件 |
| 有效性 A（交叉判定） | `effectiveness`（7 状态）✅ | [11] ✅ | Step 4/8 回执 | 已验证3 · 参考6 · 需修正1 |
| 风险 D（低置信/过期/多来源） | `risk` ✅ | [11] ✅ | Step 8 回执 | memory-hub-asset-guide `[high] 可能过期`（corrected 后仍 used） |
| 决策归因 C（tool_call 为据） | `receipt` ✅ | [11] ✅ | Step 4 回执 | used evidence 全带 `tool_call: skill-bridge/get-by-name` |
| 自动回执 B | `taskCompletion` ✅ | [12] ✅ | Step 7 | GUI 应答末尾出现「📋 资产使用回执（自动）」 |
| CH 会话信号 | `sessionSignals` ✅ | [11] 回执行 ✅ | Step 4 回执 | 「会话信号：7轮 · bridge 调用9次 · 均耗6ms · token 484836」 |
| 流式回执（SSE [DONE] 前插入） | — | `probe-auto-receipt.mjs` ✅ | Step 7（GUI 流式渲染） | 回执块在 [DONE] 前 |

## 走查记录（Step 1–8 逐环）

### Step 1 · 会话初始化表单 → 注册
- 首条消息触发表单「是否关联团队资产」→「是」→ auto-select 注册。
- 日志：`[session-init:cb] → pending_asset_confirm (teams=1) → initialized agent=agt-coudeqdh9q task=default team=team-coudtbobez user=usr-coud7corvg`。
- 注：`participation-log append failed … task_not_found: default` —— 任务「default」在 core 无记录，仅影响参与度遥测，不影响注入/证据链（非阻断）。

### Step 2 · 注入证据（injected）
- 注入 3 块（skill-tools 配方 / skill 列表 / tdai-memory 工具 + L3 画像），`injectedSkipped=false`。
- DB：injected=66（每轮 5 skill + 1 profile，缓存命中轮也记录）。

### Step 3 · 召回/选中/使用（recalled/selected/used）
- 模型自发 `curl /skill-bridge/v3/skill/search`（见 `03-skill-usage.png`）→ 日志 `[skill-bridge] team search whitelist A=5 B=5 merged=6` → **recalled**（含跨 agent migration-expert-tips `skl-G0TjSpjWyJFE`）。
- 模型连续 `skill_view`（get-by-name）打开 4 个 skill 全文 → **selected + used**（cloud-migration-tool-guide / batch-planning / postmortems / memory-hub-asset-guide）。
- used 事件 evidence 均为 `{"tool_call":{"bridge":"skill-bridge","endpoint":"get-by-name","httpStatus":200}}`。

### Step 4 · mem:receipt（A/D/C + CH 汇聚）
- 展示：应用资产 12 项（Skill 6 · Profile 1 · Chat-Memory 5）、证据链计数、有效性、风险、决策证据（工具调用 skill-bridge/get-by-name）、**会话信号行**（CH 聚合）。

### Step 5 · mem:validate（validated，真实命令）
- 6 个 skill 全部校验：`test_result.command = node …/scripts/validators/validate-skill-format.mjs --file <tmp>`（真实 spawn，exit 0 → validated）。
- 含跨 agent migration-expert-tips（数据面 get 可读 → 校验通过，符合隔离模型：LLM 工具面隔离、数据面 team 可读）。

### Step 6 · mem:correct（corrected + 防凭空）
- `mem:correct skl-8yYETDkrSndn 内容有误需修订` → corrected 事件 `{"source":"user","decision":"内容有误需修订"}`。
- `mem:correct skl-nonexistent` → 前置拦截（success=false），0 事件落库（防凭空纠正）。

### Step 7 · 自动回执（B）
- 模型对普通消息过度调用工具（skill_view/conversation_search）导致 streak 难达 2 —— **行为特性，非缺陷**（机制由 e2e/probe 验证）。
- 用 2 条明确「无需检索」消息后 streak=2 → 应答末尾自动追加：
  `📋 资产使用回执（自动）本次应用资产12项 · 有效性：已验证3/复用0/待验证0/参考6/需修正1 · 关键采用：cloud-migration-tool-guide、memory-hub-asset-guide、cloud-migration-batch-planning`（见 `09-auto-receipt.png`）。
- 流式路径（SSE）：回执块插入 `data: [DONE]` 之前，客户端可读（probe 回归通过）。

### Step 8 · 复查 mem:receipt（corrected 后效果/风险变化）
- memory-hub-asset-guide：`validated → corrected → selected → used`（corrected 后仍 used）→ 有效性 **❌ 需修正** + 风险 **`[high] 可能过期`**。
- 3 个 used+validated 的 skill → **✅ 已通过测试验证**；migration-expert-tips（validated 无 used）→ **⚠️ 已标记验证（缺使用证据）**（见 `10-mem-receipt-after-correct.png`）。

## 截图清单

| 文件 | 内容 |
|---|---|
| `03-skill-usage.png` | 模型 `curl /skill-bridge/v3/skill/search` 检索团队 skill（Step 3） |
| `09-auto-receipt.png` | 自动回执块（Step 7，任务四 B） |
| `10-mem-receipt-after-correct.png` | 最终回执：CH 会话信号 + ❌ 需修正 + [high] 可能过期（Step 8） |

## DB 证据（会话 752c16e0a1ec4d419e8c9ec6ab068f24，98 事件）

```
corrected|1
injected|66
recalled|17
selected|4
used|4
validated|6
```
（contributed 未实现 —— 任务五/六，诚实边界。）

导出文件：`evidence-db.jsonl`（逐事件含 evidence_json）、`evidence-stages.txt`、`session-key.txt`。

## 诚实边界

> ⚠️ 本走查为 2026-08-27（round-1 深化）。**2026-08-28 二轮已把「memory 定向读取」推进落地**（见 docs §15.4），以下第 2 条旧边界已不成立，round-2 走查见 `results/archive/gui-legacy/codebuddy-live-4/`。

- **F2** decision/code_diff/outcome 接口就位但 bridge 打点只填 tool_call —— 归因字段待决策/diff 钩子接入。
- ~~memory 定向读取（atomic/query、scenario/read）不落 selected/used（当前仅 search→recalled）~~ → **已落地**（D1，round-2）。
- `contributed` 未实现。
- 跨 agent get-by-name 返回 40401 是预期隔离策略（docs §7.7 口径），本次未触发（模型主要用了自有 skill）。
- 自动回执触发依赖「连续 2 轮无工具调用」；模型过度检索时不易触发 —— 已在 e2e/probe/本走查三处验证机制正确。

## 复现命令

```bash
cd MemoryProxy && pnpm vitest run              # 单测 18 文件 / 113 用例全绿（round-2 起）
node scripts/verify-task3-evidence.mjs         # e2e 19 断言 exit=0
node scripts/probe-auto-receipt.mjs            # 流式自动回执 exit=0
sqlite3 ~/.tdai-memory-proxy/proxy.db \
  "SELECT stage,count(*) FROM asset_event WHERE session_key='<会话>' GROUP BY stage;"
```

## 走查中发现并处理的事项

1. **typecheck 新增错误修复**：`src/config.ts` validation.rules 的 `Object.fromEntries` 推导为 `{ [k: string]: unknown }`，与 `ValidationConfig.rules: Record<string,string>` 不匹配 → 补 `as Record<string, string>`。修复后 typecheck 无新增错误（67 个存量错误均为 HEAD 已有，与任务三/四无关）。
2. **流式自动回执 GUI 验证**：确认 `createUsageTapTransform` 在 SSE `[DONE]` 前插入回执块、客户端可渲染；临时加调试日志定位后已还原（handler.ts 无残留改动）。

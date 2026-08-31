# 真实 CodeBuddy CN GUI 会话验证 · Skill 检索链路（预期隔离口径）

> 时间：2026-08-24 · 客户端 CodeBuddy CN 4.11.1（Electron）· 会话 `76fb5d8d09ca4ab8a43c251329219a18`
> 模型 `proxy-memory-agent` → `http://127.0.0.1:8097/codebuddy/default`（源码 proxy :8097 → docker core :8420）
> 结论口径：**跨 agent 团队 skill 只可感知（检索摘要），全文隔离（get-by-name 40401），完整复用走 fork —— 这是预期隔离策略，不做代码修复。**

## 链路证据（逐环）

### ① 会话初始化表单 → 注册
- `01-session-init-form-window.png`：真实 GUI 的 session-init 表单（「本次对话是否要关联团队资产？」→「是，关联团队资产」→「选择 Agent 与任务」）。
- 日志：`[session-init:cb] → pending_asset_confirm (teams=1)` → `only-team=team-coudtbobez → pending_agent_task` → `initialized agent=agt-coudeqdh9q task=task-covxoq8e1r team=team-coudtbobez user=usr-coud7corvg`。

### ①.5 截图清单（`results/codebuddy-live-2/`）
| 帧 | 内容 |
|---|---|
| `01-session-init-form-window.png` | 会话初始化表单（关联团队资产 + 选择 Agent/任务） |
| `03-skill-search-getbyname-window.png` | 模型发出 get-by-name（针对跨 agent）+ 推理「跨 agent 的 skill 无法用 get-by-name 直接打开——这是限制」 |
| `04-isolation-fallback-window.png` | 两次尝试均失败（get-by-name + files/read）→ 回落打开自有 cloud-migration-postmortems |
| `05-final-answer-window.png` | 最终答复尾部「四、说明 ①：migration-expert-tips 全文读不到（40401）」 |
| `06-final-answer-body-window.png` | 最终答复主体「一、检索结果：skill_search 命中 migration-expert-tips（skl-G0TjSpjWyJFE / owner 迁移专家 agt-jyeano3vah）→ 二、批量迁移功能实现要点」 |
| `07-skill-search-hit-window.png` | 模型 curl skill_search `{"query":"迁移专家 批量迁移 验收 最佳实践"}` → 响应 `{"code":0,"message":"ok"…` |
| `08-getbyname-404-window.png` | 模型明确「get-by-name 报 40401（该 skill 不在当前 agent 命名空间下）」→ 尝试把 skill_id 当 skill_name 再试 |
| `panelshots/skills.png` | 团队资产 tab：迁移专家 · migration-expert-tips · 共享 |
| `panelshots/agents.png` | 2 个 agent（default-agent-admin + 迁移专家 agt-jyeano3vah） |
| `panelshots/workbench.png` `chat-memory*.png` | 工作台 / 记忆视图 |

### ② 注入（available_skills + skill 工具配方）
- 4 个注入器全部命中：`skill-tools-injector`（静态 `<skill_tools>` curl 配方：skill_search → `/skill-bridge/v3/skill/search`、skill_view → `get-by-name`）、`skill-injector`（`<available_skills>` 4 个自有 skill）、`tdai-memory-tools-injector`、`tdai-profile-memory-injector`。

### ③ 模型 skill_search → 命中跨 agent 团队 skill（可感知）
- 日志白名单：`[skill-bridge] team search whitelist A=5 B=4 C=4 merged=1`（×3）—— 团队池子里可见的跨 agent skill 只有一个：`migration-expert-tips`（A 池、不在 C 池）。
- `03-skill-search-getbyname-window.png`：模型发出 `curl /skill-bridge/v3/skill/get-by-name`（针对 migration-expert-tips）并推理：*「skill_search 说明里说：按关键词＋语义检索匹配项（跨 agent，但不含其他人设置为私密的 skill）… 这可能意味着跨 agent 的 skill 无法用 get-by-name 直接打开——这是限制。」*

### ④ 全文隔离（预期隔离策略的核心证据）
- `04-isolation-fallback-window.png`：模型先 `get-by-name`（40401 `SKILL_NOT_FOUND: no skill named "migration-expert-tips" for agent agt-coudeqdh9q`），再试 `files/read` 读 SKILL.md 资源文件 → *「两次尝试均失败」* → **回落打开自己的 `cloud-migration-postmortems`** 补验收清单依据。
- 日志 skill-bridge 调用序列：`search → search → get-by-name → get-by-name → get-by-name → search → get-by-name → … → files/read → get-by-name → search`（跨 agent 的 get-by-name/files-read 均拿不到全文）。

### ⑤ 最终答复（注明隔离 + 依据的自有 skill）
- `05-final-answer-window.png`：答复「四、说明」原文：*「① migration-expert-tips 的全文能否读到？**读不到**。已两次尝试 skill_view（get-by-name），均返回 40401 SKILL_NOT_FOUND: no skill named "migration-expert-tips" for agent agt-coudeqdh9q；尝试用 skill_id 和直接读 …」*，并以自有 skill（tool-guide / postmortems）正文 + 跨 agent 检索 snippet 为依据给出批量迁移实现要点与验收清单。

### ⑥ Panel 资产视图
- `panelshots/skills.png`：团队资产 tab 显示「Agent资产，迁移专家 · 1 条 · migration-expert-tips · 共享」—— 团队池子中唯一的跨 agent team skill。
- `panelshots/agents.png`：2 个 agent（default-agent-admin `agt-coudeqdh9q` + 迁移专家 `agt-jyeano3vah`）。

## 权限模型结论（本会话实测背书）

| 问题 | 结论 |
|---|---|
| 有没有「申请权限」流程？ | **无**。meta 路由无 apply/request/share；`acl/grant` 仅 owner 发起且对 skill 读取路径无效 |
| 团队可见 skill 是否已授权？ | **已授权**。`visibility=team` 即同 team read（permission-checker MEMBER_ACTIONS）；Panel 团队 tab 显示即授权生效 |
| 为何模型读不到跨 agent 全文？ | bridge `get-by-name` 按会话 agent 做 owner 过滤（`skill-bridge.ts:642-650` → `handleGetByName:450-456`）；注入工具只有 get-by-name、无 get-by-id |
| 完整复用他人 skill 的正规路径 | **fork**（复制到自己名下；产品注释 `MemoryPanel/web/src/lib/api/skills.ts:229-237` 明确 fork 而非 acl/grant） |
| 是否修复？ | **不修复** —— 这是预期隔离策略；文档以此口径记录（docs §7.7） |

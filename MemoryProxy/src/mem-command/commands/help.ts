/**
 * mem:help — 返回支持的命令列表及示例
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## 支持的 mem: 命令

| 命令 | 说明 |
|------|------|
| \`mem:session-reset\` | 重置本次会话的团队/Agent/任务绑定，立即弹出重新选择 |
| \`mem:sync\` | 刷新本次会话的全部资产注入（Skill / 记忆 / Knowledge / Task & Agent 描述） |
| \`mem:create-skill [提示词]\` | 把本次对话归档为 Skill，后台异步提取 |
| \`mem:create-task [标题]\` | 从当前会话上下文创建 Task 并绑定到本 session |
| \`mem:update-task [新描述]\` | 更新已绑定 Task 的描述 |
| \`mem:receipt\` | 资产使用回执：本次会话用了哪些资产、走到哪个阶段、效果状态（来自证据链事件表） |
| \`mem:validate [--all|资产id]\` | 真实校验资产（跑校验命令）：默认 used/selected，--all 全量；exit 0 → validated |
| \`mem:correct <资产id> [原因]\` | 用户/评审主动纠正资产：落 corrected 事件（evidence.source=user） |
| \`mem:finalize [--repo <路径>] [--test <命令>]\` | 任务结束 git-diff 关联：抓真实代码 diff + 跑真实测试 → 给相关资产写 validated（真退出码 + change/outcome） |
| \`mem:propose [task_id]\` | 手动触发候选资产生成（任务经验回流）：从会话证据链提炼候选（candidate），待审核 |
| \`mem:review list [--status=…]\` | 列出候选/已批准/已拒绝资产（缺省 candidate） |
| \`mem:review show <资产id>\` | 查看候选资产来源/证据/正文 |
| \`mem:review apply <资产id>\` | 批准候选（candidate → approved，进入权威资产库；skill 类候选落地 skill 域，幂等不重复创建） |
| \`mem:review supersede <旧id> <新id>\` | 旧资产被新版替代（approved → deprecated，消费侧自动过滤） |
| \`mem:review reject <资产id> [原因]\` | 拒绝候选（candidate → failed，保留审计） |
| \`mem:proposal create <资产id> --kind=revise|deprecate|conflict|downgrade [--reason=…]\` | 对既有权威资产发起变更提案（candidate，待审核） |
| \`mem:proposal list [--status=…]\` | 列出提案（apply 时对目标资产执行原子变更） |
| \`mem:help\` | 显示本帮助 |

---

### 🆕 \`mem:receipt\` — 资产使用回执（任务三/四证据链展示）

从 asset_event 证据链表聚合本会话的资产使用事实：应用了哪些资产（类型/来源/版本）、
各自走到证据链哪个阶段（注入→使用→已验证/已纠正）、每项最新证据。**非模型自述，可回溯**。

---

### 🆕 \`mem:validate\` — 资产真实校验（任务三 validated/corrected）

按配置校验命令**真实执行**（真实进程/exit code/输出）：
- **\`mem:validate\`**：校验本会话**已使用/已选中**且未纠正的、有校验规则的全部资产
- **\`mem:validate --all\`**：校验本会话**全部**有规则的资产（除已纠正）
- **\`mem:validate <assetId>\`**：只校验指定资产（如 \`mem:validate skl-xxx\`）

exit 0 → 落 \`validated\` 事件；非 0 → 落 \`corrected\` 事件（资产被证明不通过/不适用）。
已纠正资产默认跳过（纠正已否定该资产，避免"已验证+已纠正"矛盾 + F4 误报）。

---

### ✏️ \`mem:correct\` — 用户主动纠正资产（赛题 F3 corrected 用户反馈路径）

验证器只能靠跑测试判错；但用户/评审**主动发现**资产有错、过期或不适用时，用
\`mem:correct\` 直接落一条 \`corrected\` 事件（\`evidence.source = "user"\`）。

- 只允许纠正**本会话已进入证据链**的资产（recalled/used/validated 过）—— 不能凭空
  纠正一个从没出现过的资产，否则证据链失真。
- 可附原因：\`mem:correct skl-xxx 里面的命令过时了，新版 API 已改名\`

---

### ✏️ \`mem:update-task\` — 更新当前 Task 描述

**用法**
- **无参数**：LLM 对比 "当前 description + 最近对话" 生成新 description
  - 判无实质改动 → 返回 ℹ️ 无需更新（幂等，可安全重试）
  - 判有改动 → 返回预览
- **有参数**：参数直接作为新 description（不调 LLM），返回预览

**确认预览**：
- ✅ \`mem:update-task confirm\` — 确认
- 🚫 \`mem:update-task cancel\` — 取消

**保护规则**：
- 若本 session 未绑 Task → 拦截并提示先执行 \`mem:create-task\`
- 若绑定的 Task 不是你创建的 → 拒绝更新（不支持跨用户改），建议 \`mem:create-task\` 新建一个属于你的

---

### 🔗 \`mem:finalize\` — 任务结束 git-diff 关联（真代码 diff + 真测试 → validated）

在真实 bug-fix 任务收尾运行：对目标仓库抓 **git diff** + 跑**真实测试命令**（真实退出码），
把"本次代码修改通过测试"这一结果按 token 相关度归因到本会话 used/selected 资产，
写 \`validated\` 事件（evidence 带 test_result + code_diff + outcome）—— 补齐
\`asset → change → outcome\`。

- 无参数：按会话 task_id 查 \`config.finalize.taskRepos\` 定位仓库。
- \`mem:finalize --repo <abs路径> --test <命令>\`：显式指定（覆盖映射）。
- \`mem:finalize --base <ref>\`：显式 git diff 基准（如 \`origin/main\`）。缺省走防御链
  \`git diff HEAD\` → 工作区空则兜底 \`git diff HEAD~1 HEAD\`（会话中途已提交也能抓到变更）。
  也可在 \`config.finalize.taskRepos.\<task\>.diffBase\` 配置。
- 诚实边界：无代码变更 / 测试未通过 → 不写 validated（有变更但未过测试不宣称验证有效）。

---

### 示例

\`\`\`
mem:sync
mem:create-skill 重点总结数据库迁移步骤和踩坑
mem:create-task 重构 SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task 补充今天完成的进度与遗留风险
mem:update-task confirm
mem:update-task cancel
mem:receipt
mem:validate
mem:validate skl-xxx
mem:correct skl-xxx 命令过时，需要更新
mem:finalize
mem:finalize --repo /path/to/repo --test "node --test"
mem:propose
mem:review list
mem:review apply cand-xxx
mem:review reject cand-xxx 已过时
mem:proposal create skl-old --kind=deprecate --reason=已被新版替代
mem:proposal list
mem:session-reset
mem:help
\`\`\`

> 标准格式为 \`mem:<command>\`，冒号后不加空格。命令名大小写不敏感。`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}

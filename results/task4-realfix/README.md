# results/task4-realfix —— 真代码仓库 + 真测试端到端（used→validated 硬证据）

> 2026-09-04 · `scripts/verify-task4-realfix.mjs` · exit=0 通过
> 会话 `sess-task4-realfix-*`（session-key.txt 保存本次 key）
> 夹具仓库：`~/Desktop/Agent-Memory/migration-tool-v1`（独立 git，预埋 bug）

## 这组证据回答了评审最可能追问的问题

"recalled/selected/injected 我都看到了，但 **used → validated** 凭什么算"验证有效"？"
—— 之前的 validated 只跑"skill 正文格式校验"（标签），不证明"按资产改的代码真的过了测试"。

本组产物用**真实代码仓库 + 真实测试退出码**闭环：

1. `red-before.txt` —— 夹具仓库 bug 态 `node --test` **exit=1**（2 个回归测试红：
   ACL 应用先于 VSS 快照 / 回滚残留 ACL —— 与 cloud-migration-postmortems 反模式一致）。
2. `evidence-chain.txt` / 回执 —— 会话证据链真实落库：`召回→选中(decision=rerank)→注入→使用(get-by-name)→已验证`。
3. `git-diff.txt` —— 真实修复（按 postmortem 修正顺序：快照先于 ACL）产生的 `git diff HEAD`（1 file +7/-8）。
4. `green-after.txt` —— 修复后 `node --test` **exit=0**（pass 6 / fail 0）。
5. `mem:finalize`（`evidence/finalize.ts` + `mem-command/commands/finalize.ts`，配置
   `config.yaml finalize.taskRepos`）：
   - 抓真实 git diff + 跑仓库真实测试 → `validated` 事件 **test_result.exitCode=0**（非标签）；
   - token 相关度把验证归到**本会话确实 used** 的资产（`cloud-migration-tool-guide`、
     `cloud-migration-postmortems`；只 selected 未 used 的 migration-expert-tips **不判**，
     避免 F4「validated 无 used」）；证据带 `code_diff`(diff 摘要) + `outcome` —— 补齐
     `asset → change → outcome`。
6. `receipt.txt` —— `mem:receipt` 展示：`✅ 已通过测试验证 · [node --test] exit=0 · 结果: … · diff: …`。

## 复跑

```bash
node scripts/verify-task4-realfix.mjs     # 需 :8097 proxy（含 mem:finalize）+ :8420 core + 夹具仓库
cd MemoryProxy && pnpm vitest run         # 单测 189（含 finalize.test.ts 5 项）
```

## 诚实边界（写入实现注释/文档）

- 归因是 **token 相关度启发式**，不是因果：只对 used 资产、且与 diff token 共现才判 validated，
  事件里记录 `hits=[…]`；未命中/未使用的留 ⏳待验证。
- 无代码变更（`git diff HEAD` 空）或测试未通过 → **不写 validated**（有变更但未过测试不宣称有效）。
- 本 e2e 里"施加修复"由脚本代表（CodeBuddy GUI 版见走查文档 Step 9）：代码修改产生在本地仓库
  （proxy 看不见模型对本地文件的编辑），任务结束 git-diff 关联正是补这一环。

# 交付总览 · 面向 AI Coding 的团队资产可感知复用系统（赛题四）

> 状态日期：2026-09-05 ｜ 分支：`v2.0.x`

---

## 1. 这是什么（30 秒）

一套叠加在 **MemoryProxy**（TypeScript 源码代理，CodeBuddy/OpenAI 协议）上的「团队资产感知复用层」：

- 模型写代码时会话中，系统**主动检索**团队沉淀的 Skill / 对话记忆 / 产品知识（wiki），经六维重排后以**紧凑指针块**注入上下文；
- 模型侧打开推荐资产 → `used`；任务收尾 `mem:finalize` 把 **真实 git diff + 真实 `node --test`** 结果写回 → `validated`；
- 全程以 `asset_event` 事件表为**单一事实源**，支撑使用回执、低置信风险提示与人工纠正回流（`mem:correct`）。

一句话卖点：**不只是"推给你"，而是"推给你 + 你真的用了 + 用完有真实测试背书，且把效果回流给下一次推荐"。**

---

## 2. 当前实现状态矩阵

图例：`✅` 已实现并通过对应验证；`⚠` 部分/需注意；`◻` 未实现。

| 子系统 | 对应赛题任务 | 状态 | 证据 / 验证 | 关键代码位置 |
|---|---|---|---|---|
| 任务路由 + 主动检索入口 | 任务二 | ✅ | 单测 + GUI | `MemoryProxy/src/retrieval/{types,task-router,categorize,query}.ts` |
| **多源候选池**：team-skill（A∪B 白名单）默认开；chat-memory（L1，self+借调≤2）与 wiki（KS 注册 wiki 正文）显式开 | 任务二 | ✅ | `results/codebuddy-live-6`（多源实跑）；单测 | `retrieval/sources/{chat-memory,wiki}.ts` + `task2-selected-assets-injector.ts` |
| 六维重排 + 入选/预算裁剪（加权分≥阈值 且 rank≤topN，≤800 token 紧凑指针） | 任务二 | ✅ | 单测 + GUI | `retrieval/{rerank,budget}.ts` |
| 注入块 + prewarm 缓存 + ⑦ mid-session 刷新（类别漂移 / 超轮兜底） | 任务二 | ✅ | `results/codebuddy-live-6` | `injection/injectors/task2-selected-assets-injector.ts`、`injection/pipeline.ts` |
| 证据事件链 `asset_event`（recalled→selected→used→validated→corrected）+ byAssetId 聚合 | 任务三 | ✅ | `results/task2-verification`、单测 | `db/asset-event.ts`、`db/assetEventRepo.ts` |
| used 归因（get-by-name / atomic 定向读取 → selected+used；search→recalled 收紧） | 任务三 | ✅ | `results/task3-verification` | `evidence/used-evidence.ts`、`injection/evidence-observer.ts` |
| **`mem:finalize`：真代码仓库 + 真测试 → validated**（git diff 关联、token 归因、validator `task-git-diff-finalize`）；可 `autoOnCompletion` 自动收尾 | 任务三 | ✅ | `results/task4-realfix`（红→绿硬证据） | `evidence/finalize.ts`、`mem-command/commands/finalize.ts` |
| `mem:receipt` 分组回执（✅ 测试通过 / risk 低置信 / 深潜）；自动收尾回执 | 任务四 | ✅ | GUI `codebuddy-live-6` | `mem-command/commands/receipt.ts`、`evidence/receipt-*.ts` |
| Panel 证据页（按资产去重的阶段徽标 + 手动预选） | 任务四 | ✅ | `codebuddy-live-5/6` 截图 | `MemoryPanel/web/src/pages/EvidencePage/` |
| 可信度/历史效果聚合过滤（同 team + 90 天窗口，防他人/过期待验证冒充高可信） | 任务一（元数据维度） | ✅ | 单测 | `config.ts`（`effect` 段）→ 重排 credibility/historicalEffect 输入 |
| `mem:correct` 纠正回流（效果事件拉低，回执警示"已被纠正"） | 任务三 | ✅ | 单测 | `mem-command/commands/correct.ts`、`evidence/risk.ts` |
| 配置单源（`config.example.yaml` ↔ `config.ts` DEFAULT ↔ demo 常量由脚本校验一致） | —（工程化） | ✅ | `scripts/check-config-drift.mjs` exit=0 | `MemoryProxy/config.ts` |
| 反事实评测 / 经验回流 contributed | 任务五 / 任务六 | ◻ | — | — |

**本轮落地要点（已并入上表相关行）**
1. 多源检索候选：候选池 = team-skill + chat-memory + wiki（来源身份透传 `source_tag`，与内容桶正交）。
2. 真代码+真测试端到端：`mem:finalize` 让 `validated` 携带真实退出码/git diff/结论。
3. 历史效果信号闭环：同 team + 90 天窗口聚合影响重排可信度/历史效果维。
4. 配置收敛单源：`retrieval.sources/refresh/effect`、`finalize.taskRepos/autoOnCompletion` 键面。
5. 回执产品口径修正：删除 receipt 中 Panel 深链（2026-09-05）。

**赛题任务对照（速览）**

| 赛题任务 | 对应实现 | 状态 |
|---|---|---|
| 任务一：历史经验学习与资产生成 | Skill/Wiki 资产经 `scripts/install-team-skills.mjs`、`seed-wiki.mjs` 预置（会话→资产自动生成未实现） | ⚠ |
| 任务二：面向新任务的检索与最小上下文 | 路由→多源候选→六维重排→预算裁剪→指针注入→⑦刷新（上表任务二行） | ✅ |
| 任务三：资产使用链路记录与可信归因 | 事件链 + used 归因 + `mem:finalize` 真验证 + `mem:correct` | ✅ |
| 任务四：用户可感知的资产使用回执 | `mem:receipt` + 自动收尾回执 + Panel 证据页（已去深链） | ✅ |
| 任务五：资产效果评测与反事实比较 | 未实现（早期 A/B 度量方法论仅本地归档备查，不入库） | ◻ |
| 任务六：任务经验回流与候选资产生成 | 未实现（`asset_contributed` 未写入；Skill 状态机无 `candidate`） | ◻ |

---

## 3. 验证资产（Evidence of Work）

| 验证 | 命令/位置 | 结果 |
|---|---|---|
| 单元测试 | `cd MemoryProxy && pnpm test` | ✅ **195 passed / 28 files**（2026-09-05 13:02 复跑, 3.04s） |
| 配置单源 | `node scripts/check-config-drift.mjs` | exit=0 |
| 多源检索 e2e | `node scripts/verify-task2-retrieval.mjs` | 产物 `results/task2-verification/` |
| 证据链 e2e | `node scripts/verify-task3-evidence.mjs` | 产物 `results/task3-verification/` |
| **真仓库+真测试 E2E** | `node scripts/verify-task4-realfix.mjs` | `results/task4-realfix/`：`red-before.txt` exit≠0 → `green-after.txt` exit=0；`evidence-chain.txt` 记 `validated_real=2/2`；真 diff + outcome |
| GUI 走查 | 人工步骤与说明见 `results/codebuddy-live-6/README.md` | `results/codebuddy-live-5/`、`codebuddy-live-6/`（2026-09-05，含 ⑦ 刷新、多源实跑与回执无深链） |

评审速览建议：看 §2 矩阵 → 打开 `results/task4-realfix/red-before.txt` → `git-diff.txt` → `green-after.txt`（任务四真证据）→ `receipt.txt` 与 Panel 截图 → 回执。复跑命令见 §7。

---

## 4. 运行环境

| 组件 | 端口/位置 | 备注 |
|---|---|---|
| MemoryProxy | `:8097` | 本地跑通用 `config.yaml`（**含明文 API key，已被 .gitignore 排除，不入库**）；参考配置见 `config.example.yaml` |
| MemoryCore | `:8420`（docker） | 检索/BM25（当前非 RRF） |
| MemoryKnowledge | `:8421` | wiki 产品知识，多源候选的 wiki 源 |
| Panel | Web 前端 | EvidencePage 证据页 |
| 夹具仓库 | 本地独立 git 仓库（工程外，位置由 `finalize.taskRepos` 指定） | bug 基线仓库，`mem:finalize` E2E 用（不随本仓库提交，见 §7） |
| 事件库 | 本地 sqlite `asset_event` 表 | 证据链单一事实源 |


---

## 5. 已知边界（诚实清单）

**复用维度与范围**
- 复用在**团队内、跨 agent** 维度成立；**跨用户**复用未验证（勿超卖）。
- `byAssetId` 聚合经 `effect.sameTeamOnly=true` + `windowDays=90` 过滤；历史遗留空 team 事件按同部署计入（实现说明见 `handover.md` §6）。
- core 检索仍是 BM25（非 RRF）；入选语义 = "归一化加权分 ≥ threshold 且 rank ≤ topN"。

**证据强度**
- finalize 的 token 归因是**启发式**、非因果证明；大 diff/多资产时可能摊到未实际使用的资产。
- wiki 源正文由 agent 直连 KS，proxy 无回看，`used` 不保证。
- `validated` 只对"确实 used 且 diff 与资产相关"的资产写（无 used 前置、diff 不相关 → 不判），防伪证。

**事件语义**
- 事件计数与"按资产去重"是两种口径（回执/Panel 用去重口径，见 §6B 实测数据）。
- `corrected` 只降效果分、不参与归因。

**未覆盖**
- 赛题任务五（反事实评测）、任务六（contributed 闭环）未实现。任务五的最小反事实评测思路（对"检索中推荐 / 存在但未推荐 / 无对应资产"三组作对照）可作后续第一步。

---

## 6. 任务四 E2E 复跑情况

> `mem:finalize` 的"真代码仓库 + 真测试"端到端验证需要一个**预埋 bug 的独立 git 夹具仓库**（bug 基线）。该夹具**不随本仓库提交**（工程外）；本标注说明随仓库即可核验的等效证据，以及需自备环境时的复跑方式。

**已随本仓库提交的等效证据（离线可核验，无需夹具）：**

| 文件 | 内容 |
|---|---|
| `results/task4-realfix/evidence-chain.txt` | 完整事件链，`validated_real=2/2` |
| `results/task4-realfix/red-before.txt` | bug 态 `node --test` exit=1（红，回归测试抓到 bug） |
| `results/task4-realfix/git-diff.txt` | 真实修复 diff（1 file, +7/−8, `src/windows-migration.js`） |
| `results/task4-realfix/green-after.txt` | 修复后 `node --test` exit=0（pass 6 fail 0） |
| `results/task4-realfix/receipt.txt` | 回执含真退出码 / diff / 结果 |
| `scripts/task4-realfix/fixed-src-windows-migration.js` | 夹具"修复后"文件内容（规范实现） |

**若需完整复跑（受控环境）：**
1. 重建夹具 git 仓库到 bug 基线（12 个源文件；重建命令级说明见 `handover.md` §4）。
2. 在 `config.yaml` 的 `finalize.taskRepos` 把该 task 映射到该仓库路径；确保 proxy :8097 + core :8420 在跑。
3. `node scripts/verify-task4-realfix.mjs`（断言全过则 exit=0），结束后 `git -C <夹具仓库> checkout -- .` 复位。

**评审口径建议**：证据文件齐全、**离线可核验**；端到端**可复跑**但需自备上述环境与外部夹具。请按此口径评审，而非"开箱即复跑"。

### 复跑命令

前置：proxy :8097 + core :8420 在跑；`config.yaml` 已开 `finalize` 且 `taskRepos` 含对应 task；夹具 git 仓库已就位（缺失时先按上文重建，见 `handover.md` §4）；本地代理鉴权文件就位。

```bash
cd <本仓库路径>
node scripts/verify-task4-realfix.mjs        # 断言全过则 exit=0；产物写入 results/task4-realfix/
git -C <夹具仓库路径> checkout -- .   # 复位夹具（脚本结束后夹具停留在"已修复"态）
```

> 脚本自身逻辑：Step1 `git checkout -- .` 复位到 bug 基线 → `node --test` 红 → 新会话 prewarm → 打开 tool-guide/postmortems 两资产(used) → 施加 `fixed-src-windows-migration.js` → 真 diff + `node --test` 绿 → `mem:finalize` 写 validated（断言 exit=0 + code_diff + outcome + validator id）→ `mem:receipt` 断言 `exit=0`/`diff:`/`结果:`。任一断言失败脚本 exit≠0。

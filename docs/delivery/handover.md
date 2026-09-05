# 操作速查· 面向评审与后续开发

> 配套：`delivery/README.md`（总览/状态矩阵/边界）。本文件只讲"改哪里、查什么、怎么跑"。

---

## 1. 定位（30 秒）

MemoryProxy 拦截 CodeBuddy/OpenAI 协议的 `/v1/chat/completions`。请求带身份头（`x-team-id`/`x-agent-id`/`x-task-id`）即进入本系统：

```
session_init → 身份/能力校验 → 任务二 prewarm(候选池→六维重排→注入指针块)
   → 模型对话（打开推荐资产→used）→ 收尾 mem:finalize(真测试→validated)
   → mem:receipt 回执 ── 全部写入本地 sqlite（proxy.db）的 asset_event
```

规则引擎全部落在**注入器** `task2-selected-assets-injector.ts`：`execute()` = 一整套主动检索，`shouldRefreshCache()` = 会话中途 ⑦ 刷新判定。

## 2. 改推荐行为：先动哪三个地方

| 想改什么 | 文件 | 备注 |
|---|---|---|
| 候选来源开关/拉取上限 | `MemoryProxy/config.ts`（DEFAULT_CONFIG）→ `config.example.yaml` | **两端必须同步**，靠 `scripts/check-config-drift.mjs` 兜底（改后跑一次） |
| 检索语义 / 每个来源怎么拿候选 | `src/retrieval/sources/{chat-memory,wiki}.ts`；来源采集在 `task2-selected-assets-injector.ts` 的候选池部分 | 来源身份写 `source_tag`；`core-client.ts`（skill）+ `knowledge/core-client.ts`（wiki）为下游客户端 |
| 重排 / 入选 / 预算 | `src/retrieval/{rerank,budget}.ts`（权重、threshold、topN、token 预算） | 重排输入里的 credibility/historicalEffect 来自 `assetEventRepo.byAssetId` 聚合（`effect.sameTeamOnly+windowDays` 过滤） |

其余高频目录：`src/evidence/`（证据语义：used 归因、finalize、risk、receipt、auto-validate）、`src/mem-command/`（mem: 命令：parser/index + `commands/`）、`src/injection/`（pipeline 接入与 observer）。

## 3. 查证据：事件表怎么读

```bash
sqlite3 <proxy.db 路径>   # 默认位置 ~/.tdai-memory-proxy/proxy.db（以 config 为准）
```

```sql
-- 全链（推荐用，含顺序）
SELECT stage, asset_type, asset_name, source_tag, evidence_json, created_at
FROM asset_event WHERE session_key='<sess-xxx>' ORDER BY created_at, rowid;

-- validated 硬证据
SELECT asset_name, evidence_json FROM asset_event
WHERE session_key='<sess-xxx>' AND stage='validated';
```

**两个口径别混**：① 事件条数（一条 used 可能多条）② 回执/Panel 按**资产去重**显示。`validated_real` = 带 `exitCode=0+code_diff+outcome` 的真验证条数。

## 4. 常用命令

```bash
# 服务（各自目录下）
MemoryProxy:  pnpm dev:config          # 读 MemoryProxy/config.yaml
MemoryCore:   见平台文档（本机为 docker, :8420）

# 验证
cd MemoryProxy && pnpm test            # 单测（预期 195，交付前复跑背书）
node scripts/check-config-drift.mjs    # 配置单源, exit=0

# e2e（需 :8097+:8420；task2 另需 KS/种子；task4 另需夹具仓库）
node scripts/verify-task2-retrieval.mjs
node scripts/verify-task3-evidence.mjs
node scripts/verify-task4-realfix.mjs  # 真代码+真测试 红→绿（自动复位夹具到 bug 基线）

# seed / 截图
node scripts/install-team-skills.mjs
node scripts/seed-wiki.mjs             # 需 MemoryKnowledge :8421
node scripts/capture-panel-shots.mjs   # Panel 证据页截图

# GUI 走查：人工步骤与说明见 results/codebuddy-live-6/README.md
```

**夹具仓库**（`mem:finalize` e2e 用，工程外，**不随本仓库提交**）：路径由 `finalize.taskRepos` / 脚本默认值指定，可用环境变量 `FIX_REPO` 覆盖
- bug 基线 commit：`6a6fc9e`；修复版规范实现：`scripts/task4-realfix/fixed-src-windows-migration.js`（e2e 脚本负责施加）。
- **重建**（新机器/CI）：`mkdir` + 从 `6a6fc9e` 检出的 12 个源文件写入 + `git init && git add -A && git commit` 成基线即可（脚本用 `git diff HEAD` 抓变更，等价基线即可）。
- 跑完 e2e 后仓库留在"已修复"态，复位：`git -C <夹具仓库> checkout -- .`
- 对外口径：证据可离线核验（`results/task4-realfix/`），复跑需重建夹具——见 README §7。

## 5. 配置键面速查（权威源 = `config.example.yaml` 内联注释）

`config.example.yaml` 为**唯一权威**（交付参考默认全关）。本地跑通用 `config.yaml`（含明文 key，已 .gitignore，勿外发）。与推荐相关：

- `retrieval.rerank.weights`：六维（relevance .40 / credibility .15 / freshness .10 / 环境兼容 .10 / historicalEffect .15 / token .10，合计 1.0）；`selectedThreshold 0.55` / `topN 5` / `budgetTokens 800` / `candidateTopK 20` / `freshnessHalfLifeDays 30`
- `retrieval.sources`：`teamSkill.enabled(true)`；`chatMemory{enabled:false,perAgentLimit:5}`；`wiki{enabled:false,perWikiLimit:3}`——后两者显式开
- `retrieval.refresh`：`minTurnsBetween 2` / `refreshEveryTurns 8`
- `retrieval.effect`：`sameTeamOnly true` / `windowDays 90`
- `finalize`：`enabled false`（默认）→ e2e/演示置 true；`timeoutMs 60000`；`autoOnCompletion false`；`taskRepos` 按 task id 映射仓库+测试命令
- `memCommand`：`enabled` + `allowedCommands`（[] = 全允许；含 sync/help/create-skill/update-task/correct/**finalize**/…）

## 6. 已知坑（边界全表见 README §6，此处防踩）

1. **不要只改 config.example.yaml 或 config.ts 之一**——跑 check-config-drift。
2. **回执/产物已去 Panel 深链**；`results/task4-realfix` 产物已于 2026-09-05 13:01 刷新到无深链口径（README §6B），别再拿旧产物当现状。
3. byAssetId 聚合未按 team 隔离的实现说明：多 team 共用同库时信号会混（`effect.sameTeamOnly=true` 已按事件 team 过滤，但**历史遗留空 team 行按同部署计**）——改聚合前先读 `effect` 过滤逻辑。
4. core 是 BM25 非 RRF；`selectedThreshold` 语义是"归一化加权总分 ≥ 阈值 且 rank ≤ topN"，调阈值须同时看预算裁剪。
5. finalize 归因是 token 共现启发式：大 diff/多资产时可能"摊"到未实际使用的资产——断言守住了"validated 的资产确实 used"，放宽时留意。
6. 本地 `config.yaml` 明文 key 别 commit；交付只发 `config.example.yaml`。

## 7. 评审/上手 5 分钟核验清单

- [x] `pnpm test` 复跑并回填实得单测数（✅ 195 / 28 files, 2026-09-05）
- [ ] `node scripts/check-config-drift.mjs`
- [ ] 重跑 `verify-task4-realfix.mjs`（先确认/重建夹具，见 §4）并 `git checkout -- .` 复位夹具
- [ ] 打开 `results/codebuddy-live-6/` 与 Panel，按其 `README.md` 走一遍多源检索与⑦刷新
- [ ] 通读 README §2 状态矩阵、§5 边界清单、§7 任务四复跑标注

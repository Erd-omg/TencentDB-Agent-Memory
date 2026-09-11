# 任务五 · 对照实验复跑说明（M4）

> 对照①「用 vs 不用团队资产」是主对照：通过全局开关 `injection.enabled` 切 on/off，
> **进程级隔离**（两次运行分别独立进程，不做运行时热切换），configHash 随跑记录进结果。

## 目录结构

```
scripts/
  task5-compare.mjs        单侧跑分脚本（--mode on|off）
  task5-compare-report.mjs 汇总对照报告脚本（对比 on/off）
  task5-compare/
    reset-fixtures.sh      复位夹具仓库到 3 个 bug 位点的 bug 态
    fixed-src-*.js         3 个位点的修复态（施加后绿测）
    README.md              本文件
results/task5-compare/
  on/round-N/run.json       on 侧机器可读结果
  off/round-N/run.json      off 侧机器可读结果
  report.md                汇总对照报告
  summary.json             机器可读汇总
```

## 前置条件

1. 夹具仓库存在：`~/Desktop/Agent-Memory/migration-tool-v1`（3 个预埋 bug，含 node:test 单测）。
2. MemoryProxy（:8097）+ MemoryCore（:8420）已启动。
3. 团队资产已安装：team-coudtbobez 的 8 个 skill（含 `cloud-migration-postmortems`、
   `migration-expert-tips` 等，见 `scripts/install-team-skills.mjs`）。
4. `deploy/global-images/.admin-key` 存在（脚本读它做鉴权）。

## 3 个 bug 位点

| 位点 | 源文件 | 预埋 bug | 对应资产 skill | 正确修复要点 |
|---|---|---|---|---|
| B1 | `windows-migration.js` | ACL 在 VSS 快照前应用，回滚残留 ACL | `cloud-migration-postmortems` | 先 `captureVssSnapshot` 再 `applyAcl` |
| B2 | `downtime.js` | `estimateDowntime` 缺 20% 安全缓冲 | `migration-expert-tips` | 结果 `base * 1.2` |
| B3 | `resume.js` | `resumeTask` offset 硬编码 0 | `cloud-migration-postmortems` | 从 `task.offset` 读 checkpoint |

## 复跑步骤（on/off 各一轮）

```bash
cd <repo-root>

# ── 1. 复位夹具到 bug 态 ──
FIXTURE_DIR=$HOME/Desktop/Agent-Memory/migration-tool-v1 \
  bash scripts/task5-compare/reset-fixtures.sh

# ── 2. 跑「on」侧（injection.enabled: true）──
#    确认 MemoryProxy/config.yaml 里 injection.enabled: true，然后重启 proxy：
bash MemoryProxy/scripts/proxy.sh restart
FIX_REPO=$HOME/Desktop/Agent-Memory/migration-tool-v1 \
  node scripts/task5-compare.mjs --mode on

# ── 3. 跑「off」侧（injection.enabled: false）──
#    把 MemoryProxy/config.yaml 里 injection.enabled 改为 false，重启 proxy：
#    （sed -i '' 's/^  enabled: true/  enabled: false/' MemoryProxy/config.yaml，注意只在 injection 段）
bash MemoryProxy/scripts/proxy.sh restart
FIX_REPO=$HOME/Desktop/Agent-Memory/migration-tool-v1 \
  node scripts/task5-compare.mjs --mode off

# ── 4. 汇总对照报告 ──
node scripts/task5-compare-report.mjs
# 产物：results/task5-compare/report.md + summary.json
```

> **注意**：`injection.enabled` 在 config.yaml 的 `injection:` 段（不是 `retrieval:` 段）。
> 切换时务必只改 `injection.enabled`，保持 injectors 列表不变，避免影响其它变量。
> 每次切换后都要 `proxy.sh restart`，脚本自身不做热切换（保证进程隔离）。

## 判定方法（双层）

1. **关键词硬检查（优先）**：每个位点一个精确正则，命中即判「给出了正确修复」。
   - B1：`captureVssSnapshot...applyAcl` 顺序（快照先于 ACL）
   - B2：`1.2 / 0.2 / 20%` 缓冲系数
   - B3：`task.offset` / `checkpoint` 读取
2. **LLM 软判断（兜底）**：硬检查未命中时，直连 DeepSeek（`deepseek-chat`，temperature=0）
   按 ground-truth 基准判 `{hit, reason}`。

## 结果字段（run.json）

- `configFingerprint`：本轮 injection.enabled + configHash（SHA1 前 12 位）
- `rows[].judge`：`{method: keyword|llm, hit, reason}`
- `rows[].redExit / greenExit`：红/绿测试退出码
- `rows[].used / validated / contributed`：本会话资产事件
- `grandTotalTokens`：本侧总 token

## 诚实边界

- 任务集 3 个 × on/off × k 轮，样本极小，**不做统计显著性声明**，仅趋势呈现。
- 模型输出有随机性；LLM 兜底判断自身可能误判。
- 报告（`report.md`）按设计 §7.6 的 A/B/C/D 四段组织，C 段（版本对照）本期未实施、如实标注。

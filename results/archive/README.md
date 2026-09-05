# results/archive —— 历史产物归档（不参与当前交付口径）

> 本目录存放**已归档**的历史走查/示意产物，供本地追溯。当前交付所引用的证据
> 一律见 `results/codebuddy-live-5/`、`results/codebuddy-live-6/`、
> `results/task2-verification/`、`results/task4-realfix/`（口径以 `docs/delivery/README.md` 为准）。

## 目录语义

| 路径 | 内容 | 状态 |
|---|---|---|
| `stage-A/` `stage-B/` `stage-C/` | 2026-07 prompt-cache A/B 度量原始 JSON | 本地归档，`.gitignore` 排除，不入库 |
| `runtime-measurement-report.md` | 2026-07 A/B 度量报告（Issue #120） | 本地归档，`.gitignore` 排除，不入库 |
| `gui-legacy/codebuddy-live-2/` | 2026-08 GUI 走查（skill 检索/隔离策略结论） | 旧版 GUI 证据，已归档 |
| `gui-legacy/codebuddy-live-3/` | 2026-08 GUI 走查（round-1 深化） | 旧版 GUI 证据，已归档 |
| `gui-legacy/codebuddy-live-4/` | 2026-08 GUI 走查（任务三/四二轮新功能） | 旧版 GUI 证据，已归档 |
| `task234-demo/` | Panel 概念示意页（HTML，非运行产物） | 已归档，仅本地演示用，勿解读为任务五/六已实现 |

## 复跑

旧 GUI 走查脚本化等价默认输出已指向本目录：
`node scripts/verify-task34-round2.mjs`（live-4 语义，需本地环境重建）。

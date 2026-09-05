# results/codebuddy-live-6 —— 真实 CodeBuddy CN GUI 走查（2026-09-05，多源 + ⑦ 重排）

> GUI 会话 `4a79c410216342d384dd81b14b4a2a46`（真实 CodeBuddy CN + proxy :8097 新代码 + core :8420 + KS :8421）
> 本目录 = 人工在 CodeBuddy 逐条输入、逐步骤截窗口留证 + proxy 日志/DB 证据。

## 走查步骤与产物

| 步 | 用户输入（真实 GUI） | 截图 | 证据 |
|---|---|---|---|
| 1 会话+首条迁移消息 | 初始化（关联资产/agent/task）+「批量迁移 Windows 主机…给可执行迁移检查清单」 | r2-gui-01-init-reply.png | r2-live-01.txt：注入 55·召回 17·选中 8·使用 3；skill 59 / chat-memory 12 / **wiki 7**（多源进上下文） |
| 2 `mem:receipt` | 回执（多源资产证据链） | r2-gui-05-receipt-clean.png（复核帧，见步骤 5） | r2-live-02.txt：proxy /v3/evidence/receipt code 0 / asset_count 19 |
| 3 切题（同话题） | 「VSS/快照 ACL 时序验收步骤」 | r2-gui-03-refresh.png | r2-live-03.txt：仍 devops → **未触发刷新**（正确：同话题不刷） |
| 4 切题（真漂移） | 「重构 CI 发布脚本」→ CodeBuddy 澄清选 B(真 CI 文件)+C(仅方案) | r2-gui-04-refresh-drift.png | r2-live-04.txt：**`shouldRefreshCache drift devops→refactor` + `stale → refresh` + `execute task=refactor pool=10 kept=5`** |
| 5 `mem:receipt`（重发） | 复核回执末尾无 Panel 深链/明文 URL | r2-gui-05-receipt-clean.png | ⑨ 移除后回执纯文本 |

## 收尾要点

- **⑨ Panel 深链**：CodeBuddy webview 点不开外部 http 链接（应用限制）→ 用户决定**从回执移除**
  Panel 深链/明文 URL（2026-09-05，receipt.ts + panelUrl 配置已删）。Panel 证据页仍支持手动开
  `#/evidence?session=<key>` 预选（r2-08-panel-evidence*.png 即用 CDP 直开验证）。
- **⑦ 中途重排**：GUI 实测触发 `drift devops→refactor` → 注入块按 refactor 重跑 execute（kept 5）。
- Panel 手开：`http://127.0.0.1:8125/#/evidence?session=4a79c410216342d384dd81b14b4a2a46`（登录 key = deploy/global-images/.admin-key）。

## 复跑/说明

- 窗口截图：`/tmp/cb-shot.sh <out.png>`（CGWindowList 取 CodeBuddy 主窗口 + `screencapture -l`）。
- 走查脚本化等价（无人值守）：`node scripts/verify-task2-retrieval.mjs` / `node scripts/verify-task4-realfix.mjs`
  （evidence 见 results/task2-verification、task4-realfix）。
- GUI 输入必须人工：CodeBuddy webview 输入框无法被 CGEvent 聚焦（合成键盘无效）。

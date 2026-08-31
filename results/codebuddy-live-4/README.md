# 任务三/四 二轮新功能 · 走查留证（codebuddy-live-4）

> 时间：2026-08-31 · 分支 v2.0.x · 本地 MemoryProxy(:8097) + MemoryCore(:8420) + 源码 Panel(:8125) + ClickHouse
> 覆盖 `docs/verify-task34-round2.md` §3 Step 1–8 与 `docs/codebuddy-gui-walkthrough-checklist.md` 的**二轮新功能**。
> **脚本化走查会话 `sess-task34-r2-1788122297490`**（经与 CodeBuddy 完全相同的 OpenAI 协议打到 :8097，产出真实 DB 事件）。
> **真实 CodeBuddy GUI 走查会话 `12045a6381084bf084740cea4a941e79`**（2026-08-31，模型 `deepseek-v4-flash` → proxy-memory-agent）。

## 结论

二轮新功能在**脚本化全链路 + Panel 可视化 + 真实 CodeBuddy GUI** 三重验证通过：
- 脚本化 `scripts/verify-task34-round2.mjs` exit=0；
- Panel「资产回执」页渲染本会话数据（`r2-08-panel-evidence*.png`）；
- **真实 CodeBuddy GUI 逐步骤驱动**（CGEvent，本机已授 Accessibility）截图 `r2-gui-*.png`：
  Step1 会话表单 → Step2 注册+注入 → Step4 回执 Markdown/`--json` → Step6 `mem:correct`
  → 复查 ❌需修正 → Step5 自动回执（B）。

**过程中发现并修复一个真实环境 bug**：注入器探测的本机 IP 是 VPN 旧地址 `10.151.8.32`
（机器现 IP `10.151.208.229`），工具配方里的 bridge URL 全指向死 IP → 模型 curl 全失败、
无 recalled/used 证据。修复：`config.yaml` 显式设 `injection.externalGatewayUrl: "http://127.0.0.1:8097"`
并重启 proxy（`[injection] proxyBaseUrl (from injection.externalGatewayUrl) = http://127.0.0.1:8097`）。
修复后模型工具调用全部成功，recalled/selected/used 证据在 GUI 会话落库。

## 1. 验证矩阵

| 新功能 | 走查步骤 | 证据（脚本化 / Panel / GUI） |
|---|---|---|
| 会话初始化表单 + 注入（回归） | Step 1–2 | 脚本 [1][2]；GUI `r2-gui-01` 表单 + `r2-gui-02` 注册；DB injected |
| **证据锚定自动回执**（注册轮+单轮无工具**不**触发） | Step 3 | 脚本 [3] `自动回执=未触发（证据锚定）` ✓ |
| F1 召回/选中/使用分派（search→recalled，get-by-name→selected+used） | Step 4 | 脚本 [4] recalled=6/selected=2/used=2；GUI 会话 recalled=14 |
| **D1 memory 定向读取→Chat-Memory used** | Step 4 | 脚本 [4] ✓；GUI `r2-gui-04` `阶段：选中→使用`+`决策证据：memory-bridge/scenario/read`；DB used=1(chat-memory) |
| **B Markdown 折叠回执**（## 分组 + 💤 折叠 + 会话信号行） | Step 4 | 脚本 [5] ✓；GUI `r2-gui-04` `应用资产：16项`+`会话信号：3轮 · bridge 调用3次 · token` |
| **B `--full`**（参考项展开） | Step 4 | 脚本 [6] ✓ |
| **B `--json` + D2 turn_seq** | Step 4 | 脚本 [7] ✓；GUI `r2-gui-05` 结构化 JSON（asset_id/session_id/effectiveness） |
| **B `<assetId>` 深潜** | Step 4 | 脚本 [8] ✓ |
| **C 噪声修复**（used 资产不再标低置信） | Step 4 | 脚本 [5] ✓ |
| **F3 mem:correct + 防凭空** | Step 6 | 脚本 [9] ✓；GUI `r2-gui-06` `已记录用户纠正`+DB corrected=1 |
| **D3 任务收尾自动验证** | Step 5 | 脚本 [10] 自动回执后 DB validated=1（真实命令）✓ |
| **B 自动回执** | Step 5 | 脚本 [10] ✓；GUI `r2-gui-08` `资产使用回执（自动）本次应用资产16项` |
| **A Panel 可视化回执页** | Step 8 | `r2-08-panel-evidence*.png`（会话自动选中） |

## 2. 留证文件

| 文件 | 内容 |
|---|---|
| `evidence-chain.txt` | 脚本化走查完整日志（12 步 + 断言结果，exit=0） |
| `evidence-db.jsonl` | 脚本化会话 30 条 asset_event 全量（含 evidence_json） |
| `evidence-stages.txt` | 阶段计数：`injected 18 · recalled 6 · selected 2 · used 2 · corrected 1 · validated 1` |
| `session-key.txt` | 脚本化会话 `sess-task34-r2-1788122297490` |
| `r2-gui-01-session-init-form.png` | GUI Step1 会话初始化表单「是否关联团队资产」 |
| `r2-gui-02-registered-injected.png` | GUI Step2 注册完成 + 注入 |
| `r2-gui-04-receipt-markdown.png` | GUI Step4 `mem:receipt` Markdown 回执（分组/折叠/会话信号/D1 used） |
| `r2-gui-05-receipt-json.png` | GUI Step4 `mem:receipt --json` 结构化输出 |
| `r2-gui-06-corrected.png` | GUI Step6 `mem:correct` 已记录纠正 |
| `r2-gui-07-corrected-receipt.png` | GUI 复查回执：资产 `❌ 需修正` |
| `r2-gui-08-auto-receipt.png` | GUI Step5 任务收尾自动回执（B） |
| `r2-08-panel-evidence*.png` | Panel「资产回执」页（默认/展开/整页） |
| `00-codebuddy-current.png` | CodeBuddy CN 窗口环境留存 |

> GUI 会话 DB 阶段计数（`12045a6381084bf084740cea4a941e79`）：
> `injected 54 · recalled 14 · selected 1 · used 1 · corrected 1`（validated 0——used 的是 chat-memory，无校验规则）。

## 3. 复现命令

```bash
node scripts/verify-task34-round2.mjs    # 脚本化走查（exit=0，产物写本目录）
node scripts/capture-evidence-shots.mjs  # Panel 证据页截图（CDP，需 :8125 + :8097 + :8420）
node scripts/verify-task3-evidence.mjs   # 基础 e2e（results/task3-verification/evidence-chain.txt 已刷新）
cd MemoryProxy && pnpm vitest run        # 单测 18 文件 / 113 用例全绿
```

## 4. HTTP API 冒烟（A）

```bash
KEY=$(cat deploy/global-images/.admin-key)
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8097/v3/evidence/sessions?limit=3'
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8097/v3/evidence/receipt?session_key=sess-task34-r2-1788122297490'
# → {code:0,data:{asset_count:8, stage_counts, effectiveness, chain_issues, assets[]events}}
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8097/v3/evidence/receipt?session_key=sess-none'  # → 404
```

## 5. 真实 GUI 走查驱动方式与环境修复

> 2026-08-31 本机已授 VS Code「辅助功能」权限后，用 CGEvent（`/tmp/gui.swift` click/paste/type +
> `swift /tmp/scroll.swift` 滚轮）驱动 CodeBuddy CN v4.11.2 逐步骤走查。窗口级截图 `screencapture -l <WID>`。

| Step | 操作（GUI 实测） | 结果 |
|---|---|---|
| 1 | 输入「你好，请介绍一下迁移平台项目…」→ 发送 | 会话初始化表单「是否关联团队资产」→ 点「是」→ 选 Agent + 任务 → 注册 |
| 2 | 注册后首条真实问题 | 注入 3 块（skill 列表 + 记忆工具 + L3 画像）→ DB injected |
| 3 | 「请读取 L2 场景文档…检索 VSS/NTFS 踩坑…」 | 模型自发 curl `memory-bridge/v3/atomic/search` + `scenario/read`（**先因 IP 不通失败，见下**） |
| 4 | `mem:receipt` → `--json` | Markdown 分组折叠 + 会话信号行；`--json` 结构化输出 |
| 6 | `mem:correct <skillId> …` → `mem:receipt` | corrected(source=user)；复查 `❌ 需修正` |
| 5 | 「（这轮不需要调用任何工具）收到，流程到此结束」 | 应答末尾自动追加 `📋 资产使用回执（自动）` |

**环境修复（真实 bug）**：注入器工具配方 base URL 取启动时探测的首个非内部 IPv4 = VPN 旧地址 `10.151.8.32`
（机器现 IP `10.151.208.229`，死地址）→ 模型 curl 全失败、无 recalled/used 证据（模型一度"坦诚告知不可达"）。
修复：`MemoryProxy/config.yaml` `injection.externalGatewayUrl: "http://127.0.0.1:8097"` + 重启 proxy
（日志 `[injection] proxyBaseUrl (from injection.externalGatewayUrl) = http://127.0.0.1:8097`）。
修复后同会话续聊 → 模型工具调用全部成功 → recalled/selected/used 落库。**建议代码层也改 IP 探测：
多接口时优先 en0/en1 而非 Object.keys 首项（`injection/index.ts:272-287`），或对探测 IP 做连通性检查。**

**GUI 驱动小坑记录**：① 窗口含阴影 → `screencapture -l` 像素尺寸 ≠ wininfo 的 points，
点击坐标需用**全屏截图 OCR** 定位（shadow 偏移 ~56px/边）；② 中文字符 osascript keystroke 不生效
（keycode 无 unicode）→ 用 `swift type`（`keyboardSetUnicodeString`）注入；③ CodeBuddy 窗口在**另一 Space**
时 wininfo 仍列出但点击落不到 → 需先 `activate` 切 Space；④ Electron webview 的 AX 树不暴露文本框
（text areas=0）→ 只能坐标点击；⑤ webview 会话区收不到 CGEvent 滚轮 → 无法回滚补拍旧轮次截图。

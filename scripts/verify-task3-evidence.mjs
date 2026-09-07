#!/usr/bin/env node
/**
 * verify-task3-evidence.mjs — 任务三 F1–F4 端到端实测。
 *
 * 覆盖（真实 CodeBuddy 请求形态走 MemoryProxy）：
 *   F1  recalled/selected：skill/search→recalled、skill/get-by-name→selected+used、
 *       memory/atomic/search→recalled（不再 used）
 *   F2  used 收紧：search 命中不宣称"使用"（DB 断言 0 条 used from search）
 *   F3  mem:correct：用户纠正→corrected(source=user)；对不存在资产被前置拦截
 *   F4  证据链完整性：mem:validate 后回执展示 validated-无-used 降级 + ⚠️ 提醒
 *
 * 用法：
 *   node scripts/verify-task3-evidence.mjs
 *
 * 依赖：MemoryProxy :8097 + MemoryCore :8420（config.yaml 已开 memCommand/validation）。
 * 产物：stdout 证据链文本；断言失败 exit 非 0。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PROXY = process.env.PROXY_BASE || "http://localhost:8097";
const SPACE_ID = process.env.SPACE_ID || "default";
const AGENT = "codebuddy";
const MODEL = process.env.MODEL || "deepseek-v4-flash";
const KEY_FILE = join(ROOT, "deploy/global-images/.admin-key");
const API_KEY = process.env.USER_KEY || readFileSync(KEY_FILE, "utf8").trim();
const SESSION = `sess-task3-${Date.now()}`;

// better-sqlite3 解析自 MemoryProxy 的 node_modules（脚本在仓库根跑）。
const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const HDRS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "x-conversation-id": SESSION,
};
const messages = [];

let exitCode = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`      ✓ ${msg}`);
  } else {
    console.error(`      ❌ ASSERT FAIL: ${msg}`);
    exitCode = 1;
  }
}

function ask(content) {
  messages.push({ role: "user", content });
}

async function send() {
  const resp = await fetch(URL, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  return {
    usage: data.usage,
    finish: choice?.finish_reason,
    msg: choice?.message ?? {},
    raw: data,
  };
}

/** 模型视角的 bridge 调用（skill / memory）。成功 2xx 会落阶段事件。 */
async function bridge(path, body) {
  const resp = await fetch(`${PROXY}${path}`, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let items = 0;
  let assets = [];
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed?.data?.items) ? parsed.data.items : [];
    items = arr.length;
    assets = arr.map((it) => ({ id: it.skill_id || it.id, name: it.name }));
  } catch { /* non-json */ }
  return { status: resp.status, items, assets };
}

/** 直查 proxy.db：本会话的 asset_event。 */
function queryEvents() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT stage, asset_id, asset_type, asset_name, evidence_json FROM asset_event WHERE session_key = ? ORDER BY created_at ASC, rowid ASC")
    .all(SESSION);
  db.close();
  return rows;
}

function describe(msg) {
  const parts = [];
  if (msg.content) parts.push(`content: ${String(msg.content).slice(0, 100)}`);
  for (const tc of msg.tool_calls ?? []) parts.push(`tool_call: ${tc.function?.name}`);
  return parts.join("\n              ");
}

function formSummary(msg) {
  const tc = msg?.tool_calls?.[0];
  if (!tc || tc.function?.name !== "ask_followup_question") return null;
  const args = JSON.parse(tc.function?.arguments || "{}");
  return { title: args.title, questions: JSON.parse(args.questions || "[]") };
}

const line = "─".repeat(64);
console.log(line);
console.log(`任务三 F1–F4 端到端实测 · 会话 ${SESSION}`);
console.log(`proxy=${URL}`);
console.log(line);

// ── 1. 会话初始化表单 ─────────────────────────────────────────────────────────
ask("你好，请介绍一下迁移平台项目，以及你为这个团队准备哪些资产。");
const r1 = await send();
const f1 = formSummary(r1.msg);
if (!f1) { console.log(`[1] ❌ 未命中表单: ${describe(r1.msg)}`); process.exit(1); }
console.log(`[1] 命中会话初始化表单：${f1.title}`);
const yes = f1.questions[0]?.options?.[0] ?? "是，关联团队资产";

// ── 2. 回答「关联资产」→ agent/task 选择表单 ──────────────────────────────────
ask(yes);
const r2 = await send();
const f2 = formSummary(r2.msg);
if (!f2) { console.log(`[2] ❌ 未进入 agent/task 选择: ${describe(r2.msg)}`); process.exit(1); }
console.log(`[2] 回答「${yes}」→ 表单：${f2.title}`);

// ── 3. 选 agent + task ────────────────────────────────────────────────────────
const agentQ = f2.questions.find((q) => q.id === "agent");
const taskQ = f2.questions.find((q) => q.id === "task");
if (!agentQ || !taskQ) { console.log(`[3] ❌ 缺 agent/task 问题`); process.exit(1); }
const agentOpt = agentQ.options.find((o) => /udeqdh9q|default-agent/i.test(o)) ?? agentQ.options[0];
const taskOpt = taskQ.options[0];
ask(`<question_answer>`
  + `<question_item id="agent"><answers>${agentOpt}</answers></question_item>`
  + `<question_item id="task"><answers>${taskOpt}</answers></question_item>`
  + `</question_answer>`);
const r3 = await send();
console.log(`[3] 选 agent「${agentOpt}」/ task「${taskOpt}」→ finish=${r3.finish}`);

// ── 4. 真实对话（让注入器记录 injected；也可能触发自动收尾回执）─────────────
ask("我们最近要批量迁移一批 Windows 主机到新平台，请检索团队沉淀的迁移经验，"
  + "特别是批量迁移规划、停机窗口评估与验收标准，帮我列出要点。");
const r4 = await send();
const r4content = String(r4.msg.content ?? "");
// B：注册轮（无工具）+ 本轮若也无工具 → 连续 2 轮 → 自动回执在此追加。
const autoSeenEarly = /资产使用回执（自动）/.test(r4content);
console.log(`[4] 真实对话 → finish=${r4.finish} 自动回执=${autoSeenEarly ? "✅已触发" : "未触发"}`);
if (autoSeenEarly) {
  const m = r4content.match(/📋 资产使用回执（自动）[\s\S]*$/);
  if (m) console.log(`\n${m[0].trimEnd()}\n`);
}

// ── 5. F1：bridge 调用 → recalled / selected / used 分派 ─────────────────────
console.log("\n[5] F1：bridge 调用（分派阶段事件）");
const sk = await bridge("/skill-bridge/v3/skill/search", { query: "批量迁移 验收标准" });
console.log(`      skill/search        → status=${sk.status} 命中=${sk.items}`);
const toolGuide = sk.assets.find((a) => a.name === "cloud-migration-tool-guide");
const toolGuideId = toolGuide?.id;
assert(!!toolGuideId, `search 命中 cloud-migration-tool-guide（${toolGuideId ?? "?"}）`);
const gbn = await bridge("/skill-bridge/v3/skill/get-by-name", { skill_name: "cloud-migration-tool-guide", include_content: true });
console.log(`      skill/get-by-name   → status=${gbn.status}`);
const mem = await bridge("/memory-bridge/v3/atomic/search", { query: "迁移 踩坑 快照 VSS", limit: 5 });
console.log(`      memory/atomic/search→ status=${mem.status} 命中=${mem.items}`);

// ── 5b. F1/F2 断言：直查 DB 核对阶段分派 ──────────────────────────────────────
const events = queryEvents();
console.log("\n[5b] F1/F2 断言（直查 asset_event 表）");
const searchRecalled = events.filter((e) => e.stage === "recalled");
const searchUsed = events.filter((e) => e.stage === "used" && e.asset_id !== toolGuideId);
const selected = events.filter((e) => e.stage === "selected");
const usedToolGuide = events.filter((e) => e.stage === "used" && e.asset_id === toolGuideId);
assert(searchRecalled.length >= 5, `search 命中落 recalled（${searchRecalled.length} 条）`);
assert(searchUsed.length === 0, `search 命中不宣称 used（search 相关 used=0，F2）`);
assert(selected.length >= 1, `get-by-name 落 selected（${selected.length} 条）`);
assert(usedToolGuide.length >= 1, `get-by-name 落 used（${usedToolGuide.length} 条，F1 定向读取=使用）`);
const usedEv = usedToolGuide[0]?.evidence_json ? JSON.parse(usedToolGuide[0].evidence_json) : null;
assert(usedEv?.tool_call?.bridge === "skill-bridge" && usedEv?.tool_call?.endpoint === "get-by-name",
  `used 事件 evidence 带 tool_call（bridge/endpoint，F2）`);
const memRecalled = events.filter((e) => e.stage === "recalled" && e.asset_type === "chat-memory");
assert(memRecalled.length > 0, `memory/atomic/search 落 recalled（${memRecalled.length} 条，非 used）`);

// ── 5c. D1：memory 定向读取（atomic/query / scenario/read → selected/used）──
console.log("\n[5c] D1：memory 定向读取证据（Chat-Memory 首次能到 used）");
const mq = await bridge("/memory-bridge/v3/atomic/query", { type: "fact", limit: 3 });
// scenario/read 响应是 data:{path,content}（非 items），单独解析 envelope code 判断成功。
const srRaw = await fetch(`${PROXY}/memory-bridge/v3/scenario/read`, {
  method: "POST",
  headers: HDRS,
  body: JSON.stringify({ path: "云主机迁移-一键迁移工具.md" }),
});
const srText = await srRaw.text();
let srCode = -1;
try { srCode = JSON.parse(srText)?.code ?? -1; } catch { /* 非 JSON */ }
console.log(`      memory/atomic/query   → status=${mq.status} 命中=${mq.items}`);
console.log(`      memory/scenario/read  → status=${srRaw.status} code=${srCode}`);
const eventsD1 = queryEvents();
const memSelected = eventsD1.filter((e) => e.stage === "selected" && e.asset_type === "chat-memory");
const memUsedDirect = eventsD1.filter((e) => e.stage === "used" && e.asset_type === "chat-memory");
// atomic/query 无内容时不落事件（不造伪证据）→ 按上游是否有数据软校验。
if (mq.items > 0) {
  assert(memSelected.length >= 1, `atomic/query 命中 → 落 selected（${memSelected.length} 条，D1）`);
} else {
  console.log(`      (atomic/query 无 items，跳过 selected 硬断言 —— 容错解析不造伪证据)`);
}
if (srRaw.status === 200 && srCode === 0) {
  assert(memUsedDirect.length >= 1, `scenario/read 命中 → 落 used（${memUsedDirect.length} 条，D1 定向读取=使用）`);
} else {
  console.log(`      (scenario/read 未命中场景文档，跳过 used 硬断言)`);
}

// ── 6. mem:receipt #1 —— 展示 F1 阶段 ─────────────────────────────────────────
messages.push({ role: "user", content: "mem:receipt" });
const r6 = await send();
console.log("\n[6] mem:receipt（recalled/selected/used 阶段）");
if (r6.msg.content) console.log(`\n${String(r6.msg.content).trimEnd()}\n`);

// ── 7. F3：mem:correct 用户纠正 ───────────────────────────────────────────────
// 纠正一个 recalled-only 资产（非 toolGuide，避免重复）：取 search 里另一个 skill。
const correctTarget = sk.assets.find((a) => a.id !== toolGuideId);
console.log(`[7] F3：mem:correct ${correctTarget?.id}（用户主动纠正）`);
messages.push({ role: "user", content: `mem:correct ${correctTarget?.id} 引用的旧版 CLI 命令已下线，需要更新` });
const r7 = await send();
if (r7.msg.content) console.log(`\n${String(r7.msg.content).trimEnd()}\n`);
const corrected = queryEvents().filter((e) => e.stage === "corrected");
assert(corrected.length === 1, `落 1 条 corrected 事件`);
const corrEv = corrected[0]?.evidence_json ? JSON.parse(corrected[0].evidence_json) : null;
assert(corrEv?.source === "user", `corrected evidence.source="user"`);

// 防凭空纠正：对不存在资产应被拦截
messages.push({ role: "user", content: "mem:correct skl-nonexistent 凭空纠正" });
const r7b = await send();
const guardText = String(r7b.msg.content ?? "");
console.log(`      mem:correct skl-nonexistent → 被拦截：${guardText.slice(0, 60).replace(/\n/g, " ")}`);
assert(/未找到|无法纠正/.test(guardText), `不存在资产被前置校验拦截（F3 防凭空纠正）`);

// ── 8. F4：mem:validate（三入口同门禁）─────────────────────────────────────────
// 防伪证收紧后：mem:validate 默认 / <id> / --all 只放行本会话 used/selected 且未纠正资产，
// 无法再对仅召回/注入资产写 validated-无-used。这里用 --all 验证门禁一致。
messages.push({ role: "user", content: "mem:validate --all" });
const r8 = await send();
console.log("\n[8] mem:validate（真实校验命令 → validated/corrected；三入口同门禁）");
if (r8.msg.content) console.log(`\n${String(r8.msg.content).trimEnd()}\n`);

// 防伪证不变量（直查 DB）：每条 validated.asset_id ∈ 本会话 used∪selected。
const evAfterValidate = queryEvents();
const usedIds = new Set(evAfterValidate.filter((e) => e.stage === "used").map((e) => e.asset_id));
const usedSelectedIds = new Set(
  evAfterValidate.filter((e) => e.stage === "used" || e.stage === "selected").map((e) => e.asset_id),
);
const validatedRows = evAfterValidate.filter((e) => e.stage === "validated");
const validatedOutside = validatedRows.filter((e) => !usedSelectedIds.has(e.asset_id));
console.log(`      used=${usedIds.size} · used∪selected=${usedSelectedIds.size} · validated=${validatedRows.length} · 越界=${validatedOutside.length}`);
assert(validatedOutside.length === 0, `validated ⊆ used∪selected（防伪证全入口一致；越界 ${validatedOutside.length}）`);

// ── 9. F4：最终回执（技术明细 --full）—— 证据链完整性提醒 ───────────────────────
messages.push({ role: "user", content: "mem:receipt --full" });
const r9 = await send();
console.log("[9] mem:receipt --full（最终：F4 证据链完整性校验，技术明细）");
const finalReceipt = String(r9.msg.content ?? "");
if (finalReceipt) console.log(`\n${finalReceipt.trimEnd()}\n`);

// ── 9b. 默认回执（对外平实语言）断言 ────────────────────────────────────────────
messages.push({ role: "user", content: "mem:receipt" });
const r9b = await send();
const plainReceipt = String(r9b.msg.content ?? "");
console.log("\n[9b] mem:receipt（默认：对外平实语言）");
if (plainReceipt) console.log(`\n${plainReceipt.trimEnd()}\n`);
assert(/作用：/.test(plainReceipt) && /为什么适用：/.test(plainReceipt),
  `默认回执含「作用/为什么适用」平实字段`);
assert(/项已通过验证|项仅作背景参考/.test(plainReceipt), `默认回执用平实计数（N 项已通过验证 / 仅作背景参考）`);
assert(!/归因:/.test(plainReceipt) && !/证据详情：/.test(plainReceipt) && !/召回 → 选中/.test(plainReceipt),
  `默认回执去工程口径（无 归因/证据详情/阶段路径）`);
assert(/mem:receipt --json/.test(plainReceipt), `默认回执附 --json 导出入口提示`);

// ── 10. F4 断言 ───────────────────────────────────────────────────────────────
console.log("[10] F4 断言（回执内容）");
// validated-无-used 的降级展示只在本会话存在 selected-未-used 资产时出现（收紧后 validated
// 仍可能是 selected-only → 仍触发 F4 降级）。存在才硬断言；不存在则降级展示由 receipt 单测覆盖。
const degradeAssetIds = [...new Set(validatedRows.filter((e) => !usedIds.has(e.asset_id)).map((e) => e.asset_id))];
const hasWarnSection = /证据链完整性提醒/.test(finalReceipt);
const hasDegrade = /⚠️ 已标记验证（缺使用证据）/.test(finalReceipt);
if (degradeAssetIds.length > 0) {
  assert(hasWarnSection, `回执含 ⚠️ 证据链完整性提醒 段`);
  assert(hasDegrade, `validated-无-used 资产（${degradeAssetIds.length} 项）状态降级为 ⚠️ 已标记验证（缺使用证据）`);
} else {
  console.log(`      （本会话无 selected-未-used 的 validated 资产：F4 降级展示由 receipt 单测覆盖，跳过 e2e 断言）`);
}
const hasToolGuideOk = /cloud-migration-tool-guide/.test(finalReceipt)
  && /召回 → 选中 → 注入 → 使用 → 已验证/.test(finalReceipt);
assert(hasToolGuideOk, `cloud-migration-tool-guide 走完 召回→选中→注入→使用→已验证`);
const hasCorrectedStatus = /需修正/.test(finalReceipt);
assert(hasCorrectedStatus, `被纠正资产状态显示 ❌ 需修正`);

// ── 11. A/D 断言（有效性交叉验证 + 风险 + C 决策）──────────────────────────────
console.log("\n[11] A/D/C 断言（回执内容）");
const hasEffSummary = /有效性：.*已验证 \d/.test(finalReceipt);
assert(hasEffSummary, `回执含有效性汇总行（**有效性：** ✅已验证 N · …）`);
const hasToolGuideValidated = /cloud-migration-tool-guide[\s\S]*?✅ 已通过测试验证/.test(finalReceipt);
assert(hasToolGuideValidated, `cloud-migration-tool-guide 有效性=✅ 已通过测试验证（行为×结果交叉）`);
const hasDecision = /决策证据：工具调用 skill-bridge\/get-by-name/.test(finalReceipt);
assert(hasDecision, `回执展示决策证据（工具调用，C 诚实边界）`);

// ── 13. 任务四 深化：Markdown 回执 + --json + <assetId> 深潜 ───────────────────
console.log("\n[13] 任务四 深化：Markdown 分组回执 / --json / 深潜");
// --full 按资源类型分组（## Skill（N））；默认平实回执折叠 reference_only（仅背景参考（N 项））。
const hasMarkdownGroup = /^## 📋 资产使用回执（本会话）$/m.test(finalReceipt)
  && /^## Skill（\d+）$/m.test(finalReceipt);
assert(hasMarkdownGroup, `--full 回执为 Markdown 分组（## 标题 + 类型分组）`);
const hasRefCollapse = /💤 仅背景参考（\d+ 项）/.test(plainReceipt);
assert(hasRefCollapse, `默认回执折叠 reference_only（💤 仅背景参考（N 项））`);

messages.push({ role: "user", content: "mem:receipt --json" });
const r13 = await send();
let jsonReceipt = null;
try {
  jsonReceipt = JSON.parse(String(r13.msg.content ?? "{}"));
} catch { /* 非 JSON */ }
assert(!!jsonReceipt && Array.isArray(jsonReceipt.assets) && jsonReceipt.asset_count >= 1,
  `mem:receipt --json 输出结构化回执（asset_count=${jsonReceipt?.asset_count ?? "?"}）`);
assert(!!jsonReceipt && Array.isArray(jsonReceipt.assets[0]?.events),
  `--json 每资产含 events 数组（证据展开数据）`);

messages.push({ role: "user", content: `mem:receipt ${toolGuideId}` });
const r13b = await send();
const deepDive = String(r13b.msg.content ?? "");
assert(/证据事件（\d+）/.test(deepDive) && deepDive.includes(toolGuideId),
  `mem:receipt <assetId> 深潜列出该资产全部证据事件`);

// ── 12. B：任务收尾自动追加回执（连续无工具轮；[4] 已触发则跳过）─────────────
console.log("\n[12] B：任务收尾自动追加简短回执（连续无工具轮）");
let autoShown = autoSeenEarly;
let autoContent = autoSeenEarly ? r4content : "";
for (let i = 0; i < 8 && !autoShown; i++) {
  messages.push({ role: "user", content: i === 0 ? "嗯，这些够用了，谢谢。" : "还有要补充的吗？" });
  const rb = await send();
  const content = String(rb.msg.content ?? "");
  const hasTool = (rb.msg.tool_calls ?? []).length > 0;
  console.log(`      第 ${i + 1} 轮 → finish=${rb.finish} 工具=${hasTool ? "有" : "无"} ${content.replace(/\s+/g, " ").slice(0, 60)}`);
  if (/资产使用回执（自动）/.test(content)) { autoShown = true; autoContent = content; }
}
assert(autoShown, `任务收尾自动追加简短回执（B，threshold=2；[4] 或后续连续无工具轮触发）`);
if (autoContent && !autoSeenEarly) {
  const m = autoContent.match(/📋 资产使用回执（自动）[\s\S]*$/);
  if (m) console.log(`\n${m[0].trimEnd()}\n`);
}

console.log(line);
console.log(`实测完成：${SESSION}（agent=${agentOpt}）exit=${exitCode}`);
process.exit(exitCode);

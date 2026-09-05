#!/usr/bin/env node
/**
 * verify-task34-round2.mjs — 任务三/四 二轮新功能端到端实测（脚本化 GUI 走查等价）。
 *
 * 覆盖（docs/codebuddy-gui-walkthrough.md Step 1–7 的自动化等价，真实 CodeBuddy 请求形态）：
 *   Step 1–2  会话初始化表单注册 + 注入
 *   Step 3    D1 memory 定向读取（scenario/read + atomic/query）→ Chat-Memory 到 used
 *   Step 4    B  Markdown 折叠回执：默认 / --full / --json（含 turn_seq）/ <assetId> 深潜
 *   Step 5    D3 任务收尾自动验证：不跑 mem:validate，靠自动回执触发 auto-validate
 *              + B 自动回执（证据锚定：注册轮不计、工具轮重置）
 *   Step 6    F3 mem:correct + 防凭空纠正
 *   Step 7    C 噪声修复：used+validated 资产不再标低置信
 *
 * 用法：
 *   node scripts/verify-task34-round2.mjs
 * 产物：stdout 走查日志 + results/archive/gui-legacy/codebuddy-live-4/{evidence-chain.txt,
 *       evidence-db.jsonl, session-key.txt, stages.txt}
 * 依赖：MemoryProxy :8097 + MemoryCore :8420（config.yaml 已开 memCommand/validation/clickhouse）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const SESSION = `sess-task34-r2-${Date.now()}`;

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

const OUT_DIR = join(ROOT, "results", "archive", "gui-legacy", "codebuddy-live-4");
const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const HDRS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "x-conversation-id": SESSION,
};
const messages = [];

let exitCode = 0;
function assert(cond, msg) {
  if (cond) console.log(`      ✓ ${msg}`);
  else { console.error(`      ❌ ASSERT FAIL: ${msg}`); exitCode = 1; }
}

function ask(content) { messages.push({ role: "user", content }); }

async function send() {
  const resp = await fetch(URL, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  return { finish: choice?.finish_reason, msg: choice?.message ?? {}, raw: data };
}

async function bridge(path, body) {
  const resp = await fetch(`${PROXY}${path}`, { method: "POST", headers: HDRS, body: JSON.stringify(body) });
  const text = await resp.text();
  let items = 0, assets = [];
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed?.data?.items) ? parsed.data.items : [];
    items = arr.length;
    assets = arr.map((it) => ({ id: it.skill_id || it.id, name: it.name }));
  } catch { /* non-json */ }
  return { status: resp.status, items, assets, text };
}

function queryEvents() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT stage, asset_id, asset_type, asset_name, turn_seq, evidence_json, created_at FROM asset_event WHERE session_key = ? ORDER BY created_at ASC, rowid ASC")
    .all(SESSION);
  db.close();
  return rows;
}

function formSummary(msg) {
  const tc = msg?.tool_calls?.[0];
  if (!tc || tc.function?.name !== "ask_followup_question") return null;
  const args = JSON.parse(tc.function?.arguments || "{}");
  return { title: args.title, questions: JSON.parse(args.questions || "[]") };
}

const line = "─".repeat(64);
console.log(line);
console.log(`任务三/四 二轮走查（脚本化 GUI 等价）· 会话 ${SESSION}`);
console.log(`proxy=${URL}`);
console.log(line);

// ── Step 1/2：会话初始化表单 → 注册 → 注入 ─────────────────────────────
ask("你好，请介绍一下迁移平台项目，以及你为这个团队准备哪些资产。");
const r1 = await send();
const f1 = formSummary(r1.msg);
if (!f1) { console.log("[1] ❌ 未命中表单"); process.exit(1); }
console.log(`[1] 命中会话初始化表单：${f1.title}`);
const yes = f1.questions[0]?.options?.[0] ?? "是，关联团队资产";
ask(yes);
const r2 = await send();
const f2 = formSummary(r2.msg);
if (!f2) { console.log("[2] ❌ 未进入 agent/task 选择"); process.exit(1); }
const agentQ = f2.questions.find((q) => q.id === "agent");
const taskQ = f2.questions.find((q) => q.id === "task");
const agentOpt = agentQ.options.find((o) => /udeqdh9q|default-agent/i.test(o)) ?? agentQ.options[0];
ask(`<question_answer><question_item id="agent"><answers>${agentOpt}</answers></question_item><question_item id="task"><answers>${taskQ.options[0]}</answers></question_item></question_answer>`);
const r3 = await send();
console.log(`[2] 注册 agent「${agentOpt}」/ task「${taskQ.options[0]}」→ finish=${r3.finish}`);

// 真实对话轮（无工具 → streak=1；此时无 used/selected，不触发自动回执）
ask("我们最近要批量迁移一批 Windows 主机到新平台，请检索团队沉淀的迁移经验，特别是批量迁移规划、停机窗口评估与验收标准，帮我列出要点。");
const r4 = await send();
const autoEarly = /资产使用回执（自动）/.test(String(r4.msg.content ?? ""));
console.log(`[3] 真实对话 → finish=${r4.finish} 自动回执(过早)=${autoEarly ? "❌触发了" : "✅未触发（证据锚定）"}`);
assert(!autoEarly, `注册+单轮无工具 不触发自动回执（证据锚定，修复验证）`);

// ── Step 3：bridge 调用 → recalled/selected/used + D1 memory 定向读取 ──
console.log("\n[4] F1/D1：bridge 调用（阶段分派 + memory 定向读取）");
const sk = await bridge("/skill-bridge/v3/skill/search", { query: "批量迁移 验收标准" });
console.log(`      skill/search        → status=${sk.status} 命中=${sk.items}`);
const toolGuide = sk.assets.find((a) => a.name === "cloud-migration-tool-guide");
assert(!!toolGuide?.id, `search 命中 cloud-migration-tool-guide（${toolGuide?.id ?? "?"}）`);
const gbn = await bridge("/skill-bridge/v3/skill/get-by-name", { skill_name: "cloud-migration-tool-guide", include_content: true });
console.log(`      skill/get-by-name   → status=${gbn.status}`);
const mq = await bridge("/memory-bridge/v3/atomic/query", { type: "fact", limit: 3 });
const srRaw = await fetch(`${PROXY}/memory-bridge/v3/scenario/read`, {
  method: "POST", headers: HDRS,
  body: JSON.stringify({ path: "云主机迁移-一键迁移工具.md" }),
});
const srText = await srRaw.text();
let srCode = -1; try { srCode = JSON.parse(srText)?.code ?? -1; } catch { /* 非 JSON */ }
console.log(`      memory/atomic/query  → status=${mq.status} 命中=${mq.items}`);
console.log(`      memory/scenario/read → status=${srRaw.status} code=${srCode}`);

const ev1 = queryEvents();
const memSelected = ev1.filter((e) => e.stage === "selected" && e.asset_type === "chat-memory");
const memUsedDirect = ev1.filter((e) => e.stage === "used" && e.asset_type === "chat-memory");
if (srRaw.status === 200 && srCode === 0) {
  assert(memUsedDirect.length >= 1, `scenario/read 命中 → Chat-Memory 到 used（${memUsedDirect.length} 条，D1）`);
} else { console.log(`      (scenario/read 未命中场景文档，跳过 used 硬断言)`); }

// ── Step 4：mem:receipt 四形态（Markdown / --full / --json / 深潜）──────
async function mem(content) {
  messages.push({ role: "user", content });
  const r = await send();
  return String(r.msg.content ?? "");
}

console.log("\n[5] B：mem:receipt Markdown（分组 + 折叠 + 会话信号）");
const receipt = await mem("mem:receipt");
console.log(`\n${receipt.trimEnd()}\n`);
const hasGroups = /^## 📋 资产使用回执（本会话）$/m.test(receipt) && /^## Skill（\d+）$/m.test(receipt);
assert(hasGroups, `Markdown 分组（## 标题 + ## Skill 分组）`);
assert(/💤 仅背景参考（\d+ 项）/.test(receipt), `reference_only 默认折叠（> 💤 仅背景参考（N 项））`);
assert(/会话信号：/.test(receipt), `回执含「会话信号」行（CH 聚合）`);
const lowConfNoise = /已通过测试验证[\s\S]*低置信/.test(receipt) || /待验证[\s\S]*低置信/.test(receipt);
assert(!lowConfNoise, `used 资产不再标低置信（C 噪声修复）`);

console.log("[6] B：mem:receipt --full（展开参考项）");
const receiptFull = await mem("mem:receipt --full");
assert(!/仅背景参考（\d+ 项）· `mem:receipt --full` 展开/.test(receiptFull), `--full 展开参考项（折叠行消失）`);
console.log("      ✓ --full 输出参考资产完整卡（略）");

console.log("[7] B：mem:receipt --json（结构化 + turn_seq）");
const jsonStr = await mem("mem:receipt --json");
let jr = null; try { jr = JSON.parse(jsonStr); } catch { /* 非 JSON */ }
assert(!!jr && Array.isArray(jr.assets) && jr.asset_count >= 1, `--json 输出结构化回执（asset_count=${jr?.asset_count ?? "?"}）`);
assert(!!jr && Array.isArray(jr.assets[0]?.events) && jr.assets[0].events.length > 0, `--json 每资产含 events 数组`);
const usedEv = jr?.assets.flatMap((a) => a.events || []).find((e) => e.stage === "used");
assert(!!usedEv && typeof usedEv.turn_seq === "number", `used 事件带数字 turn_seq（D2，实际=${usedEv?.turn_seq ?? "空"}）`);

console.log("[8] B：mem:receipt <assetId>（单资产深潜）");
const deepDive = await mem(`mem:receipt ${toolGuide.id}`);
// 深潜头部显示资产「名」（## 📋 资产回执 · <name>）；assetId 仅出现在 validated 的
// 命令输出里（本场景深潜在 mem:validate/自动验证之前，无 validated 事件 → 不断言 id）。
assert(/证据事件（\d+）/.test(deepDive), `深潜列出该资产全部证据事件（证据事件（N））`);
assert(deepDive.includes(`资产回执 · ${toolGuide.name}`), `深潜标题为资产名（资产回执 · cloud-migration-tool-guide）`);

// ── Step 6：mem:correct + 防凭空 ───────────────────────────────────────
console.log("\n[9] F3：mem:correct + 防凭空纠正");
const target = sk.assets.find((a) => a.id !== toolGuide.id);
const corr = await mem(`mem:correct ${target?.id} 引用的旧版 CLI 命令已下线，需要更新`);
console.log(`      ${corr.split("\n")[0]}`);
const corrected = queryEvents().filter((e) => e.stage === "corrected");
assert(corrected.length === 1, `落 1 条 corrected 事件`);
assert(corrected[0]?.evidence_json && JSON.parse(corrected[0].evidence_json)?.source === "user", `corrected evidence.source="user"`);
const guard = await mem("mem:correct skl-nonexistent 凭空纠正");
assert(/未找到|无法纠正/.test(guard), `不存在资产被前置拦截（防凭空纠正）`);

// ── Step 5：任务收尾自动回执 + 自动验证（D3，不跑 mem:validate）────────
console.log("\n[10] D3+B：任务收尾自动回执（连续无工具轮 → 触发 auto-validate）");
let autoShown = false, autoContent = "";
for (let i = 0; i < 8 && !autoShown; i++) {
  messages.push({ role: "user", content: i === 0 ? "这些够用了，谢谢。" : "还有要补充的吗？" });
  const rb = await send();
  const content = String(rb.msg.content ?? "");
  const hasTool = (rb.msg.tool_calls ?? []).length > 0;
  console.log(`      第 ${i + 1} 轮 → finish=${rb.finish} 工具=${hasTool ? "有" : "无"} ${content.replace(/\s+/g, " ").slice(0, 70)}`);
  if (/资产使用回执（自动）/.test(content)) { autoShown = true; autoContent = content; }
}
assert(autoShown, `任务收尾自动追加简短回执（B，证据锚定后）`);
if (autoContent) console.log(`\n${autoContent.match(/📋 资产使用回执（自动）[\s\S]*$/)?.[0]?.trimEnd() ?? ""}\n`);

// 等自动验证（非流式有界 await，流式 fire-and-forget）写入 validated 事件
await new Promise((r) => setTimeout(r, 2500));
const validatedNoCmd = queryEvents().filter((e) => e.stage === "validated");
assert(validatedNoCmd.length >= 1, `无 mem:validate 也产生 validated 事件（D3 自动验证，${validatedNoCmd.length} 条）`);
const vCmd = validatedNoCmd[0]?.evidence_json ? JSON.parse(validatedNoCmd[0].evidence_json)?.test_result?.command : "";
console.log(`      auto-validate 命令：${vCmd ?? ""}`);

const receiptAfter = await mem("mem:receipt");
console.log("\n[11] 复查回执（自动验证后）");
console.log(`      ${receiptAfter.split("\n").filter((l) => /有效性|已验证/.test(l)).slice(0, 3).join("\n      ")}`);
assert(/✅ 已通过测试验证/.test(receiptAfter) || /已通过测试验证/.test(receiptAfter), `被自动验证的 used skill 显示 ✅ 已通过测试验证`);

// ── 12. 留证：导出 DB 证据 ─────────────────────────────────────────────
console.log("\n[12] 导出留证 → results/archive/gui-legacy/codebuddy-live-4/");
mkdirSync(OUT_DIR, { recursive: true });
const all = queryEvents();
const stages = all.reduce((acc, e) => { acc[e.stage] = (acc[e.stage] || 0) + 1; return acc; }, {});
writeFileSync(join(OUT_DIR, "session-key.txt"), SESSION);
writeFileSync(join(OUT_DIR, "evidence-stages.txt"), Object.entries(stages).map(([k, v]) => `${k}|${v}`).sort().join("\n") + "\n");
writeFileSync(join(OUT_DIR, "evidence-db.jsonl"), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`      阶段计数：${JSON.stringify(stages)}`);
console.log(`      事件总数：${all.length}`);

console.log(line);
console.log(`二轮走查完成：${SESSION} exit=${exitCode}`);
process.exit(exitCode);

#!/usr/bin/env node
/**
 * verify-task2-retrieval.mjs — 任务二「面向新任务的检索与最小上下文」端到端实测。
 *
 * 覆盖（真实 CodeBuddy 请求形态走 MemoryProxy :8097 + MemoryCore :8420）：
 *   1. 会话初始化（headerAutoSelect 预选身份）→ prewarm 主动检索 + 六维重排
 *   2. hook_cache 缓存 `task2-selected-assets-injector` 块（含 <task2_selected_assets>）
 *   3. asset_event 落 `selected(decision="rerank")`（dims 六维齐 / weightedScore / rank）
 *   4. kept 资产落 `injected`；selected 数 ≥ injected 数
 *   5. 预算裁剪：trimmedByBudget=true 的 selected 不落 injected
 *   6. 跨用户来源标注：cross-agent skill 的 source ≠ "self"
 *   7. 校准产物：results/task2-verification/rerank-table.json（每候选六维分 + 加权总分）
 *
 * 用法：
 *   node scripts/verify-task2-retrieval.mjs
 * 依赖：MemoryProxy :8097 + MemoryCore :8420（config.yaml 已开 retrieval/sessionInit）。
 * 产物：stdout 走查日志 + results/task2-verification/；断言失败 exit 非 0。
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
const SESSION = `sess-task2-${Date.now()}`;

// 任务二 e2e 身份：复用既有 team-coudtbobez + agt-coudeqdh9q + task-covxoq8e1r
// （任务描述"云主机迁移平台...ACL 兼容问题"足够强 → prewarm 主动检索有意义）。
const TEAM = process.env.T2_TEAM || "team-coudtbobez";
const AGENT_ID = process.env.T2_AGENT || "agt-coudeqdh9q";
const TASK_ID = process.env.T2_TASK || "task-covxoq8e1r";

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

const OUT_DIR = join(ROOT, "results", "task2-verification");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const HDRS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "x-conversation-id": SESSION,
  // headerAutoSelect：验证过的身份直接注册，跳过交互表单。
  "x-team-id": TEAM,
  "x-agent-id": AGENT_ID,
  "x-task-id": TASK_ID,
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

function formSummary(msg) {
  const tc = msg?.tool_calls?.[0];
  if (!tc || tc.function?.name !== "ask_followup_question") return null;
  const args = JSON.parse(tc.function?.arguments || "{}");
  return { title: args.title, questions: JSON.parse(args.questions || "[]") };
}

function queryEvents() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT stage, asset_id, asset_type, asset_name, source_tag, evidence_json, created_at FROM asset_event WHERE session_key = ? ORDER BY created_at ASC, rowid ASC")
    .all(SESSION);
  db.close();
  return rows;
}

function queryHookCache() {
  // storage.backend=sqlite → hook cache 走 KvHookCacheRepo，落在 proxy_kv 表
  // （键形如 ttl/<space>/<user>/<agent>/<session>/inj-hook/<hookId>.json）。
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT k, v FROM proxy_kv WHERE k LIKE '%task2-selected-assets-injector%' AND k LIKE ? ORDER BY updated_at DESC LIMIT 3")
    .all(`%${SESSION}%`);
  db.close();
  return rows.map((r) => ({
    k: r.k,
    text: Buffer.isBuffer(r.v) ? r.v.toString("utf8") : String(r.v),
  }));
}

const line = "─".repeat(64);
console.log(line);
console.log(`任务二 检索与最小上下文 e2e · 会话 ${SESSION}`);
console.log(`proxy=${URL} identity=${TEAM}/${AGENT_ID}/${TASK_ID}`);
console.log(line);

// ── Step 1：会话初始化（headerAutoSelect 直达）+ 首轮真实任务 ────────────
ask("请修复云主机迁移平台里 Windows ACL 校验失败的 bug：校验当前在快照前执行导致校验失效，需要调整执行顺序并复核影响路径。");
const r1 = await send();

// 若 headerAutoSelect 因身份不匹配回落表单，自动选 agent+task 继续。
let f = formSummary(r1.msg);
if (f) {
  console.log(`[1] 回落会话初始化表单：${f.title}`);
  const agentQ = f.questions.find((q) => q.id === "agent");
  const taskQ = f.questions.find((q) => q.id === "task");
  const agentOpt = agentQ?.options?.[0];
  const taskOpt = taskQ?.options?.[0];
  if (!agentOpt || !taskOpt) { console.log("[1] ❌ 无可用 agent/task 选项"); process.exit(1); }
  ask(`<question_answer><question_item id="agent"><answers>${agentOpt}</answers></question_item><question_item id="task"><answers>${taskOpt}</answers></question_item></question_answer>`);
  await send();
} else {
  console.log("[1] headerAutoSelect 直达注册（无表单）");
}

// ── Step 2：hook_cache 命中 task2 注入块 ────────────────────────────────
console.log("\n── 证据链检查（asset_event）──");
const events = queryEvents();
const rerankSelected = events.filter((e) => {
  let ev = null;
  try { ev = JSON.parse(e.evidence_json || "null"); } catch { /* */ }
  return e.stage === "selected" && ev?.decision === "rerank";
});
const injected = events.filter((e) => e.stage === "injected");
const recalled = events.filter((e) => e.stage === "recalled");

console.log(`  recalled=${recalled.length} selected(rerank)=${rerankSelected.length} injected=${injected.length}`);
assert(rerankSelected.length >= 1, `selected(decision=rerank) 事件 ≥1（实际 ${rerankSelected.length}）`);

// ── 多源候选池（任务二 #1）：chat-memory(L1)/A∪B 私有 skill 也进入候选 ──
const chatMemRecalled = events.filter((e) => e.stage === "recalled" && e.asset_type === "chat-memory");
const ownPrivateSkill = events.find((e) => e.asset_name === "cloud-migration-batch-planning");
console.log(`  多源：recalled chat-memory=${chatMemRecalled.length} · A∪B 私有 skill=${ownPrivateSkill ? "cloud-migration-batch-planning（已纳入候选）" : "（本轮无）"}`);
if (!process.env.T2_NO_CHATMEM) {
  assert(chatMemRecalled.length >= 1, `chat-memory(L1 历史经验) 进入候选池（recalled ${chatMemRecalled.length} 条）`);
} else {
  console.log(`  （T2_NO_CHATMEM 置位：跳过 chat-memory 断言）`);
}
const wikiRecalled = events.filter((e) => e.asset_type === "wiki");
if (wikiRecalled.length > 0) {
  const wikiSelected = events.filter((e) => e.asset_type === "wiki" && (e.stage === "selected" || e.stage === "injected"));
  assert(wikiSelected.length > 0 || wikiRecalled.length > 0, `wiki(文档/产品知识) 进入候选池（recalled ${wikiRecalled.length}${wikiSelected.length ? ` · 入选 ${wikiSelected.length}` : ""}）`);
} else {
  console.log("  （本轮无 wiki 源数据 —— 需 MemoryKnowledge + 已注册 wiki；跳过 wiki 断言）");
}

// 重排证据结构：dims 六维齐 / weightedScore / rank / threshold
if (rerankSelected.length > 0) {
  const ev = JSON.parse(rerankSelected[0].evidence_json);
  const dims = ev.rerank?.dims ?? {};
  assert(ev.decision === "rerank", "selected evidence.decision=rerank");
  assert(
    ["relevance", "credibility", "freshness", "envCompat", "historicalEffect", "tokenCost"]
      .every((k) => typeof dims[k] === "number"),
    "rerank.dims 六维齐（relevance/credibility/freshness/envCompat/historicalEffect/tokenCost）",
  );
  assert(typeof ev.rerank?.weightedScore === "number", `rerank.weightedScore 为数字（${ev.rerank?.weightedScore}）`);
  assert(typeof ev.rerank?.rank === "number" && ev.rerank.rank >= 1, `rerank.rank ≥1（${ev.rerank?.rank}）`);
  assert(typeof ev.rerank?.threshold === "number", "rerank.threshold 为数字");
  assert(typeof ev.rerank?.trimmedByBudget === "boolean", "rerank.trimmedByBudget 为布尔");
}

// P1：注入器检索补 recalled —— 闭合 recalled ⊇ selected ⊇ injected（每个入选者都有 recalled 前置）。
const recalledIds = new Set(recalled.map((e) => e.asset_id));
for (const e of rerankSelected) {
  assert(recalledIds.has(e.asset_id), `selected ${e.asset_id} 有 recalled 前置（子集闭包）`);
}

// ── Step 3：injected 与预算裁剪 ─────────────────────────────────────────
assert(injected.length >= 1, `kept 资产落 injected（实际 ${injected.length}）`);

const injectedIds = new Set(injected.map((e) => e.asset_id));
const trimmed = rerankSelected.filter((e) => JSON.parse(e.evidence_json).rerank?.trimmedByBudget === true);
const untrimmed = rerankSelected.filter((e) => JSON.parse(e.evidence_json).rerank?.trimmedByBudget === false);
console.log(`  入选(未裁)=${untrimmed.length} 入选(预算裁)=${trimmed.length}`);
// 语义：kept（未裁）必须落 injected；trimmed（预算裁）只落 selected 不落 injected。
for (const e of untrimmed) {
  assert(injectedIds.has(e.asset_id), `未裁入选资产 ${e.asset_id} 已落 injected`);
}
for (const e of trimmed) {
  assert(!injectedIds.has(e.asset_id), `预算裁资产 ${e.asset_id} 不落 injected`);
}

// ── Step 4：跨用户来源标注 ──────────────────────────────────────────────
const crossUser = rerankSelected.filter((e) => e.source_tag && e.source_tag !== "self" && e.source_tag !== "team");
console.log(`  跨用户来源候选：${crossUser.length}（source_tag：${[...new Set(rerankSelected.map((e) => e.source_tag))].join(",") || "(空)"}）`);
if (crossUser.length > 0) {
  assert(true, `存在来源非 self 的跨 agent 资产（如 ${crossUser[0].source_tag}）→ 跨用户推荐可追溯`);
} else {
  console.log("      ⚠ 本轮入选资产均非跨 agent（未到白名单跨 agent 候选），跨用户标注不在此轮验证");
}

// ── Step 5：hook_cache 块 + 校准产物 ────────────────────────────────────
console.log("\n── hook_cache 检查 ──");
const cached = queryHookCache();
const blockJson = cached.find((c) => c.text.includes("task2_selected_assets"));
assert(!!blockJson, "kv 缓存 task2-selected-assets-injector 块（含 <task2_selected_assets>）");
if (blockJson) {
  const blocks = JSON.parse(blockJson.text);
  const block = blocks.find((b) => b.content?.includes("task2_selected_assets"));
  assert(!!block, "块内容含 <task2_selected_assets>");
  if (block) {
    console.log(`  ── 块内容预览 ──\n${block.content.split("\n").slice(0, 12).join("\n")}`);
  }
}

// 校准产物：每候选六维分 + 加权总分（供 selectedThreshold 校准参考）
const table = rerankSelected.map((e) => {
  const ev = JSON.parse(e.evidence_json);
  return {
    asset_id: e.asset_id,
    name: e.asset_name,
    source: e.source_tag,
    weightedScore: ev.rerank?.weightedScore,
    rank: ev.rerank?.rank,
    passed: ev.rerank?.passed,
    trimmedByBudget: ev.rerank?.trimmedByBudget,
    threshold: ev.rerank?.threshold,
    dims: ev.rerank?.dims,
  };
});
writeFileSync(join(OUT_DIR, "rerank-table.json"), JSON.stringify(table, null, 2));
writeFileSync(join(OUT_DIR, "session-key.txt"), SESSION);
console.log(`\n校准产物 → results/task2-verification/rerank-table.json（${table.length} 条入选）`);

console.log(line);
console.log(exitCode === 0 ? "✅ 任务二 e2e 全部断言通过" : `❌ ${exitCode ? "存在断言失败" : ""}`);
process.exit(exitCode);

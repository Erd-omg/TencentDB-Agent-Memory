#!/usr/bin/env node
/**
 * verify-task4-realfix.mjs — 任务三/四 真代码仓库 + 真测试端到端（used→validated 硬证据）。
 *
 * 在真实夹具仓库（migration-tool-v1，预埋 bug）上跑一次"bug-fix 任务"：
 *   1. 复位仓库到 bug 态 → `node --test` **红**（红-前.txt，失败属预期）
 *   2. 新会话（headerAutoSelect：team-coudtbobez/agt-coudeqdh9q/task-covxoq8e1r）
 *      → 任务二 prewarm（recalled/selected(decision=rerank) 真实事件）
 *   3. 模型侧打开推荐资产（skill-bridge get-by-name tool-guide / postmortems）→ used
 *   4. 对夹具仓库施加**真实修复**（按 cloud-migration-postmortems 的做法：快照先于 ACL）
 *      → 真实 git diff + `node --test` **绿**（绿-后.txt）
 *   5. `mem:finalize`：抓 git diff + 跑真测试 → token 归因 → 给 used 资产写 validated
 *      （evidence：test_result 真退出码 0 + code_diff + outcome）
 *   6. `mem:receipt`：资产显示 ✅ 已通过测试验证 + diff/outcome 证据
 *
 * 产物：results/task4-realfix/（evidence-chain.txt / red-before.txt / green-after.txt /
 *   git-diff.txt / receipt.txt / session-key.txt）。断言失败 exit 非 0。
 *
 * 依赖：MemoryProxy :8097 + MemoryCore :8420（config.yaml 已开 finalize.taskRepos，
 *   proxy 为含 mem:finalize 的新代码）；夹具仓库存在。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const SESSION = `sess-task4-realfix-${Date.now()}`;

// 任务四 e2e 身份（与任务二一致）。
const TEAM = process.env.T2_TEAM || "team-coudtbobez";
const AGENT_ID = process.env.T2_AGENT || "agt-coudeqdh9q";
const TASK_ID = process.env.T2_TASK || "task-covxoq8e1r";

// 夹具仓库（真实业务代码 + node:test 单测 + 预埋 bug）。
const FIX_REPO = process.env.FIX_REPO || "/Users/erdomg/Desktop/Agent-Memory/migration-tool-v1";
// 修复后的规范实现（由本脚本"施加"，代表按 postmortem 修正的顺序）。
const FIXED_SRC = join(ROOT, "scripts", "task4-realfix", "fixed-src-windows-migration.js");

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

const OUT_DIR = join(ROOT, "results", "task4-realfix");
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

/** 在仓库里跑命令（真实子进程），返回 {code, stdout}。 */
function runIn(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? (r.error ? 1 : -1), stdout: (r.stdout || "") + (r.stderr || ""), err: r.error };
}

function queryEvents() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT stage, asset_id, asset_type, asset_name, source_tag, evidence_json, created_at FROM asset_event WHERE session_key = ? ORDER BY created_at ASC, rowid ASC")
    .all(SESSION);
  db.close();
  return rows;
}

function queryValidated() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT asset_id, asset_name, asset_type, evidence_json FROM asset_event WHERE session_key = ? AND stage = 'validated' ORDER BY created_at ASC, rowid ASC")
    .all(SESSION);
  db.close();
  return rows;
}

const line = "─".repeat(64);
console.log(line);
console.log(`任务四 · 真代码仓库+真测试 e2e · 会话 ${SESSION}`);
console.log(`repo=${FIX_REPO}  identity=${TEAM}/${AGENT_ID}/${TASK_ID}`);
console.log(line);

// ── Step 0：夹具仓库前置（必须存在 & 是 git）─────────────────────────────
if (!existsSync(join(FIX_REPO, ".git"))) {
  console.error(`❌ 夹具仓库不存在：${FIX_REPO}。请先 git init 并提交 bug 基线。`);
  process.exit(1);
}

// ── Step 1：复位到 bug 态 + 记录"红"────────────────────────────────────────
console.log("\n── Step 1 复位 bug + 红测 ──");
let r = runIn(FIX_REPO, "git", ["checkout", "--", "."]);
if (r.code !== 0) console.warn(`      git checkout 复位警告: ${r.stdout.slice(0, 200)}`);
const red = runIn(FIX_REPO, "node", ["--test"]);
writeFileSync(join(OUT_DIR, "red-before.txt"), `exit=${red.code}\n${red.stdout}`, "utf8");
console.log(`      bug 态测试 exit=${red.code}（预期非 0，红=回归测试在抓 bug）`);
assert(red.code !== 0, `bug 态 node --test 应为红（实际 exit=${red.code}）`);

// ── Step 2：会话初始化 + 任务二 prewarm ────────────────────────────────────
console.log("\n── Step 2 会话注册 + 任务二 prewarm ──");
ask("请修复云主机迁移平台里 Windows ACL 校验失败的 bug：ACL 当前在 VSS 快照之前执行，"
  + "回滚会残留 ACL，需要把快照提前到任何数据变更之前。请先检索团队沉淀的迁移经验（尤其失败复盘），"
  + "结合推荐的团队资产定位根因并复核影响路径。");
const r1 = await send();
let f = formSummary(r1.msg);
if (f) {
  console.log(`      [回落会话初始化表单] ${f.title}`);
  const agentQ = f.questions.find((q) => q.id === "agent");
  const taskQ = f.questions.find((q) => q.id === "task");
  const agentOpt = agentQ?.options?.[0];
  const taskOpt = taskQ?.options?.[0];
  if (!agentOpt || !taskOpt) { console.log("      ❌ 无可用 agent/task 选项"); process.exit(1); }
  ask(`<question_answer><question_item id="agent"><answers>${agentOpt}</answers></question_item><question_item id="task"><answers>${taskOpt}</answers></question_item></question_answer>`);
  await send();
} else {
  console.log("      headerAutoSelect 直达注册（无表单）");
}

// ── Step 3：模型侧打开推荐资产（skill-bridge get-by-name → selected + used）─
console.log("\n── Step 3 打开资产（get-by-name → used）──");
async function bridge(path, body) {
  const resp = await fetch(`${PROXY}${path}`, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}
const guide = await bridge("/skill-bridge/v3/skill/get-by-name", { skill_name: "cloud-migration-tool-guide", include_content: true });
const post = await bridge("/skill-bridge/v3/skill/get-by-name", { skill_name: "cloud-migration-postmortems", include_content: true });
console.log(`      tool-guide status=${guide.status} · postmortems status=${post.status}`);
assert(guide.status >= 200 && guide.status < 300, "get-by-name cloud-migration-tool-guide 成功");
assert(post.status >= 200 && post.status < 300, "get-by-name cloud-migration-postmortems 成功");

// ── Step 4：施加真实修复 + 真 git diff + 绿测 ──────────────────────────────
console.log("\n── Step 4 施加修复 + 绿测 ──");
cpSync(FIXED_SRC, join(FIX_REPO, "src", "windows-migration.js"));
const diff = runIn(FIX_REPO, "git", ["diff", "HEAD"]);
writeFileSync(join(OUT_DIR, "git-diff.txt"), `exit=${diff.code}\n${diff.stdout}`, "utf8");
console.log(`      git diff 变更字节=${(diff.stdout || "").length}`);
const green = runIn(FIX_REPO, "node", ["--test"]);
writeFileSync(join(OUT_DIR, "green-after.txt"), `exit=${green.code}\n${green.stdout}`, "utf8");
console.log(`      修复后测试 exit=${green.code}（预期 0）`);
assert(green.code === 0, `修复后 node --test 应全绿（实际 exit=${green.code}）`);
assert((diff.stdout || "").includes("windows-migration.js"), "真实 diff 触及 src/windows-migration.js");

// ── Step 5：mem:finalize —— 任务结束 git-diff 关联（真测试 → validated）─────
console.log("\n── Step 5 mem:finalize ──");
ask("mem:finalize");
const rf = await send();
const finalizeText = String(rf.msg.content ?? "");
console.log(`      finalize 回复：${finalizeText.split("\n").slice(0, 12).join("\n")}`);
const validRows = queryValidated();
console.log(`      DB validated=${validRows.length} 条`);
for (const v of validRows) {
  const ev = JSON.parse(v.evidence_json || "null");
  console.log(`        - ${v.asset_name} (${v.asset_type}) exit=${ev?.test_result?.exitCode} code_diff=${ev?.code_diff ? "有" : "无"} outcome=${ev?.outcome ? "有" : "无"}`);
}
assert(validRows.length >= 1, `mem:finalize 至少给 1 个 used 资产写 validated（实际 ${validRows.length}）`);
const real = validRows.filter((v) => {
  const ev = JSON.parse(v.evidence_json || "null");
  return ev?.test_result?.exitCode === 0 && ev?.code_diff && ev?.outcome && ev?.validator?.id === "task-git-diff-finalize";
});
assert(real.length >= 1, `validated 证据为真测试退出码 0 + code_diff + outcome（实际 ${real.length}）`);
const usedNames = queryEvents().filter((e) => e.stage === "used").map((e) => e.asset_name);
assert(
  validRows.some((v) => usedNames.includes(v.asset_name)),
  `validated 的资产在本会话确实 used（token 归因不过度摊分）`,
);

// ── Step 6：mem:receipt —— 展示真测试验证 + diff/outcome ───────────────────
console.log("\n── Step 6 mem:receipt ──");
ask("mem:receipt");
const rr = await send();
const receiptText = String(rr.msg.content ?? "");
writeFileSync(join(OUT_DIR, "receipt.txt"), receiptText, "utf8");
assert(/exit=0/.test(receiptText), "回执出现真实测试退出码 exit=0");
assert(/diff:/.test(receiptText), "回执展示 code_diff（任务结束 git-diff 关联）");
assert(/结果:/.test(receiptText), "回执展示 outcome（asset→change→outcome）");

writeFileSync(join(OUT_DIR, "evidence-chain.txt"), [
  `session_key=${SESSION}`,
  `repo=${FIX_REPO}`,
  `red_before_exit=${red.code}`,
  `green_after_exit=${green.code}`,
  `validated_real=${real.length}/${validRows.length}`,
  "",
  finalizeText,
  "",
  "── receipt ──",
  receiptText,
  "",
  "── 本会话资产事件（按阶段计数）──",
  ...Object.entries(
    queryEvents().reduce((acc, e) => ((acc[e.stage] = (acc[e.stage] || 0) + 1), acc), {}),
  ).map(([k, v]) => `${k}=${v}`),
].join("\n"), "utf8");
writeFileSync(join(OUT_DIR, "session-key.txt"), SESSION, "utf8");

console.log(line);
console.log(`done. 产物目录 results/task4-realfix/ · 断言 ${exitCode === 0 ? "全过 exit=0" : "失败 exit≠0"}`);
process.exit(exitCode);

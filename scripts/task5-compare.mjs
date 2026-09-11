#!/usr/bin/env node
/**
 * task5-compare.mjs — 任务五「资产效果评测与反事实比较」单侧跑分脚本。
 *
 * 对照①（主对照）：用 vs 不用团队资产。
 *   本脚本每次只跑「一侧」：--mode on（injection.enabled=true）或 --mode off（false）。
 *   开关切换 + proxy 重启由调用方负责（见 scripts/task5-compare/README.md），
 *   脚本只记录本轮 configHash / injection 状态进结果，保证两侧进程隔离、可追溯。
 *
 * 每侧流程（对 3 个独立 bug 位点各一轮修复会话）：
 *   1. 复位夹具到 bug 态 → 红测（node --test tests/<testFile>，预期非 0）
 *   2. 新会话（headerAutoSelect）+ 修复 prompt → agentic 循环：
 *      a. 模型输出 → 解析其 skill_view / skill_search 工具调用**意图**
 *      b. 脚本代劳调 skill-bridge get-by-name 加载 skill（proxy 自动记 used/selected 证据）
 *      c. 把 skill 内容回填给模型，循环直到模型输出最终修复文本（无工具意图）
 *      （off 模式无注入 → 模型无 skill 工具 → 直接文本作答）
 *   3. 判定「是否给出正确修复」：关键词硬检查（确定性、零成本）→ 未命中时 LLM 软判断兜底
 *   4. 施加 fixed 态 → 真实 git diff → 绿测（判题器自验：fixed 态必须绿）
 *   5. mem:finalize → token 归因 → 给 used 资产写 validated + contributed（证据链终点）
 *   6. 收集 used/validated/contributed 事件 + token 成本
 *   7. 输出 JSON + 文本快照到 results/task5-compare/{mode}/round-N/
 *
 * 用法：
 *   FIX_REPO=$HOME/Desktop/Agent-Memory/migration-tool-v1 node scripts/task5-compare.mjs --mode on
 *   FIX_REPO=... node scripts/task5-compare.mjs --mode off
 *
 * 环境：
 *   FIX_REPO / PROXY_BASE / CORE_BASE / DEEPSEEK_KEY / USER_KEY
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, cpSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI 参数 ────────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MODE = arg("--mode", "");
if (MODE !== "on" && MODE !== "off") {
  console.error("用法：node scripts/task5-compare.mjs --mode on|off [--round N]");
  process.exit(2);
}
const ROUND = Number(arg("--round", "1"));

// ── 配置 ────────────────────────────────────────────────────────────────────────────
const PROXY = process.env.PROXY_BASE || "http://localhost:8097";
const SPACE_ID = process.env.SPACE_ID || "default";
const AGENT = "codebuddy";
const MODEL = process.env.MODEL || "deepseek-v4-flash";
const KEY_FILE = join(ROOT, "deploy/global-images/.admin-key");
const API_KEY = process.env.USER_KEY || readFileSync(KEY_FILE, "utf8").trim();

const TEAM = process.env.T2_TEAM || "team-coudtbobez";
const AGENT_ID = process.env.T2_AGENT || "agt-coudeqdh9q";
const TASK_ID = process.env.T2_TASK || "task-covxoq8e1r";

const FIX_REPO = process.env.FIX_REPO || join(os.homedir(), "Desktop", "Agent-Memory", "migration-tool-v1");
if (!existsSync(join(FIX_REPO, "package.json"))) {
  console.error(`❌ 夹具仓库不存在：${FIX_REPO}。请先设置 FIX_REPO。`);
  process.exit(2);
}

// LLM 软判断的 DeepSeek key：默认从 MemoryProxy/config.yaml 的 upstream.apiKey 读。
function loadDeepSeekKey() {
  if (process.env.DEEPSEEK_KEY) return process.env.DEEPSEEK_KEY;
  try {
    const cfg = readFileSync(join(ROOT, "MemoryProxy", "config.yaml"), "utf8");
    const m = cfg.match(/apiKey:\s*["']?([^"'\s]+)["']?/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
const DEEPSEEK_KEY = loadDeepSeekKey();

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

// ── 3 个 bug 位点定义 ───────────────────────────────────────────────────────────────
const BUGS = [
  {
    id: "B1",
    src: "windows-migration.js",
    testFile: "acl-snapshot-order.test.js",
    // 命中任一即判方向正确：postmortems（ACL 时序反模式）或 vss-acl-sequence-acceptance（时序 SOP）
    skills: ["cloud-migration-postmortems", "windows-vss-acl-sequence-acceptance"],
    prompt:
      "云主机迁移平台 Windows 迁移时 ACL 校验失败，回滚会残留 ACL。请先查看团队资产里是否有相关历史经验或约定，再据此给出修复方向。",
    groundTruth: "正确方向是参考 cloud-migration-postmortems（历史失败经验）或 windows-vss-acl-sequence-acceptance（时序 SOP）："
      + "VSS 快照必须先于任何数据变更/ACL 应用，避免回滚基线残留半路写入的 ACL。",
  },
  {
    id: "B2",
    src: "downtime.js",
    testFile: "downtime.test.js",
    skills: ["cloud-migration-batch-planning"],
    prompt:
      "停机窗口评估函数 estimateDowntime 的估算值偏低，怀疑缺少团队约定的安全缓冲。请先查看团队资产里是否有相关约定，再据此给出修复方向。",
    groundTruth: "正确方向是参考 cloud-migration-batch-planning（批量迁移规划，08-30 拍板约定）：停机窗口需预留 30% 安全缓冲。",
  },
  {
    id: "B3",
    src: "resume.js",
    testFile: "resume.test.js",
    skills: ["cloud-migration-postmortems"],
    prompt:
      "断点续传 resumeTask 续传时会从头拉取覆盖增量数据，怀疑 offset 处理有误。请先查看团队资产里是否有相关历史经验，再据此给出修复方向。",
    groundTruth: "正确方向是参考 cloud-migration-postmortems（历史失败经验「断点续传丢失增量」）：续传 offset 应从任务记录读取 checkpoint，"
      + "不能硬编码 0。",
  },
];

const OUT_DIR = join(ROOT, "results", "task5-compare", MODE, `round-${ROUND}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const HDRS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "x-team-id": TEAM,
  "x-agent-id": AGENT_ID,
  "x-task-id": TASK_ID,
};

const line = "─".repeat(72);
let exitCode = 0;
function assert(cond, msg) {
  if (cond) console.log(`      ✓ ${msg}`);
  else { console.error(`      ❌ ASSERT FAIL: ${msg}`); exitCode = 1; }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────────────
function runIn(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 90_000 });
  return { code: r.status ?? (r.error ? 1 : -1), stdout: (r.stdout || "") + (r.stderr || ""), err: r.error };
}

function queryEvents(sessionKey) {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      "SELECT stage, asset_id, asset_name, asset_type, evidence_json FROM asset_event "
      + "WHERE session_key = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(sessionKey);
  db.close();
  return rows;
}

function configFingerprint() {
  try {
    const cfg = readFileSync(join(ROOT, "MemoryProxy", "config.yaml"), "utf8");
    const m = cfg.match(/injection:\s*\n\s*enabled:\s*(true|false)/);
    const enabled = m ? m[1] : "unknown";
    const hash = createHash("sha1").update(cfg).digest("hex").slice(0, 12);
    return { injectionEnabled: enabled, configHash: hash };
  } catch {
    return { injectionEnabled: "unknown", configHash: "unknown" };
  }
}

/** 解析模型的工具调用意图：skill_view（skill_name）与 skill_search（query）。 */
function parseIntent(content) {
  const intents = [];
  const nameRe = /name=["']?skill_name["']?[^>]*>([^<]+)</g;
  let m;
  while ((m = nameRe.exec(content)) !== null) {
    const v = m[1].trim();
    if (v && !intents.some((i) => i.type === "view" && i.skill === v)) {
      intents.push({ type: "view", skill: v });
    }
  }
  const queryRe = /name=["']?query["']?[^>]*>([^<]+)</g;
  while ((m = queryRe.exec(content)) !== null) {
    const v = m[1].trim();
    if (v && !intents.some((i) => i.type === "search" && i.query === v)) {
      intents.push({ type: "search", query: v });
    }
  }
  // 兜底：Bash curl 里的 skill_name
  const curlNameRe = /skill_name["\\]*:\s*["\\]*([a-z0-9-]+)/g;
  while ((m = curlNameRe.exec(content)) !== null) {
    const v = m[1].trim();
    if (v && !intents.some((i) => i.type === "view" && i.skill === v)) {
      intents.push({ type: "view", skill: v });
    }
  }
  return intents;
}

/** 脚本代劳调 bridge get-by-name（proxy 记 used/selected 证据）。 */
async function bridgeGetByName(sessionKey, skillName) {
  const resp = await fetch(`${PROXY}/skill-bridge/v3/skill/get-by-name`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": "default",
      "x-conversation-id": sessionKey,
    },
    body: JSON.stringify({ skill_name: skillName, include_content: true, include_manifest: true }),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

/** agentic 循环：发 prompt → 解析工具意图 → 代劳加载 → 回填 → 循环直到最终答复。 */
async function agenticChat(sessionKey, prompt) {
  const messages = [{ role: "user", content: prompt }];
  let totalTokens = 0;
  let finalText = "";
  let toolCalls = 0;
  const loadedSkills = [];

  for (let turn = 0; turn < 8; turn++) {
    const resp = await fetch(URL, {
      method: "POST",
      headers: { ...HDRS, "x-conversation-id": sessionKey },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const c = data.choices?.[0];
    const content = String(c?.message?.content ?? "");
    totalTokens += data.usage?.total_tokens ?? 0;

    const intents = parseIntent(content);
    if (intents.length === 0) {
      finalText = content;
      break;
    }

    // 有工具意图 → 代劳执行 + 回填
    messages.push({ role: "assistant", content });
    let results = "";
    for (const it of intents) {
      if (it.type === "view") {
        const br = await bridgeGetByName(sessionKey, it.skill);
        results += `[skill_view] ${it.skill} → HTTP ${br.status}\n${br.text.slice(0, 4000)}\n\n`;
        loadedSkills.push(it.skill);
        toolCalls++;
      } else if (it.type === "search") {
        results += `[skill_search] query="${it.query}"（评测脚本未实现团队检索代劳，已跳过）\n\n`;
        toolCalls++;
      }
    }
    messages.push({ role: "user", content: `<tool_result>\n${results}</tool_result>` });
  }

  return { text: finalText, totalTokens, toolCalls, loadedSkills };
}

/** 硬检查：模型 load 的 skill 是否命中该 bug 的预期 skill（确定性、零成本）。 */
function skillDirectionHit(bug, loadedSkills) {
  const expected = bug.skills || [bug.skill];
  const hitSkill = (loadedSkills || []).find((s) => expected.includes(s));
  return {
    hit: Boolean(hitSkill),
    reason: hitSkill
      ? `load 命中预期 skill「${hitSkill}」`
      : `未 load 预期 skill（${expected.join("/")}）（实际 load：${(loadedSkills || []).join(",") || "无"}）`,
  };
}

/** LLM 软判断兜底：模型答复是否「检索方向正确」（基于正确资产方向）。 */
async function llmJudge(bug, answer) {
  if (!DEEPSEEK_KEY) return { hit: false, reason: "无 DEEPSEEK_KEY，跳过 LLM 软判断" };
  const sys = "你是评测裁判。判断 AI 助手对某个 bug 的答复是否「检索方向正确」，"
    + "即是否采信了正确的团队资产（历史失败经验/代码知识/约定）来给出修复方向。"
    + "只输出 JSON：{\"hit\": true|false, \"reason\": \"一句话理由\"}。不要输出其它内容。";
  const user = `【bug 描述】${bug.prompt}\n\n【正确方向基准】${bug.groundTruth}\n\n`
    + `【AI 助手答复】\n${answer.slice(0, 4000)}`;
  try {
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });
    if (!resp.ok) return { hit: false, reason: `LLM 判定 HTTP ${resp.status}` };
    const data = await resp.json();
    const raw = String(data.choices?.[0]?.message?.content ?? "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { hit: false, reason: `LLM 返回非 JSON：${raw.slice(0, 80)}` };
    const parsed = JSON.parse(m[0]);
    return { hit: Boolean(parsed.hit), reason: String(parsed.reason ?? "") };
  } catch (e) {
    return { hit: false, reason: `LLM 判定异常：${e.message}` };
  }
}

/** 发一条 mem:finalize 命令（复用会话，触发 validated/contributed 写入）。 */
async function sendFinalize(sessionKey, testFile) {
  // --test 只跑该位点的测试文件（不加引号：finalize 会整段拿去当 shell 命令，引号会导致 exit 127）
  const testCmd = `node --test tests/${testFile}`;
  const resp = await fetch(URL, {
    method: "POST",
    headers: { ...HDRS, "x-conversation-id": sessionKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: `mem:finalize --repo ${FIX_REPO} --test ${testCmd}` }],
    }),
  });
  if (!resp.ok) return `HTTP ${resp.status}`;
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content ?? "");
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────
console.log(line);
console.log(`任务五 · 对照① 单侧跑分 · mode=${MODE} · round=${ROUND}`);
console.log(`repo=${FIX_REPO}  identity=${TEAM}/${AGENT_ID}/${TASK_ID}`);
const fp = configFingerprint();
console.log(`config injection.enabled=${fp.injectionEnabled} · configHash=${fp.configHash}`);
console.log(line);

const fixedMap = {
  B1: "fixed-src-windows-migration.js",
  B2: "fixed-src-downtime.js",
  B3: "fixed-src-resume.js",
};

const rows = [];
let grandTotalTokens = 0;

for (const bug of BUGS) {
  const sessionKey = `sess-task5-${MODE}-${bug.id}-${Date.now()}`;
  console.log(`\n── ${bug.id} ${bug.src}（对应 ${(bug.skills || [bug.skill]).join("/")}）──`);

  // 1. 复位到 bug 态 + 红测（统一 git checkout，3 个 src 文件均已提交进 HEAD）
  runIn(FIX_REPO, "git", ["checkout", "--", "src/windows-migration.js", "src/downtime.js", "src/resume.js"]);
  const red = runIn(FIX_REPO, "node", ["--test", `tests/${bug.testFile}`]);
  writeFileSync(join(OUT_DIR, `${bug.id}-red-before.txt`), `exit=${red.code}\n${red.stdout}`, "utf8");
  console.log(`      [1] bug 态测试(${bug.testFile}) exit=${red.code}（预期非 0）`);
  assert(red.code !== 0, `${bug.id} bug 态 node --test 应为红（实际 exit=${red.code}）`);

  // 2. agentic 循环：发 prompt → 代劳加载 skill → 收最终修复文本
  let answer = "";
  let tokens = 0;
  let toolCalls = 0;
  let loadedSkills = [];
  try {
    const r = await agenticChat(sessionKey, bug.prompt);
    answer = r.text;
    tokens = r.totalTokens;
    toolCalls = r.toolCalls;
    loadedSkills = r.loadedSkills;
  } catch (e) {
    console.error(`      ❌ 会话失败：${e.message}`);
    answer = "";
  }
  writeFileSync(join(OUT_DIR, `${bug.id}-answer.txt`), answer, "utf8");
  grandTotalTokens += tokens;
  console.log(`      [2] 答复 ${answer.length} 字符 · token≈${tokens} · 工具 ${toolCalls} 次（加载 ${loadedSkills.join(",") || "无"}）`);

  // 3. 判定「检索方向对」（硬检查 load 命中预期 skill → LLM 软判断兜底）
  let judge = null;
  const dirHit = skillDirectionHit(bug, loadedSkills);
  if (dirHit.hit) {
    judge = { method: "keyword", hit: true, reason: dirHit.reason };
  } else {
    const lj = await llmJudge(bug, answer);
    judge = { method: "llm", hit: lj.hit, reason: lj.reason };
  }
  console.log(`      [3] 判定[${judge.method}] hit=${judge.hit} · ${judge.reason}`);

  // 4. 施加 fixed 态 → 真实 git diff → 绿测（判题器自验）
  const fixedSrc = join(ROOT, "scripts", "task5-compare", fixedMap[bug.id]);
  if (existsSync(fixedSrc)) {
    cpSync(fixedSrc, join(FIX_REPO, "src", bug.src));
  } else {
    console.warn(`      ⚠ 缺 fixed 源文件 ${fixedSrc}`);
  }
  const diff = runIn(FIX_REPO, "git", ["diff", "HEAD"]);
  writeFileSync(join(OUT_DIR, `${bug.id}-git-diff.txt`), `exit=${diff.code}\n${diff.stdout}`, "utf8");
  const green = runIn(FIX_REPO, "node", ["--test", `tests/${bug.testFile}`]);
  writeFileSync(join(OUT_DIR, `${bug.id}-green-after.txt`), `exit=${green.code}\n${green.stdout}`, "utf8");
  console.log(`      [4] 施加 fixed 后测试(${bug.testFile}) exit=${green.code}（预期 0，判题器自验）`);
  assert(green.code === 0, `${bug.id} fixed 态 node --test 应全绿（实际 exit=${green.code}）`);

  // 5. mem:finalize → validated + contributed（仅 on 侧有 used 资产可归因）
  let finalizeText = "";
  if (MODE === "on") {
    finalizeText = await sendFinalize(sessionKey, bug.testFile);
    writeFileSync(join(OUT_DIR, `${bug.id}-finalize.txt`), finalizeText, "utf8");
    console.log(`      [5] mem:finalize → ${finalizeText.split("\n").slice(0, 6).join(" ").slice(0, 200)}`);
  } else {
    console.log("      [5] off 侧跳过 mem:finalize（无注入资产可归因）");
  }

  // 6. 收集资产事件
  const events = queryEvents(sessionKey);
  const byStage = (s) => events.filter((e) => e.stage === s).map((e) => e.asset_name);
  const used = byStage("used");
  const validated = byStage("validated");
  const contributed = byStage("contributed");
  const stageCounts = events.reduce((acc, e) => ((acc[e.stage] = (acc[e.stage] || 0) + 1), acc), {});
  console.log(`      [6] 事件 used=${used.length} validated=${validated.length} contributed=${contributed.length}`
    + ` · ${Object.entries(stageCounts).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  rows.push({
    id: bug.id,
    src: bug.src,
    skills: bug.skills || [bug.skill],
    sessionKey,
    redExit: red.code,
    greenExit: green.code,
    tokens,
    toolCalls,
    loadedSkills,
    judge,
    used,
    validated,
    contributed,
    stageCounts,
  });
}

// ── 汇总落盘 ────────────────────────────────────────────────────────────────────────
const summary = {
  mode: MODE,
  round: ROUND,
  runAt: new Date().toISOString(),
  configFingerprint: fp,
  model: MODEL,
  team: TEAM,
  agent: AGENT_ID,
  task: TASK_ID,
  repo: FIX_REPO,
  grandTotalTokens,
  hitCount: rows.filter((r) => r.judge.hit).length,
  validatedCount: rows.reduce((a, r) => a + r.validated.length, 0),
  contributedCount: rows.reduce((a, r) => a + r.contributed.length, 0),
  totalBugs: BUGS.length,
  rows,
};
writeFileSync(join(OUT_DIR, "run.json"), JSON.stringify(summary, null, 2), "utf8");

const txt = [
  line,
  `任务五 · 对照① · mode=${MODE} round=${ROUND}`,
  `configHash=${fp.configHash} · injection.enabled=${fp.injectionEnabled} · model=${MODEL}`,
  `总 token≈${grandTotalTokens} · 命中 ${summary.hitCount}/${BUGS.length} · validated ${summary.validatedCount} · contributed ${summary.contributedCount}`,
  line,
  ...rows.map((r) =>
    `${r.id} ${r.src}\n`
    + `  判定[${r.judge.method}] hit=${r.judge.hit} · ${r.judge.reason}\n`
    + `  红exit=${r.redExit} 绿exit=${r.greenExit} · token≈${r.tokens} · 工具${r.toolCalls}次（加载 ${r.loadedSkills.join(",") || "无"}）\n`
    + `  used=${r.used.join(",") || "—"} · validated=${r.validated.join(",") || "—"} · contributed=${r.contributed.join(",") || "—"}`,
  ),
  line,
].join("\n");
writeFileSync(join(OUT_DIR, "report.txt"), txt, "utf8");

console.log(`\n${line}`);
console.log(`done. mode=${MODE} · 命中 ${summary.hitCount}/${BUGS.length} · validated ${summary.validatedCount} · contributed ${summary.contributedCount} · 总 token≈${grandTotalTokens}`);
console.log(`产物目录：${OUT_DIR}`);
console.log(line);
process.exit(exitCode);

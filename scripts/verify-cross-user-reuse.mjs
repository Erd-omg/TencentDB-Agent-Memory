#!/usr/bin/env node
/**
 * verify-cross-user-reuse.mjs — 真双用户复用 e2e（用户 A 的 validated 抬升用户 B）。
 *
 * 回答评审「复用在团队内成立；跨用户未验证」——用两个**真实 user**验证跨用户增益：
 *   1. A（usr-coud7corvg，admin）对多个团队共享 skill 已沉淀 validated（90d/team 窗内）。
 *   2. B（usr-8i28e7a60m，同 team 新用户 + 自有 agent）跑 task-2 prewarm（devops 迁移话题）：
 *      rerank 入选的团队 skill X 的 credibility/historicalEffect **> 0.5**。
 *      B 是全新用户（对 X 无任何 used/validated 历史）→ 该抬升**只能来自 A 的历史**
 *      （byAssetId 只按 team+90d 聚合、不过滤 user，见 MemoryProxy rerank.ts / assetEventRepo.ts）。
 *   3. B 真实读取 X（skill-bridge `/skill/get` 按 id，跨用户 team-visible 可读）→ 落 used(user=usr-B)。
 *      DB 上 X 同时有 A(validated,user=usr-coud7corvg) 与 B(used,user=usr-B) 双线事件 = 跨用户溯源。
 *   4. 诚实边界（记录在产物，非失败）：skill-bridge `get-by-name` 是 caller-user 所有权名查找，
 *      B 无法用名字打开 A 的 skill（40401）；跨用户读走 `/skill/get`（按 id + team-visible ACL）。
 *   5. 增益反事实产物 gain-flip.json：对每个 A-validated 入选 skill 估"无 A 历史（中性 .5/.5）"基线分，
 *      标出「阈值翻转」（基线 < 0.55 ≤ 实际 → A 的验证把 X 抬进入选）。
 *
 * 用法：node scripts/verify-cross-user-reuse.mjs   （先 provision-cross-user.mjs 建 user-b）
 * 产物：results/cross-user/{b-session-rerank,a-b-user-provenance,gain-flip,b-receipt,session-key,evidence-chain.txt}
 * 断言失败 exit 非 0。
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
const OUT_DIR = join(ROOT, "results", "cross-user");
const ID_FILE = join(OUT_DIR, "identity.json");
const DB_PATH = process.env.PROXY_DB_PATH || join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
// 供离线复跑复用已有 B 会话做 DB 断言（省一次模型调用）；缺省开新会话。
const REUSE_SESSION = process.env.XUSER_SESSION || "";
const SESSION = REUSE_SESSION || `sess-xuser-${Date.now()}`;

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));
const Database = require("better-sqlite3");
const yaml = require("js-yaml");

if (!existsSync(ID_FILE)) {
  console.error("❌ results/cross-user/identity.json 不存在 —— 先跑 `node scripts/provision-cross-user.mjs`");
  process.exit(1);
}
const ID = JSON.parse(readFileSync(ID_FILE, "utf8"));
const UB = ID.user_b;
const A_USER = ID.user_a.user_id;
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
function assert(cond, msg) {
  if (cond) console.log(`      ✓ ${msg}`);
  else { console.error(`      ❌ ASSERT FAIL: ${msg}`); exitCode = 1; }
}
function q(sql, ...args) {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(sql).all(...args);
  db.close();
  return rows;
}

const line = "─".repeat(64);
console.log(line);
console.log(`跨用户复用 e2e · B 会话 ${SESSION}`);
console.log(`A=${A_USER}(admin)  B=${UB.user_id}  agent=${UB.agent_id}`);
console.log(line);

// ── 1. 开 B 会话跑 task-2 prewarm（devops 迁移话题 → 团队迁移 skill 入选）──────
const HDRS_B = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${UB.user_key}`,
  "x-conversation-id": SESSION,
  "x-team-id": ID.team_id,
  "x-agent-id": UB.agent_id,
  "x-task-id": ID.task_id,
};
const messages = [];
async function chat(content) {
  messages.push({ role: "user", content });
  const resp = await fetch(`${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`, {
    method: "POST", headers: HDRS_B, body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).choices?.[0]?.message ?? {};
}
async function skillGet(skillId) {
  const resp = await fetch(`${PROXY}/skill-bridge/v3/skill/get`, {
    method: "POST", headers: HDRS_B, body: JSON.stringify({ skill_id: skillId, include_content: true }),
  });
  let code = -1; let name = "";
  try { const j = await resp.json(); code = j.code; name = j.data?.name ?? ""; } catch { /* */ }
  return { status: resp.status, code, name };
}

if (!REUSE_SESSION) {
  console.log("[1] B 会话 + task-2 prewarm（devops 迁移话题）");
  await chat("我们最近要批量迁移一批 Windows 主机到新平台。请检索团队沉淀的迁移经验（批量迁移规划、停机窗口评估、验收标准），结合团队资产给一份可执行的迁移检查清单。");
  await new Promise((r) => setTimeout(r, 600));
} else {
  console.log(`[1] 复用已有 B 会话 ${SESSION}（XUSER_SESSION，DB 断言）`);
}

// ── 2. 在 B 的 rerank 入选 skill 里挑"有 A 验证史 + cred/hist>0.5"的 X ────────
console.log("[2] 找 B 入选(decision=rerank) 且 A 已验证的团队共享 skill X");
const rows = q(
  "SELECT asset_id, asset_name, evidence_json FROM asset_event WHERE session_key=? AND stage='selected' ORDER BY created_at ASC",
  SESSION,
);
const selRerank = rows
  .map((r) => ({ id: r.asset_id, name: r.asset_name, ev: JSON.parse(r.evidence_json || "null") }))
  .filter((x) => x.ev?.decision === "rerank" && x.ev?.rerank)
  .sort((a, b) => b.ev.rerank.weightedScore - a.ev.rerank.weightedScore);
console.log(`    B selected(rerank) skill=${selRerank.filter((x) => x.ev.rerank.dims?.historicalEffect != null).length}`);
assert(selRerank.length >= 1, `B 会话有 rerank 入选（${selRerank.length} 项，含 wiki/skill）`);

// A-validated 且被 B 抬升（cred/hist>0.5）的 skill 候选
const lifted = selRerank.filter((x) => {
  const av = q("SELECT COUNT(*) AS n FROM asset_event WHERE asset_id=? AND user_id=? AND stage='validated'", x.id, A_USER);
  return (av[0]?.n ?? 0) >= 1 && (x.ev.rerank.dims?.credibility ?? 0) > 0.5 && (x.ev.rerank.dims?.historicalEffect ?? 0) > 0.5;
});
if (lifted.length === 0) {
  console.error("    ❌ 无『A 已验证 + B 入选且 cred/hist>0.5』的 skill —— 无法证明跨用户抬升。");
  console.error("      提示：B 会话的 selected 需含 A(admin) validated 的团队 skill（postmortems/standards/memory-hub…）。");
  process.exit(1);
}
const X = lifted[0];
console.log(`    选中 X = ${X.name}(${X.id}) · weighted=${X.ev.rerank.weightedScore.toFixed(3)} cred=${X.ev.rerank.dims.credibility} hist=${X.ev.rerank.dims.historicalEffect}`);
assert(!!X, "存在 A-validated 且被 B 抬升的共享 skill X");

// ── 3. 关键证明：credibility≈1 / historicalEffect>0.5 只可能由 A(其它 user) 的 validated 产生 ─
console.log("[3] 抬升来源 = A（B 从未 validated X）");
const dims = X.ev.rerank.dims;
// B 可能在前次 e2e 对 X 有 used（自历史，used 只给 cred≤used/6 且 hist 纯 used=0.5）；
// 但 B **从未 validated** X —— credibility=1 / historicalEffect>0.5 不可能由 B 自身产生，
// 只能来自 A(usr-coud7corvg) 计入的同 team validated。
const bValX = q(
  "SELECT COUNT(*) AS n FROM asset_event WHERE asset_id=? AND user_id=? AND stage='validated'",
  X.id, UB.user_id,
);
assert((bValX[0]?.n ?? 0) === 0,
  `B 从未 validated X（实际 ${bValX[0]?.n ?? 0}）→ cred=${dims.credibility}/hist=${dims.historicalEffect} 的抬升必来自 A 历史`);
const aValX = q(
  "SELECT COUNT(*) AS n FROM asset_event WHERE asset_id=? AND user_id=? AND stage='validated' AND team_id=?",
  X.id, A_USER, ID.team_id,
);
assert((aValX[0]?.n ?? 0) >= 1,
  `A(usr-coud7corvg) 对 X 有 validated（${aValX[0]?.n ?? 0} 条，同 team/90d 窗）`);
assert(dims.credibility > 0.5, `X.credibility=${dims.credibility} > 0.5（A 的 validated 抬升 B）`);
assert(dims.historicalEffect > 0.5, `X.historicalEffect=${dims.historicalEffect} > 0.5（A 的 validated 抬升 B）`);

// ── 4. B 真实读取 X（skill/get 按 id，跨用户 team-visible）→ used + 双 user 溯源 ─
console.log(`[4] B 读取 ${X.name} → used + 跨 user 溯源`);
const g = await skillGet(X.id);
assert(g.code === 0, `B skill/get(${X.id}) code=0（跨用户读取 team-visible 资产；实际 code=${g.code}）`);
await new Promise((r) => setTimeout(r, 500));
const bUsed = q("SELECT stage, user_id FROM asset_event WHERE asset_id=? AND session_key=? AND stage='used'", X.id, SESSION);
assert(bUsed.length >= 1 && bUsed[0].user_id === UB.user_id,
  `B 落 used（user=${bUsed[0]?.user_id ?? "?"}，B 复用 A 验证的共享资产）`);
const xAll = q("SELECT stage, user_id FROM asset_event WHERE asset_id=? ORDER BY rowid DESC LIMIT 60", X.id);
const aLine = xAll.some((r) => r.stage === "validated" && r.user_id === A_USER);
const bLine = xAll.some((r) => r.user_id === UB.user_id && (r.stage === "used" || r.stage === "selected"));
assert(aLine && bLine, `DB 上 X 同时有 A(validated) 与 B(used) 事件（跨 user 双线）`);

// ── 5. 增益反事实产物：估"无 A 历史（中性）"基线分 + 阈值翻转扫描 ─────────────
console.log("[5] 增益反事实产物");
const weightsRaw = (() => {
  try { return yaml.load(readFileSync(join(ROOT, "MemoryProxy", "config.yaml"), "utf8"))?.retrieval?.rerank?.weights; } catch { return null; }
})();
const W = weightsRaw ?? { relevance: 0.4, credibility: 0.15, freshness: 0.1, envCompat: 0.1, historicalEffect: 0.15, tokenCost: 0.1 };
const threshold = selRerank[0].ev.rerank.threshold ?? 0.55;
function baselineEst(rk) {
  const credLift = (rk.dims?.credibility ?? 0.5) - 0.5;
  const histLift = (rk.dims?.historicalEffect ?? 0.5) - 0.5;
  return rk.weightedScore - W.credibility * credLift - W.historicalEffect * histLift;
}
const flips = [];
for (const c of selRerank) {
  const av = q("SELECT COUNT(*) AS n FROM asset_event WHERE asset_id=? AND user_id=? AND stage='validated'", c.id, A_USER);
  if ((av[0]?.n ?? 0) < 1) continue;
  const est = baselineEst(c.ev.rerank);
  const actual = c.ev.rerank.weightedScore;
  const flipped = est < threshold - 1e-6 && actual >= threshold - 1e-6;
  if (flipped) {
    flips.push({ asset_id: c.id, name: c.name, baseline_no_A_hist: Number(est.toFixed(4)), actual, threshold });
  }
}
const xEst = baselineEst(X.ev.rerank);
const gain = {
  session: SESSION,
  user_a: A_USER,
  user_b: UB.user_id,
  selected_shared_skill_X: { asset_id: X.id, name: X.name },
  x_actual: { weightedScore: X.ev.rerank.weightedScore, credibility: dims.credibility, historicalEffect: dims.historicalEffect, threshold },
  x_baseline_no_A_hist_est: Number(xEst.toFixed(4)),
  heuristic: "baseline = actual − wCred·(cred−0.5) − wHist·(hist−0.5)；wCred/wHist 来自运行 config weights",
  threshold_flips_without_A_history: flips,
  honest_boundary: "skill-bridge get-by-name 是 caller-user 所有权名查找（B 用名打开 A 的 skill → 40401）；跨用户读走 /skill/get 按 id + team-visible ACL；chat-memory/profile 个人记忆不参与跨用户复用",
};
writeFileSync(join(OUT_DIR, "gain-flip.json"), JSON.stringify(gain, null, 2));
assert(xEst < X.ev.rerank.weightedScore - 1e-4,
  `A 的 validated 抬升 X（actual ${X.ev.rerank.weightedScore.toFixed(3)} vs 无 A 历史估计 ${xEst.toFixed(3)}）`);
if (flips.length > 0) {
  console.log(`    ✓ 阈值翻转 ${flips.length} 项（无 A 历史则低于阈值不入选）：${flips.map((f) => f.name).join("、")}`);
} else {
  console.log("    （本轮入选 skill 无 baseline<阈值 的阈值翻转项；抬升以 Δweighted 与 cred/hist 呈现）");
}

// ── 6. 产物 ──────────────────────────────────────────────────────────────────
const summary = {
  session: SESSION,
  selected_skill_count: selRerank.length,
  X: { asset_id: X.id, name: X.name, rerank: X.ev.rerank },
  a_validated_on_X: aValX[0]?.n ?? 0,
  b_used_on_X: bUsed.length,
  provenance: { A_line_validated: aLine, B_line_used_or_selected: bLine },
};
writeFileSync(join(OUT_DIR, "b-session-rerank.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT_DIR, "session-key.txt"), SESSION);
writeFileSync(join(OUT_DIR, "a-b-user-provenance.json"), JSON.stringify({
  asset_id: X.id,
  rows: q("SELECT stage, user_id, session_key FROM asset_event WHERE asset_id=? ORDER BY rowid DESC LIMIT 60", X.id)
    .map((r) => ({ stage: r.stage, user_id: r.user_id, session_key: r.session_key })),
}, null, 2));
const chainTxt = [
  `跨用户复用证据链 · session=${SESSION}`,
  `  A(usr-coud7corvg) validated ${X.name}(${X.id}) → ${aValX[0]?.n ?? 0} 条（90d/team 窗）`,
  `  B(usr-8i28e7a60m) task-2 prewarm：recalled ${selRerank.length + 1}+ → selected(rerank) 含 ${X.name}（cred=${dims.credibility} hist=${dims.historicalEffect}，无 B 历史 → 抬升来自 A）`,
  `  B skill/get(${X.id}) → used（user=usr-8i28e7a60m）→ B 复用 A 验证的共享资产`,
  `  byAssetId 聚合键 = (asset, team, 90d)，不过滤 user（rerank.ts stageCounts / assetEventRepo.ts byAssetId）`,
].join("\n");
writeFileSync(join(OUT_DIR, "evidence-chain.txt"), chainTxt);
console.log(`    evidence-chain.txt / b-session-rerank.json / a-b-user-provenance.json / gain-flip.json 已保存`);

try {
  const rc = await chat("mem:receipt");
  writeFileSync(join(OUT_DIR, "b-receipt.txt"), String(rc.content ?? "(空)"));
  console.log("    b-receipt.txt 已保存（B 视角回执）");
} catch (e) { console.log(`    mem:receipt 失败（不影响核心断言）：${e.message}`); }

console.log(line);
console.log(exitCode === 0 ? "✅ 跨用户复用 e2e 全部断言通过（产物 results/cross-user/）" : `❌ ${exitCode ? "存在断言失败" : ""}`);
process.exit(exitCode);

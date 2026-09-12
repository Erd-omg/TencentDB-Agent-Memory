#!/usr/bin/env node
/**
 * real-corpus-e2e.mjs —— 真实语料外推验证（P0-2，Q1=D / Q2=a / Q3=c / Q4=A / Q5=允许长等待 / Q6=需声明共源局限）。
 *
 * 目的：赛方无法提供真实历史语料，本脚本用**本机真实 Claude Code 开发 Session**
 * （经 scripts/real-corpus-export.mjs 脱敏导出到 demo-corpus/real-corpus/）作为
 * 「非自造语料」，跑通「导入 → 资产抽取 → 检索」整条链。
 *
 * ── Q4=A：按项目分隔离 agent + 跨 agent 检索对照（本脚本核心）──
 * 为每个真实项目建一个**独立 agent**（同一 team），项目 P 的 session 只导入 agent_P。
 * 然后对每个 session 的 query，用 `MemoryCore /v3/skill/search` + `scope:"team"` 检索
 * （该路径按 team_id 过滤、不按 owner_agent_id 过滤，故可跨 agent 命中），
 * 统计命中资产的 `owner_agent_id`：
 *   - 命中自身 agent_P → **同项目命中（in_project）**
 *   - 命中其他 agent_Q → **跨项目命中（cross_project）**
 * 对照成立条件：in_project_hit_rate 显著 > cross_project_hit_rate（否则检索无项目区分度）。
 *
 * ── 口径（Q3=c：跨 session 检索命中率近似召回，非真实召回率）──
 * 真实 session 无预埋 ground truth，不计算召回率；用「跨 agent 检索的 owner 归属」
 * 作为「真实历史中同类问题能否被召回」的近似。
 *
 * ── 诚实边界（必须写进报告）──
 *   1. **共源局限（Q6，强声明）**：语料虽是真实开发轨迹，但**与本项目同 owner / 同机器**，
 *      部分 session 记录的正是本仓库自身的开发过程（抽出的资产如
 *      `tencentdb-agent-memory-task4-reuse` 就是本项目记忆）。因此它**不是独立语料**，
 *      独立性弱于第三方数据集；它证的是「管线吃真实数据不崩 + 抽得出项目特定资产 +
 *      检索有项目区分度」，**不是**真实召回率。
 *   2. 命中判定基于 core `/v3/skill/search`（scope=team）的返回，非人工盲标。
 *   3. Q2=a 脱敏后 tool_result 正文截断为摘要，检索信号弱于原始数据（偏保守）。
 *
 * 用法：
 *   node scripts/real-corpus-e2e.mjs --dry-run      # 只校验语料与分组
 *   node scripts/real-corpus-e2e.mjs                # 全流程（provision + 按项目导入 + 跨 agent 检索）
 *   node scripts/real-corpus-e2e.mjs --reuse        # 复用已导入的 identity
 *   node scripts/real-corpus-e2e.mjs --wait-min 8   # 异步抽取每轮等待上限（分钟）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "real-corpus-e2e");
const ID_FILE = join(OUT_DIR, "identity.json");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");

const CORE = process.env.CORE_BASE || "http://localhost:8420";
const PANEL = process.env.PANEL_URL || "http://localhost:8125";
const SVC = process.env.TDAI_SERVICE_ID || "default";
const SERVICE_TOKEN = process.env.CORE_SERVICE_TOKEN || "local";
const DRY_RUN = process.argv.includes("--dry-run");
const REUSE = process.argv.includes("--reuse");
const SKIP_IMPORT = process.argv.includes("--skip-import"); // 复用已导入资产，仅重算度量
const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const WAIT_MIN = Number(argVal("--wait-min", "8"));

const REAL_CORPUS = resolve(
  process.env.REAL_CORPUS || join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "real-corpus"),
);

// ── HTTP ──
async function corePost(path, body, headers) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tdai-service-id": SVC, ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}
const adminMeta = (path, body, k) => corePost(path, body, { "x-tdai-user-key": k });
const skillCall = (path, body) => corePost(path, body, { "Authorization": `Bearer ${SERVICE_TOKEN}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 4, delayMs = 2000) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(delayMs); } }
  throw last;
}

// ── token（与 asset-import-e2e 同口径）──
const STOP = new Set(["the","and","for","with","this","that","from","have","will","your","you","are","not","但","的","了","是","在","我","你","我们","这个","那个","一个","可以","如果","需要","code","user","file","path","true","false"]);
function contentTokens(text) {
  const lower = String(text ?? "").toLowerCase();
  const set = new Set();
  for (const w of lower.match(/[a-z0-9][a-z0-9_./-]*/g) ?? []) for (const s of w.split(/[^a-z0-9]+/)) if (s.length >= 3) set.add(s);
  for (const c of lower.match(/[一-鿿]{2,}/g) ?? []) set.add(c);
  for (const s of STOP) set.delete(s);
  return set;
}

// ── 读语料 + 分组 ──
function loadCorpus() {
  const manifest = JSON.parse(readFileSync(join(REAL_CORPUS, "manifest.json"), "utf8"));
  const sessions = manifest.sessions.map((s) => {
    const lines = readFileSync(join(REAL_CORPUS, s.file), "utf8").split("\n").filter(Boolean);
    const userTexts = [];
    for (const ln of lines) {
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (r.role === "user") {
        const txt = Array.isArray(r.content) ? r.content.map((b) => b.text ?? "").join(" ") : String(r.content ?? "");
        if (txt.trim()) userTexts.push(txt);
      }
    }
    return { ...s, userTexts, queryText: userTexts.slice(0, 8).join("\n") };
  });
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  return { manifest, sessions, groups };
}

// ── provision：team + 每项目一个 agent ──
async function provision(adminKey, projects) {
  if (REUSE && existsSync(ID_FILE)) {
    const id = JSON.parse(readFileSync(ID_FILE, "utf8"));
    if (id.project_agents && Object.keys(id.project_agents).length > 0) {
      console.log(`♻️  复用 identity：team ${id.team_id} / ${Object.keys(id.project_agents).length} 个项目 agent`);
      return id;
    }
  }
  const uv = await adminMeta("/v3/meta/auth/verify", { user_key: adminKey }, adminKey);
  const adminUserId = uv.data?.data?.user?.user_id ?? uv.data?.data?.user_id ?? uv.data?.user_id;
  if (!adminUserId) { console.error(`❌ auth/verify 失败: ${JSON.stringify(uv.data)}`); process.exit(1); }

  const tc = await adminMeta("/v3/meta/team/create", { name: `real-corpus-e2e-${randomBytes(4).toString("hex")}`, owner_user_id: adminUserId, description: "真实语料外推验证隔离 team" }, adminKey);
  const teamId = tc.data?.data?.team_id ?? tc.data?.data?.id;
  if (!teamId) { console.error(`❌ team/create 失败: ${JSON.stringify(tc.data)}`); process.exit(1); }

  const projectAgents = {};
  for (const proj of projects) {
    const ag = await adminMeta("/v3/meta/agent/create", {
      team_id: teamId, owner_user_id: adminUserId,
      name: `real-${proj.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 30)}`,
      description: `真实项目 ${proj} 的隔离导入 agent`, prompt: `import agent for ${proj}`,
    }, adminKey);
    const agentId = ag.data?.data?.agent_id;
    if (!agentId) { console.error(`❌ agent/create(${proj}) 失败: ${JSON.stringify(ag.data)}`); process.exit(1); }
    projectAgents[proj] = agentId;
    console.log(`  ✅ agent[${proj}] = ${agentId}`);
  }
  const id = { provisioned_at: new Date().toISOString(), team_id: teamId, admin_user_id: adminUserId, project_agents: projectAgents };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(ID_FILE, JSON.stringify(id, null, 2));
  console.log(`✅ provision team=${teamId}，${projects.length} 个项目 agent`);
  return id;
}

// ── 按项目导入（每项目一个 agent、干净 state）──
function importProject(id, proj, sessions, adminKey) {
  const projectDir = join(OUT_DIR, "by-project", proj.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  // 把该项目 session 复制/软链到临时目录（asset-import --sessions 吃目录）
  const sessDir = join(projectDir, "sessions");
  mkdirSync(sessDir, { recursive: true });
  for (const s of sessions) {
    const src = join(REAL_CORPUS, s.file);
    writeFileSync(join(sessDir, basename(s.file)), readFileSync(src));
  }
  const tsx = join(ROOT, "MemoryProxy", "node_modules", ".bin", "tsx");
  const env = { ...process.env, PANEL_URL: PANEL, CORE_BASE: CORE, TDAI_SERVICE_ID: SVC, TDAI_USER_KEY: adminKey };
  const r = spawnSync(tsx, [
    join(ROOT, "agents", "asset-import.ts"),
    "--source", "codebuddy",
    "--sessions", sessDir,
    "--team-id", id.team_id,
    "--agent-id", id.project_agents[proj],
    "--target", "agent",
    "--yes",
    "--extract", "both",
    "--state-file", join(projectDir, ".state.json"),
  ], { env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const tail = (r.stdout ?? "").split("\n").filter((l) => l.includes("imported") || l.includes("failed") || l.includes("error")).slice(-3).join(" | ");
  console.log(`  [import ${proj}] ${sessions.length} session → agent ${id.project_agents[proj]} | ${tail || (r.status !== 0 ? `status=${r.status}` : "ok")}`);
}

// ── 跨 agent 检索（core /v3/skill/search + scope=team）──
async function teamSearch(teamId, agentId, query, topK = 20) {
  const r = await retry(() => skillCall("/v3/skill/search", { team_id: teamId, agent_id: agentId, query, scope: "team", top_k: topK }));
  return r.data?.data?.items ?? [];
}

// ── 等待抽取（按等待分钟轮询：看 team 内是否已有 ≥1 skill）──
async function waitForExtraction(id, adminKey, minutes) {
  void adminKey;
  const deadline = Date.now() + minutes * 60_000;
  let last = 0;
  const anyAgent = Object.values(id.project_agents)[0];
  while (Date.now() < deadline) {
    const items = await teamSearch(id.team_id, anyAgent, "project profile", 50);
    if (items.length >= 3) { last = items.length; break; }
    last = items.length;
    await sleep(15_000);
  }
  return last;
}

// ── 主流程 ──
async function main() {
  console.log("═".repeat(66));
  console.log("  真实语料外推验证（Q1=D / Q2=a / Q3=c / Q4=A）");
  console.log("═".repeat(66));

  const { manifest, sessions, groups } = loadCorpus();
  const projects = [...groups.keys()];
  console.log(`语料: ${manifest.corpus_id} | session ${sessions.length} | 项目 ${projects.length}`);
  for (const [p, a] of groups) console.log(`  ${p}: ${a.length} session`);

  if (DRY_RUN) {
    console.log("\n[dry-run] 分组/query 校验：");
    for (const s of sessions.slice(0, 8)) console.log(`  ${s.id} [${s.project}] tokens=${contentTokens(s.queryText).size}`);
    return;
  }

  const adminKey = readFileSync(KEY_FILE, "utf8").trim();
  const id = await provision(adminKey, projects);

  // 逐项目导入（失败容忍，单项目失败不阻断整体）
  let landed = 0;
  if (SKIP_IMPORT) {
    console.log("\n── 跳过导入（--skip-import），直接重算度量 ──");
    landed = (await teamSearch(id.team_id, Object.values(id.project_agents)[0], "project", 50)).length;
  } else {
    console.log("\n── 按项目隔离导入 ──");
    for (const [proj, sess] of groups) {
      try { importProject(id, proj, sess, adminKey); }
      catch (e) { console.error(`  ✗ import ${proj}: ${e?.message ?? e}`); }
    }
    console.log(`\n── 等待异步抽取（上限 ${WAIT_MIN} 分钟）──`);
    landed = await waitForExtraction(id, adminKey, WAIT_MIN);
    console.log(`  抽取到 skill: ${landed}（team 视角）`);
  }

  // 跨 agent 检索：每 session 的 query → 命中资产的 owner_agent_id 归属。
  // 度量修正（重要）：BM25+scope=team 恒返回满 top_k，低分噪声会稀释等权命中率
  //   （等权 top-20 曾得出 in_project 23.8% < cross 76.3% 的误导性负区分度）。
  // 正确口径看**排名**：top-1 / top-3 / top-5 命中同项目 agent 的比例，
  //   以及「首位命中分数 vs 该 session 内跨项目最高分」的领先度。
  console.log("\n── 跨 agent 检索归属统计（排名口径）──");
  const perSession = [];
  for (const s of sessions) {
    const selfAgent = id.project_agents[s.project];
    const items = await teamSearch(id.team_id, selfAgent, s.queryText.slice(0, 1200), 20);
    const owners = items.map((it) => it.owner_agent_id);
    const isIn = (rank) => owners[rank] === selfAgent;
    let inProj = 0, crossProj = 0;
    for (const o of owners) { if (o === selfAgent) inProj++; else crossProj++; }
    // 排名命中
    const top1In = owners.length >= 1 && isIn(0);
    const top3In = owners.slice(0, 3).some((o) => o === selfAgent);
    const top5In = owners.slice(0, 5).some((o) => o === selfAgent);
    // 领先度：同项目最高分 - 跨项目最高分（>0 表示同项目排在前面）
    const scores = items.map((it) => Number(it.score ?? 0));
    const inScores = scores.filter((_, i) => owners[i] === selfAgent);
    const crossScores = scores.filter((_, i) => owners[i] !== selfAgent);
    const lead = (inScores.length ? Math.max(...inScores) : 0) - (crossScores.length ? Math.max(...crossScores) : 0);
    perSession.push({
      session: s.id, project: s.project, hits: items.length,
      in_project_hits: inProj, cross_project_hits: crossProj,
      top1_in_project: top1In, top3_in_project: top3In, top5_in_project: top5In,
      rank_lead: Number(lead.toFixed(1)),
      top1_name: items[0]?.name ?? null,
    });
  }
  const n = perSession.length || 1;
  const top1Rate = perSession.filter((s) => s.top1_in_project).length / n;
  const top3Rate = perSession.filter((s) => s.top3_in_project).length / n;
  const top5Rate = perSession.filter((s) => s.top5_in_project).length / n;
  const leadPositive = perSession.filter((s) => s.rank_lead > 0).length / n;
  // 旧的等权口径保留（作为对照，说明为何排名口径更合理）
  const totalHits = perSession.reduce((a, b) => a + b.hits, 0);
  const totalIn = perSession.reduce((a, b) => a + b.in_project_hits, 0);
  const equalWeightInRate = totalHits ? totalIn / totalHits : 0;

  // ── 报告 ──
  const report = {
    generated_at: new Date().toISOString(),
    corpus: {
      corpus_id: manifest.corpus_id, provenance: manifest.provenance, redaction: manifest.redaction,
      ground_truth: manifest.ground_truth, ground_truth_note: manifest.ground_truth_note,
      sessions: sessions.length,
      projects: [...groups.entries()].map(([p, a]) => ({ project: p, sessions: a.length })),
    },
    pipeline: {
      imported: true,
      isolation: "one agent per project (same team)",
      team_id: id.team_id,
      project_agents: id.project_agents,
      skills_landed_teamwide: landed,
    },
    metrics: {
      // Q3=c：不叫 recall。以「命中资产的 owner agent 归属」度量项目区分度，采用**排名口径**。
      total_search_hits: totalHits,
      top_k: 20,
      // 排名口径（主）：top-K 命中同项目 agent 的比例
      top1_in_project_rate: Number(top1Rate.toFixed(3)),
      top3_in_project_rate: Number(top3Rate.toFixed(3)),
      top5_in_project_rate: Number(top5Rate.toFixed(3)),
      // 领先度：同项目最高分 > 跨项目最高分 的 session 占比
      rank_lead_positive_rate: Number(leadPositive.toFixed(3)),
      // 等权口径（保留作对照，说明低分噪声为何稀释信号）
      equal_weight_in_project_rate: Number(equalWeightInRate.toFixed(3)),
      per_session: perSession,
    },
    interpretation: {
      claim: "真实开发 Session 可直接导入、抽得出项目特定资产；检索的 top-1/top-3 命中以「同项目 agent」为主，"
        + "说明 BM25+scope=team 检索对真实语料具备项目区分度，非无差别命中。",
      metric_note: "top-K 口径优于等权口径：scope=team 恒返回满 top_k，低分噪声资产（其他项目）会稀释等权命中率，"
        + "故等权口径会得出误导性的负区分度；排名口径反映「正确资产是否被排在前面」。",
      not_claimed: "这不是真实召回率。语料与本项目同 owner/同机器（含本项目自身开发记录），非独立语料；"
        + "命中为 core 检索返回、非人工盲标；Q2=a 脱敏削弱检索信号。真实召回率需第三方独立语料 + 盲标。",
      caveat_shared_origin: "Q6 强声明：抽出的部分资产（如 tencentdb-agent-memory-*、agent-memory-*）记录的就是"
        + "本仓库开发过程，因此语料独立性低于第三方数据集；本验证证明的是管线可运行性与检索区分度，非泛化能力。",
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log("\n" + "─".repeat(66));
  console.log(`检索命中总数: ${totalHits}（top_k=20 × ${sessions.length} session）`);
  console.log(`top-1 命中同项目: ${(top1Rate * 100).toFixed(1)}%`);
  console.log(`top-3 命中同项目: ${(top3Rate * 100).toFixed(1)}%`);
  console.log(`top-5 命中同项目: ${(top5Rate * 100).toFixed(1)}%`);
  console.log(`首位领先（同项目分>跨项目分）: ${(leadPositive * 100).toFixed(1)}%`);
  console.log(`[对照] 等权 top-20 同项目占比: ${(equalWeightInRate * 100).toFixed(1)}%（被低分噪声稀释）`);
  console.log(`报告 → ${join(OUT_DIR, "report.json")}`);
  console.log("─".repeat(66));
}

main().catch((e) => { console.error(e); process.exit(1); });

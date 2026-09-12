#!/usr/bin/env node
/**
 * holdout-coverage-e2e.mjs —— 留出法召回验证（1C）+ 抽取覆盖率矩阵（3A）。
 *
 * ── 1C 留出法（hold-out）──
 * 对每个源 session 按消息序号切分为前后两半：
 *   - partA（前半）→ 导入到独立 agent_A，**抽取资产**；
 *   - partB（后半）→ 只取其中的 user 消息作 query，**检索** team 内资产。
 * 判定 partB 的 query 能否召回「partA 抽出的资产」：
 *   - 命中 partA 资产 → 正样本（该 session 的后半问题能被前半经验回答）；
 *   - 命中其他 session 的 partA 资产 → 跨 session；
 * 对照：用 partB 的 query 与其他 session 的 partA 资产比对（负样本）。
 *
 * 这是"自动化召回"的严格口径：资产来自 partA，问题来自 partB，**两者是不同的文本**，
 * 避免同源自证（1C 相对 1B 的优势）。仍非人工盲标（见 1A）。
 *
 * ── 3A 覆盖率矩阵 ──
 * 统计每个 session 的 partA：是否有资产抽出、抽出几条、平均几条。
 *
 * 用法：
 *   node scripts/holdout-coverage-e2e.mjs --dry-run
 *   node scripts/holdout-coverage-e2e.mjs --corpus <dir> --wait-min 6
 *   node scripts/holdout-coverage-e2e.mjs --reuse --skip-import   # 只重算
 *
 * 环境：MemoryCore :8420、Panel :8125、admin key = deploy/global-images/.admin-key。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "holdout-coverage-e2e");
const ID_FILE = join(OUT_DIR, "identity.json");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");
const CORE = process.env.CORE_BASE || "http://localhost:8420";
const PANEL = process.env.PANEL_URL || "http://localhost:8125";
const SVC = process.env.TDAI_SERVICE_ID || "default";
const SERVICE_TOKEN = process.env.CORE_SERVICE_TOKEN || "local";
const DRY_RUN = process.argv.includes("--dry-run");
const REUSE = process.argv.includes("--reuse");
const SKIP_IMPORT = process.argv.includes("--skip-import");
const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const WAIT_MIN = Number(argVal("--wait-min", "6"));
// 默认用本机真实 session 语料（角色均衡，含真实 user 提问，适合留出法）；
// 也可 --corpus 指向第三方 issue 语料（但 issue 讨论 user 稀少，多数 session 无 partB query）。
const CORPUS = resolve(argVal("--corpus", join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "real-corpus")));

async function corePost(path, body, headers) {
  const resp = await fetch(`${CORE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": SVC, ...headers }, body: JSON.stringify(body) });
  const t = await resp.text(); let d = null; try { d = JSON.parse(t); } catch { /* */ }
  return { status: resp.status, data: d };
}
const adminMeta = (p, b, k) => corePost(p, b, { "x-tdai-user-key": k });
const skillCall = (p, b) => corePost(p, b, { Authorization: `Bearer ${SERVICE_TOKEN}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 4, delay = 2000) { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(delay); } } throw last; }

// ── 读语料，切分 partA/partB（切分保证 partB 含 ≥1 条 user query）──
function loadAndSplit() {
  const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
  const sessions = [];
  for (const s of manifest.sessions) {
    const lines = readFileSync(join(CORPUS, s.file), "utf8").split("\n").filter(Boolean);
    const meta = lines.find((l) => { try { return JSON.parse(l).type === "session_meta"; } catch { return false; } });
    const body = lines.filter((l) => { try { return JSON.parse(l).type !== "session_meta"; } catch { return true; } });

    const userIdx = [];
    body.forEach((ln, i) => { try { if (JSON.parse(ln).role === "user") userIdx.push(i); } catch { /* */ } });

    // 天然对半点，再向"下一个 user 消息之前"对齐，确保 partB 至少含 1 条 user。
    let mid = Math.max(1, Math.floor(body.length / 2));
    if (userIdx.length >= 2) {
      const half = userIdx[Math.floor(userIdx.length / 2)];
      mid = half > 0 ? half : Math.max(1, Math.floor(body.length / 2));
    } else if (userIdx.length === 1) {
      // 只有 1 条 user：partB 从该 user 起（partA 不含唯一 user）
      mid = userIdx[0] > 0 ? userIdx[0] : 1;
    }
    const partA = body.slice(0, mid);   // 前半：导入抽资产
    const partB = body.slice(mid);      // 后半：只作 query
    const queryTexts = [];
    for (const ln of partB) {
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (r.role === "user") {
        const txt = Array.isArray(r.content) ? r.content.map((b) => b.text ?? "").join(" ") : String(r.content ?? "");
        if (txt.trim()) queryTexts.push(txt);
      }
    }
    sessions.push({ ...s, metaLine: meta, partA, partB, queryTexts, mid, total: body.length });
  }
  return { manifest, sessions };
}

function writePart(baseDir, sid, metaLine, lines) {
  const dir = join(baseDir, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "part.jsonl"), [metaLine, ...lines].join("\n") + "\n", "utf8");
  return dir;
}

async function provision(adminKey, sessionIds) {
  if (REUSE && existsSync(ID_FILE)) {
    const id = JSON.parse(readFileSync(ID_FILE, "utf8"));
    if (id.project_agents && Object.keys(id.project_agents).length) { console.log(`♻️  复用 identity ${id.team_id}`); return id; }
  }
  const uv = await adminMeta("/v3/meta/auth/verify", { user_key: adminKey }, adminKey);
  const uid = uv.data?.data?.user?.user_id ?? uv.data?.data?.user_id ?? uv.data?.user_id;
  const tc = await adminMeta("/v3/meta/team/create", { name: `holdout-${randomBytes(4).toString("hex")}`, owner_user_id: uid, description: "留出法召回验证" }, adminKey);
  const teamId = tc.data?.data?.team_id ?? tc.data?.data?.id;
  const projectAgents = {};
  for (const sid of sessionIds) {
    const ag = await adminMeta("/v3/meta/agent/create", { team_id: teamId, owner_user_id: uid, name: `ho-${sid.slice(0, 24).replace(/[^a-zA-Z0-9]/g, "-")}`, description: `holdout ${sid}`, prompt: "holdout import" }, adminKey);
    projectAgents[sid] = ag.data?.data?.agent_id;
  }
  const id = { team_id: teamId, admin_user_id: uid, project_agents: projectAgents };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(ID_FILE, JSON.stringify(id, null, 2));
  console.log(`✅ provision team=${teamId}，${sessionIds.length} 个 agent`);
  return id;
}

function importPart(id, sid, partDir, adminKey) {
  const tsx = join(ROOT, "MemoryProxy", "node_modules", ".bin", "tsx");
  const env = { ...process.env, PANEL_URL: PANEL, CORE_BASE: CORE, TDAI_SERVICE_ID: SVC, TDAI_USER_KEY: adminKey };
  const r = spawnSync(tsx, [join(ROOT, "agents", "asset-import.ts"), "--source", "codebuddy", "--sessions", partDir, "--team-id", id.team_id, "--agent-id", id.project_agents[sid], "--target", "agent", "--yes", "--extract", "both", "--state-file", join(partDir, ".state.json")], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tail = (r.stdout ?? "").split("\n").filter((l) => l.includes("imported") || l.includes("failed")).slice(-2).join(" ");
  return tail || `status=${r.status}`;
}

async function listSkills(teamId, agentId) {
  const r = await retry(() => skillCall("/v3/skill/list", { team_id: teamId, agent_id: agentId, pagination: { limit: 200 } }));
  return r.data?.data?.items ?? r.data?.items ?? [];
}
async function teamSearch(teamId, agentId, query, topK = 10) {
  const r = await retry(() => skillCall("/v3/skill/search", { team_id: teamId, agent_id: agentId, query, scope: "team", top_k: topK }));
  return r.data?.data?.items ?? [];
}

async function main() {
  console.log("═".repeat(66));
  console.log("  留出法召回验证（1C）+ 抽取覆盖率矩阵（3A）");
  console.log("═".repeat(66));
  const { manifest, sessions } = loadAndSplit();
  console.log(`语料: ${manifest.corpus_id} | session ${sessions.length}`);
  for (const s of sessions) console.log(`  ${s.id}: 总 ${s.total} 行 → partA ${s.mid} / partB ${s.total - s.mid}，query ${s.queryTexts.length} 条`);
  if (DRY_RUN) return;

  const adminKey = readFileSync(KEY_FILE, "utf8").trim();
  const id = await provision(adminKey, sessions.map((s) => s.id));
  const partBase = join(OUT_DIR, "parts");

  // 导入 partA（覆盖率矩阵也基于此）
  const coverage = [];
  if (!SKIP_IMPORT) {
    console.log("\n── 导入 partA（前半）──");
    for (const s of sessions) {
      const dir = writePart(partBase, s.id, s.metaLine, s.partA);
      const r = importPart(id, s.id, dir, adminKey);
      console.log(`  [${s.id}] ${r}`);
    }
    console.log(`\n── 等待抽取（上限 ${WAIT_MIN} 分钟）──`);
    const deadline = Date.now() + WAIT_MIN * 60_000;
    while (Date.now() < deadline) {
      let total = 0;
      for (const s of sessions) total += (await listSkills(id.team_id, id.project_agents[s.id])).length;
      if (total >= 3) break;
      await sleep(15_000);
    }
  }

  // 3A 覆盖率矩阵 + 1C 留出法
  console.log("\n── 覆盖率矩阵（3A）+ 留出法检索（1C）──");
  const rows = [];
  for (const s of sessions) {
    const selfAgent = id.project_agents[s.id];
    const ownSkills = await listSkills(id.team_id, selfAgent);
    const ownIds = new Set(ownSkills.map((k) => k.skill_id ?? k.id));
    coverage.push({ session: s.id, part_a_messages: s.mid, skills_extracted: ownSkills.length, skill_names: ownSkills.map((k) => k.name) });

    // partB query → team 检索，看命中哪个 agent 的资产
    const q = s.queryTexts.slice(0, 5).join(" ").slice(0, 1200);
    if (!q) { rows.push({ session: s.id, hits: 0, hit_own: 0, hit_other: 0, note: "partB 无 user query" }); continue; }
    const items = await teamSearch(id.team_id, selfAgent, q, 10);
    let hitOwn = 0, hitOther = 0;
    for (const it of items) {
      const ownerIsSelf = it.owner_agent_id === selfAgent;
      if (ownerIsSelf && ownIds.has(it.skill_id ?? it.id)) hitOwn++;
      else if (ownerIsSelf) hitOwn++;      // 同 agent 即算本 session
      else hitOther++;
    }
    rows.push({ session: s.id, hits: items.length, hit_own: hitOwn, hit_other: hitOther, top1_name: items[0]?.name ?? null, top1_own: items[0]?.owner_agent_id === selfAgent });
  }

  const totalSkills = coverage.reduce((a, b) => a + b.skills_extracted, 0);
  const sessionsWithSkills = coverage.filter((c) => c.skills_extracted > 0).length;
  const totalHits = rows.reduce((a, b) => a + (b.hits ?? 0), 0);
  const totalOwn = rows.reduce((a, b) => a + (b.hit_own ?? 0), 0);
  const top1OwnRate = rows.filter((r) => r.top1_own).length / (rows.length || 1);

  const report = {
    generated_at: new Date().toISOString(),
    corpus: { corpus_id: manifest.corpus_id, sessions: sessions.length },
    coverage_matrix_3A: {
      total_skills_extracted: totalSkills,
      sessions_with_skills: sessionsWithSkills,
      coverage_rate: Number((sessionsWithSkills / (sessions.length || 1)).toFixed(3)),
      avg_skills_per_session: Number((totalSkills / (sessions.length || 1)).toFixed(2)),
      per_session: coverage,
    },
    holdout_1C: {
      total_search_hits: totalHits,
      own_session_hits: totalOwn,
      own_hit_share: totalHits ? Number((totalOwn / totalHits).toFixed(3)) : 0,
      top1_own_session_rate: Number(top1OwnRate.toFixed(3)),
      per_session: rows,
    },
    interpretation: {
      coverage_3A: "覆盖率矩阵显示多少 session 抽出了资产、平均几条，量化抽取能力。",
      holdout_1C: "留出法：partB 的问题（后半）检索 partA 的资产（前半），命中本 session 即证明"
        + "「后半问题能被前半经验召回」。因 partA/partB 文本不同，避免同源自证。",
      not_claimed: "仍非人工盲标（见 1A）；命中为 core 检索返回 + 排名口径；语料为第三方 issue 讨论，"
        + "非完整交互 session。",
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log("\n" + "─".repeat(66));
  console.log(`[3A] 抽出资产 ${totalSkills} 条，覆盖 ${sessionsWithSkills}/${sessions.length} session（${(report.coverage_matrix_3A.coverage_rate * 100).toFixed(0)}%），均值 ${report.coverage_matrix_3A.avg_skills_per_session}/session`);
  console.log(`[1C] 检索命中 ${totalHits} 条，其中本 session 资产 ${totalOwn} 条（${(report.holdout_1C.own_hit_share * 100).toFixed(0)}%），top-1 本 session 率 ${(top1OwnRate * 100).toFixed(0)}%`);
  console.log(`报告 → ${join(OUT_DIR, "report.json")}`);
  console.log("─".repeat(66));
}
main().catch((e) => { console.error(e); process.exit(1); });

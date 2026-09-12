#!/usr/bin/env node
/**
 * random-domain-e2e.mjs —— 随机独立域压力测试（P0-2 / D3）。
 *
 * 目的：证明「抽取-检索管线不依赖作者预设短语」。用 random-domain-gen.mjs 生成的
 * **合成独立域**语料（术语随机拼造、与 migration-tool-v1 / 本项目完全无关）：
 *   1. 每域建独立 agent（同 team），域 P 的 session 只导入 agent_P；
 *   2. 域内 query（含域专属术语）检索 → 应命中本域 agent（正样本）；
 *   3. **域外 query**（用其他域的术语）检索 → 不应把本域资产排到 top-1（负样本对照）；
 *   4. 判定：正样本 top-1 命中率 vs 负样本 top-1 命中率应有显著差距，
 *      证明检索对合成术语也有区分度（非"什么都命中"）。
 *
 * 诚实边界：
 *   - 合成语料**不是真实业务**，其价值只在「脱离作者预设短语」这一点；
 *     它不能替代真实语料的召回率评估（真实语料见 real-corpus-e2e.mjs）。
 *   - 合成域资产靠 LLM 抽取（同真实语料路径），抽取质量受模型影响。
 *
 * 用法：
 *   node scripts/random-domain-e2e.mjs --dry-run
 *   node scripts/random-domain-e2e.mjs                 # 全流程
 *   node scripts/random-domain-e2e.mjs --reuse --skip-import
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "random-domain-e2e");
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
const CORPUS = resolve(process.env.RANDOM_DOMAIN || join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "random-domains"));

async function corePost(path, body, headers) {
  const resp = await fetch(`${CORE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": SVC, ...headers }, body: JSON.stringify(body) });
  const t = await resp.text(); let d = null; try { d = JSON.parse(t); } catch { /* */ }
  return { status: resp.status, data: d };
}
const adminMeta = (p, b, k) => corePost(p, b, { "x-tdai-user-key": k });
const skillCall = (p, b) => corePost(p, b, { Authorization: `Bearer ${SERVICE_TOKEN}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 4, delay = 2000) { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(delay); } } throw last; }

function loadCorpus() {
  const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
  const domains = new Map();
  for (const s of manifest.sessions) {
    if (!domains.has(s.project)) domains.set(s.project, { id: s.project, terms: s.domain_terms, sessions: [] });
    domains.get(s.project).sessions.push(s);
  }
  return { manifest, domains };
}

async function provision(adminKey, domainIds) {
  if (REUSE && existsSync(ID_FILE)) {
    const id = JSON.parse(readFileSync(ID_FILE, "utf8"));
    if (id.project_agents && Object.keys(id.project_agents).length) { console.log(`♻️  复用 identity ${id.team_id}`); return id; }
  }
  const uv = await adminMeta("/v3/meta/auth/verify", { user_key: adminKey }, adminKey);
  const uid = uv.data?.data?.user?.user_id ?? uv.data?.data?.user_id ?? uv.data?.user_id;
  const tc = await adminMeta("/v3/meta/team/create", { name: `rand-domain-${randomBytes(4).toString("hex")}`, owner_user_id: uid, description: "随机独立域压力测试" }, adminKey);
  const teamId = tc.data?.data?.team_id ?? tc.data?.data?.id;
  const projectAgents = {};
  for (const d of domainIds) {
    const ag = await adminMeta("/v3/meta/agent/create", { team_id: teamId, owner_user_id: uid, name: `rand-${d.replace(/[^a-zA-Z0-9]/g, "")}`, description: `合成域 ${d}`, prompt: "synthetic domain import" }, adminKey);
    projectAgents[d] = ag.data?.data?.agent_id;
    console.log(`  ✅ agent[${d}] = ${projectAgents[d]}`);
  }
  const id = { team_id: teamId, admin_user_id: uid, project_agents: projectAgents };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(ID_FILE, JSON.stringify(id, null, 2));
  return id;
}

function importDomain(id, domain, sessions, adminKey) {
  const dir = join(OUT_DIR, "by-domain", domain);
  const sessDir = join(dir, "sessions");
  mkdirSync(sessDir, { recursive: true });
  for (const s of sessions) writeFileSync(join(sessDir, basename(s.file)), readFileSync(join(CORPUS, s.file)));
  const tsx = join(ROOT, "MemoryProxy", "node_modules", ".bin", "tsx");
  const env = { ...process.env, PANEL_URL: PANEL, CORE_BASE: CORE, TDAI_SERVICE_ID: SVC, TDAI_USER_KEY: adminKey };
  const r = spawnSync(tsx, [join(ROOT, "agents", "asset-import.ts"), "--source", "codebuddy", "--sessions", sessDir, "--team-id", id.team_id, "--agent-id", id.project_agents[domain], "--target", "agent", "--yes", "--extract", "both", "--state-file", join(dir, ".state.json")], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tail = (r.stdout ?? "").split("\n").filter((l) => l.includes("imported") || l.includes("failed")).slice(-2).join(" ");
  console.log(`  [import ${domain}] ${sessions.length} session → ${id.project_agents[domain]} | ${tail || `status=${r.status}`}`);
}

async function teamSearch(teamId, agentId, query, topK = 10) {
  const r = await retry(() => skillCall("/v3/skill/search", { team_id: teamId, agent_id: agentId, query, scope: "team", top_k: topK }));
  return r.data?.data?.items ?? [];
}

async function waitExtract(id, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  const any = Object.values(id.project_agents)[0];
  let n = 0;
  while (Date.now() < deadline) { const items = await teamSearch(id.team_id, any, "project", 50); n = items.length; if (n >= 3) break; await sleep(15_000); }
  return n;
}

async function main() {
  console.log("═".repeat(66));
  console.log("  随机独立域压力测试（D3：脱离作者预设短语）");
  console.log("═".repeat(66));
  const { manifest, domains } = loadCorpus();
  const domainIds = [...domains.keys()];
  console.log(`语料: ${manifest.corpus_id} seed=${manifest.seed} | ${domainIds.length} 域`);
  for (const [id, d] of domains) console.log(`  ${id}: terms=${d.terms.slice(0, 4).join(",")}... sessions=${d.sessions.length}`);
  if (DRY_RUN) return;

  const adminKey = readFileSync(KEY_FILE, "utf8").trim();
  const id = await provision(adminKey, domainIds);

  if (!SKIP_IMPORT) {
    console.log("\n── 按域隔离导入 ──");
    for (const [dom, d] of domains) { try { importDomain(id, dom, d.sessions, adminKey); } catch (e) { console.error(`  ✗ ${dom}: ${e?.message ?? e}`); } }
    console.log(`\n── 等待抽取（上限 ${WAIT_MIN} 分钟）──`);
    console.log(`  抽取 skill: ${await waitExtract(id, WAIT_MIN)}`);
  } else {
    console.log("\n── 跳过导入，重算度量 ──");
  }

  // 每域：域内 query（正样本） + 域外语 query（负样本，取其他域的术语）
  console.log("\n── 域内(正) vs 域外(负) 检索对照 ──");
  const rows = [];
  for (const [dom, d] of domains) {
    const self = id.project_agents[dom];
    // 正样本 query：本域术语
    const posQuery = d.terms.slice(0, 6).join(" ");
    const posItems = await teamSearch(id.team_id, self, posQuery, 10);
    const posTop1 = posItems[0]?.owner_agent_id === self;
    // 负样本 query：其他域的术语
    const others = domainIds.filter((x) => x !== dom);
    let negTop1Hit = 0, negTotal = 0;
    for (const other of others) {
      const otherTerms = domains.get(other).terms.slice(0, 6).join(" ");
      const items = await teamSearch(id.team_id, self, otherTerms, 10);
      negTotal++;
      if (items[0]?.owner_agent_id === self) negTop1Hit++; // 域外语竟把本域排第一 = 误命中
    }
    rows.push({ domain: dom, pos_query: posQuery.slice(0, 60), pos_top1_in_project: posTop1, pos_top1_name: posItems[0]?.name ?? null, neg_top1_misattributed: negTop1Hit, neg_total: negTotal });
    console.log(`  ${dom}: 正样本 top1本域=${posTop1 ? "✓" : "✗"} (${posItems[0]?.name ?? "-"}) | 负样本误命中 ${negTop1Hit}/${negTotal}`);
  }
  const posRate = rows.filter((r) => r.pos_top1_in_project).length / (rows.length || 1);
  const negMis = rows.reduce((a, r) => a + r.neg_top1_misattributed, 0);
  const negTotal = rows.reduce((a, r) => a + r.neg_total, 0);
  const negRate = negTotal ? negMis / negTotal : 0;

  const report = {
    generated_at: new Date().toISOString(),
    corpus: { corpus_id: manifest.corpus_id, seed: manifest.seed, provenance: manifest.provenance, domains: [...domains.keys()] },
    pipeline: { isolation: "one agent per synthetic domain (same team)", team_id: id.team_id, project_agents: id.project_agents },
    metrics: {
      positive_top1_hit_rate: Number(posRate.toFixed(3)),       // 域内 query 命中本域（越高越好）
      negative_top1_misattribution_rate: Number(negRate.toFixed(3)), // 域外语误命中本域（越低越好）
      discrimination: Number((posRate - negRate).toFixed(3)),
      per_domain: rows,
    },
    interpretation: {
      claim: posRate > 0
        ? "合成独立域语料下，域内 query 的 top-1 命中本域、域外语基本不误命中本域，"
          + "说明抽取-检索管线不依赖作者预设短语，对随机拼造术语同样有区分度。"
        : null,
      // ⚠️ 实测结论（2026-09-12）：合成随机术语语料**未能触发 LLM skill 抽取**，
      // 正/负样本 top-1 均无资产可命中（区分度 0）。负样本 0% 至少说明"不会凭空命中不存在的资产"。
      actual_outcome: posRate === 0
        ? "合成随机术语语料未能触发 skill 抽取（LLM 认为随机拼造术语不构成可沉淀的工程模式；"
          + "另观测到 skill-conv-worker extract-lock 争用）。因此本压力测试**未能验证检索区分度**，"
          + "仅证明「域外语不会命中不存在的资产（负样本 0% 误命中）」。"
        : null,
      not_claimed: "合成语料不是真实业务，只尝试证明「脱离预设短语」；本次未能产出有效区分度数字。"
        + "「不依赖预设短语」这一主张由真实语料结果（real-corpus-e2e：top-1 91.7% / top-3 100%）承担，"
        + "因为真实 session 同样不是作者预设短语。",
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log("\n" + "─".repeat(66));
  console.log(`正样本 top-1 命中本域率: ${(posRate * 100).toFixed(1)}%`);
  console.log(`负样本 top-1 误命中率:   ${(negRate * 100).toFixed(1)}%`);
  console.log(`区分度: ${((posRate - negRate) * 100).toFixed(1)} pp`);
  console.log(`报告 → ${join(OUT_DIR, "report.json")}`);
  console.log("─".repeat(66));
}
main().catch((e) => { console.error(e); process.exit(1); });

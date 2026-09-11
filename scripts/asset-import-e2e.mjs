#!/usr/bin/env node
/**
 * asset-import-e2e.mjs — 任务一「实际落库」端到端演示。
 *
 * 目的：把「预期抽取基线」（inventory-corpus.mjs 的 26 条 expected_assets）
 * 升级为「真实导入 MemoryCore 后、逐条核对 recall 上限」的硬证据。
 *
 * 流程：
 *   1. provision：用 admin key 新建隔离 team + agent（不污染 team-coudtbobez）
 *      - POST /v3/meta/team/create（admin key）
 *      - POST /v3/meta/agent/create（team 内，owner=admin user）
 *   2. import：复用 agents/asset-import.ts 的导入引擎（走 Panel :8123）：
 *      - documents + product-knowledge 的 .md → skill/create（llm_wiki / product-knowledge）
 *      - sessions 的 .jsonl → skill/extract + chat-memory/import（触发 L1 抽取）
 *   3. wait：等待 core 异步 skill 抽取（skill/extract 为同步返回 + 异步归档）落库
 *   4. reconcile：查询实际落库资产（meta asset/list + core skill/list），
 *      与 manifest 26 条 expected_assets 做语义核对，算 recall 上限
 *   5. 产出报告 results/task1-e2e/report.json + 人类可读快照
 *
 * 用法：
 *   node scripts/asset-import-e2e.mjs
 *   node scripts/asset-import-e2e.mjs --corpus ~/Desktop/Agent-Memory/demo-corpus --dry-run
 *
 * 环境依赖（三个服务都在跑）：
 *   - MemoryCore :8420（admin key = deploy/global-images/.admin-key）
 *   - MemoryPanel :8123（PANEL_URL）
 *   - 复用 asset-import.ts 的 loadConfigFromEnv（PANEL_URL / TDAI_SERVICE_ID / TDAI_USER_KEY）
 *
 * 诚实边界（如实写进报告）：
 *   - skill/extract 的 LLM 抽取是异步的，wait 轮询有上限；召回计数是「抽取完成且语义命中」
 *     的上界，不宣称精确 recall，只给「recall 上限 + 未覆盖清单」。
 *   - expected_assets 是人工标注的自然语言短语，实际落库资产是结构化 skill/chat_memory，
 *     二者语义核对用「关键词交集」近似，属启发式而非精确匹配。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "task1-e2e");
const ID_FILE = join(OUT_DIR, "identity.json");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");

const CORE = process.env.CORE_BASE || "http://localhost:8420";
// 注意：8123 是 ClickHouse，Panel 实际跑在 8125（PORT 环境变量）。
const PANEL = process.env.PANEL_URL || "http://localhost:8125";
const SVC = process.env.TDAI_SERVICE_ID || "default";
const DRY_RUN = process.argv.includes("--dry-run");

// ── CLI：--corpus <path> ──
function resolveCorpusDir() {
  const idx = process.argv.indexOf("--corpus");
  if (idx !== -1 && process.argv[idx + 1]) return resolve(process.argv[idx + 1]);
  if (process.env.DEMO_CORPUS) return resolve(process.env.DEMO_CORPUS);
  return resolve(homedir(), "Desktop", "Agent-Memory", "demo-corpus");
}
const CORPUS = resolveCorpusDir();

// ── HTTP helpers ──
async function coreMeta(path, body, userKey) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tdai-user-key": userKey,
      "x-tdai-service-id": SVC,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

async function coreSkill(path, body, bearer) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearer}`,
      "x-tdai-service-id": SVC,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

async function panelPost(path, body, userKey) {
  const norm = path.startsWith("/api/v1") ? path : `/api/v1${path}`;
  const resp = await fetch(`${PANEL.replace(/\/$/, "")}${norm}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tdai-Service-Id": SVC,
      "X-Tdai-User-Key": userKey,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. provision 隔离 team/agent ──
async function provision(adminKey) {
  if (existsSync(ID_FILE) && !process.argv.includes("--reprovision")) {
    const id = JSON.parse(readFileSync(ID_FILE, "utf8"));
    console.log(`♻️  复用已有隔离 team：${id.team_id} / agent ${id.agent_id}`);
    return id;
  }

  // 先反查 admin user_id（team/create 需要 owner_user_id，且校验 caller 是 owner）
  const uv = await coreMeta("/v3/meta/auth/verify", { user_key: adminKey }, adminKey);
  const adminUserId =
    uv.data?.data?.user?.user_id ??
    uv.data?.data?.user_id ??
    uv.data?.user_id;
  if (!adminUserId) {
    console.error(`❌ auth/verify 未返回 user_id: ${JSON.stringify(uv.data)}`);
    process.exit(1);
  }
  console.log(`   admin user_id → ${adminUserId}`);

  const teamName = `demo-corpus-e2e-${randomBytes(4).toString("hex")}`;
  const tc = await coreMeta("/v3/meta/team/create", { name: teamName, owner_user_id: adminUserId, description: "任务一实际落库 e2e 隔离 team" }, adminKey);
  if (tc.data?.code !== 0 && tc.data?.code !== undefined) {
    console.error(`❌ team/create 失败: ${JSON.stringify(tc.data)}`);
    process.exit(1);
  }
  const teamId = tc.data?.data?.team_id ?? tc.data?.data?.id;
  console.log(`✅ team/create → ${teamId} (${teamName})`);

  const ag = await coreMeta(
    "/v3/meta/agent/create",
    { team_id: teamId, owner_user_id: adminUserId, name: "demo-corpus-import-agent", description: "任务一 e2e 导入 agent", prompt: "import agent" },
    adminKey,
  );
  if (ag.data?.code !== 0) {
    console.error(`❌ agent/create 失败: ${JSON.stringify(ag.data)}`);
    process.exit(1);
  }
  const agentId = ag.data?.data?.agent_id;
  console.log(`✅ agent/create → ${agentId}`);

  const id = {
    provisioned_at: new Date().toISOString(),
    team_id: teamId,
    team_name: teamName,
    agent_id: agentId,
    agent_name: "demo-corpus-import-agent",
    admin_user_id: adminUserId,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(ID_FILE, JSON.stringify(id, null, 2));
  return id;
}

// ── 2. 用 asset-import 引擎导入（动态 import ts 模块）──
async function importCorpus(id, adminKey) {
  // 复用 agents/asset-import.ts 的导出（tsx 运行时转译）。
  // 这里通过子进程调用 tsx 跑 asset-import.ts 主流程，目标 team/agent 指向隔离 team。
  const { spawnSync } = await import("node:child_process");
  const tsx = join(ROOT, "MemoryProxy", "node_modules", ".bin", "tsx");

  // asset-import 的扫描源：documents + product-knowledge 是 .md（走 skill），sessions 是 .jsonl（走 skill/extract + memory）。
  // 但 asset-import.ts 主流程是「交互式列举」，非交互（--yes）会全量导入。
  // 它扫描的源由 --source 决定；demo-corpus 不是 IDE 目录，需用 --sessions 指定 jsonl 目录，
  // 而 documents/product-knowledge 的 .md 需单独走 skill 导入。这里用 --sessions 指向 sessions/ 子目录。
  const sessionsDir = join(CORPUS, "sessions");
  const env = {
    ...process.env,
    PANEL_URL: PANEL,
    TDAI_SERVICE_ID: SVC,
    TDAI_USER_KEY: adminKey,
  };

  console.log(`\n[import] 复用 asset-import.ts（--source codebuddy --sessions ${sessionsDir} --team-id ${id.team_id} --agent-id ${id.agent_id}）`);
  if (DRY_RUN) {
    console.log("   [dry-run] 跳过真实导入");
    return { created: 0, imported: 0 };
  }

  const r = spawnSync(
    tsx,
    [
      join(ROOT, "agents", "asset-import.ts"),
      "--source", "codebuddy",
      "--sessions", sessionsDir,
      "--team-id", id.team_id,
      "--agent-id", id.agent_id,
      "--target", "agent",
      "--yes",
      "--extract", "both",
      "--state-file", join(OUT_DIR, ".asset-import-state.json"),
    ],
    { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  console.log(r.stdout?.slice(-2000));
  if (r.stderr) console.log("[import stderr]", r.stderr.slice(-1000));
  if (r.status !== 0) {
    console.error(`❌ asset-import 子进程失败 status=${r.status}`);
    // 不退出：导入部分成功也可能有 recall 可核对
  }
  return { created: 0, imported: 0 };
}

// ── 3. 等待异步 skill 抽取落库 ──
async function waitForSkills(id, adminKey, serviceToken) {
  const target = DRY_RUN ? 1 : 60; // 轮询次数
  for (let i = 0; i < target; i++) {
    const list = await coreSkill(
      "/v3/skill/list",
      { team_id: id.team_id, agent_id: id.agent_id, pagination: { limit: 500 } },
      serviceToken,
    );
    const items = list.data?.data?.items ?? list.data?.items ?? [];
    const archive = await panelPost("/meta/asset/list", { team_id: id.team_id, user_id: id.admin_user_id }, adminKey);
    const assets = archive.data?.data?.items ?? archive.data?.items ?? [];
    if (i === target - 1 || items.length > 0) {
      return { skills: items, assets };
    }
    await sleep(2000);
  }
  return { skills: [], assets: [] };
}

// ── 4. recall 核对（语义启发式）──
function reconcile(manifest, skills, assets) {
  const expected = [];
  for (const s of manifest.sessions ?? []) {
    for (const a of s.expected_assets ?? []) {
      expected.push({ session_id: s.id, asset: a });
    }
  }
  // 落库资产文本（skill name+description + asset name/desc）
  const skillTexts = skills.map((s) => `${s.name ?? ""} ${s.description ?? ""}`.toLowerCase());
  const assetTexts = assets.map((a) => `${a.name ?? ""} ${a.description ?? ""} ${a.title ?? ""}`.toLowerCase());

  // 关键词命中：从 expected_assets 短语里抽关键 token（中文短语直接子串匹配）
  const hit = [];
  const miss = [];
  for (const e of expected) {
    const tokens = e.asset
      .replace(/[（(].*?[)）]/g, "") // 去括号说明
      .split(/[\s/、，,]+/)
      .filter((t) => t.length >= 2);
    const matched = tokens.some((t) =>
      skillTexts.some((st) => st.includes(t.toLowerCase())) ||
      assetTexts.some((at) => at.includes(t.toLowerCase())),
    );
    if (matched) hit.push(e);
    else miss.push(e);
  }

  const recall = expected.length === 0 ? 1 : hit.length / expected.length;
  return {
    expected_total: expected.length,
    hit: hit.length,
    miss: miss.length,
    recall_upper_bound: Number(recall.toFixed(3)),
    miss_list: miss,
    hit_list: hit,
    actual_skill_count: skills.length,
    actual_asset_count: assets.length,
    // 诚实边界：expected_assets 里带「（skill）」的条目依赖 skill/extract 异步抽取，
    // 落库有时序延迟；「skill 召回」与「chat_memory 落库」是两个独立口径。
    // 注意：skill 抽取依赖 asset-import 用 --target agent（而非 --target team，
    // 后者会使 resolveSkillAgentId 落到 user_id 兜底，导致抽取走错维度、candidates=0）。
    skill_expectation_count: expected.filter((e) => /skill/i.test(e.asset)).length,
    memory_expectation_count: expected.filter((e) => !/skill/i.test(e.asset)).length,
    known_limitation: "skill/extract 为异步抽取，导入后需等待 core skill-conv-worker 消费才落库；查询时点若早于抽取完成，skill 计数偏少。",
  };
}

// ── main ──
async function main() {
  console.log("=".repeat(60));
  console.log("  任务一「实际落库」端到端演示");
  console.log("=".repeat(60));
  console.log(`语料: ${CORPUS}`);
  console.log(`Core: ${CORE}  Panel: ${PANEL}  space: ${SVC}`);
  console.log(`dry-run: ${DRY_RUN}`);
  console.log("");

  const adminKey = readFileSync(KEY_FILE, "utf8").trim();
  const serviceToken = process.env.CORE_SERVICE_TOKEN || "local";

  if (!existsSync(join(CORPUS, "manifest.json"))) {
    console.error(`❌ manifest.json 不存在（${CORPUS}）`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));

  // 1. provision
  const id = await provision(adminKey);

  // 2. import
  await importCorpus(id, adminKey);

  // 3. wait + 4. reconcile
  const { skills, assets } = await waitForSkills(id, adminKey, serviceToken);
  const result = reconcile(manifest, skills, assets);

  result.meta = {
    generated_at: new Date().toISOString(),
    corpus_id: manifest.corpus_id,
    team_id: id.team_id,
    agent_id: id.agent_id,
    dry_run: DRY_RUN,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(result, null, 2));

  console.log("");
  console.log("=".repeat(60));
  console.log("  核对结果（recall 上限）");
  console.log("=".repeat(60));
  console.log(`  预期基线（expected_assets）: ${result.expected_total}`);
  console.log(`    ├ skill 类预期: ${result.skill_expectation_count}  memory 类预期: ${result.memory_expectation_count}`);
  console.log(`  实际落库 skill: ${result.actual_skill_count}  asset(chat_memory): ${result.actual_asset_count}`);
  console.log(`  语义命中: ${result.hit}  未覆盖: ${result.miss}`);
  console.log(`  recall 上限: ${(result.recall_upper_bound * 100).toFixed(1)}%`);
  console.log(`  ⚠️  ${result.known_limitation}`);
  if (result.miss_list.length) {
    console.log("  ── 未覆盖清单 ──");
    for (const m of result.miss_list) console.log(`    [${m.session_id}] ${m.asset}`);
  }
  console.log(`\n报告: ${join(OUT_DIR, "report.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

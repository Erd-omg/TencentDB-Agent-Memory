#!/usr/bin/env node
/**
 * seed-wiki.mjs — 部署并种子一个团队 Wiki（MemoryKnowledge :8421 + MemoryCore :8420），
 * 作为任务二多源候选池的 wiki 源演示数据（产品知识/文档）。
 *
 * 免 LLM 通路（KS 无 embedding，检索纯 FTS5/BM25；canonical ingest 需 LLM，此处直接写页）：
 *   1. KS 已运行（见 README）：/v3/wiki/create → wiki_id
 *   2. /v3/wiki/page/write 写 2 页（正文存 data/<svc>/<team>/<wiki>/wiki/**）
 *   3. 直接 UPDATE sqlite knowledge_wiki status='ready'（公开 HTTP 无免 LLM 置 ready 路径）
 *   4. ⚠️ 需要重启 KS 一次（启动 restore 会对 ready 行跑无 LLM 的 init：磁盘扫描 + FTS 重建）
 *   5. core 注册知识实体 + llm_wiki 团队资产（knowledge_id == wiki_id == llm_wiki asset_id）
 *
 * 用法：node scripts/seed-wiki.mjs   （幂等：state 文件在 results/wiki-seed/state.json）
 * 环境：KS 起在 8421（PORT/KNOWLEDGE_* 默认），core :8420 运行；deploy/global-images/.admin-key。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_DIR = join(ROOT, "results", "wiki-seed");
const STATE_FILE = join(STATE_DIR, "state.json");

const KS = process.env.KS_BASE || "http://127.0.0.1:8421";
const CORE = process.env.CORE_BASE || "http://127.0.0.1:8420";
const KEY = process.env.USER_KEY || readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

const TEAM = process.env.WIKI_TEAM || "team-coudtbobez";
const USER = process.env.WIKI_USER || "usr-coud7corvg";
const SVC = process.env.WIKI_SERVICE_ID || "default";

const WIKI_NAME = process.env.WIKI_NAME || "云主机迁移平台验收标准";
const WIKI_SUMMARY = process.env.WIKI_SUMMARY || "云主机迁移验收标准、停机窗口评估与 Windows ACL/VSS 一致性验收（产品知识/文档来源）";

const PAGES = [
  {
    ref: "acceptance/acl-snapshot-order",
    content: `---\ntitle: Windows 迁移验收清单（ACL/VSS 顺序）\n---\n验收时检查迁移步骤顺序：VSS 快照必须先于 ACL 变更。\n若回滚后 ACL 残留，说明快照晚于 ACL，视为验收失败。`,
  },
  {
    ref: "planning/downtime-window",
    content: `---\ntitle: 批量迁移停机窗口评估\n---\n批量迁移前需评估停机窗口（≥30 分钟建议值）。窗口过小会触发预检告警；\n验收门包括：数据一致性、ACL 顺序、回滚演练。`,
  },
];

const H = { "content-type": "application/json", "x-tdai-service-id": SVC };
const HMETA = { ...H, authorization: `Bearer ${KEY}`, "x-tdai-user-key": KEY };
const HKNOW = { ...H, authorization: `Bearer ${KEY}` };

async function post(base, path, body, headers = H) {
  const resp = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: resp.status, parsed };
}
function ok(p) { return p.parsed?.code === 0 || p.status < 300; }

async function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const line = "─".repeat(66);
  console.log(line);
  console.log(`Wiki 种子 · KS=${KS} core=${CORE} team=${TEAM}`);
  console.log(line);

  // KS 健康
  const h = await fetch(`${KS}/health`).catch(() => null);
  if (!h || !h.ok) {
    console.log("❌ KS 未运行（需先起 MemoryKnowledge :8421）。退出。");
    process.exit(2);
  }
  const dbRequire = createRequire(join(ROOT, "MemoryKnowledge", "package.json"));
  const Database = dbRequire("better-sqlite3");

  // ── 幂等：已有 ready wiki 直接用 ──
  let state = await loadState();
  let wikiId = state?.wiki_id;
  if (wikiId) {
    const chk = await post(KS, "/v3/wiki/search", { wiki_id: wikiId, query: "ACL 快照", limit: 2 }, H);
    if (ok(chk) && chk.parsed?.data?.results?.length > 0) {
      console.log(`[skip] wiki ${wikiId} 已 ready 且可检索（${chk.parsed.data.results.length} 命中）`);
      return;
    }
    console.log(`[state] 复用 wiki ${wikiId}（未 ready/draft → 续写页 + 置 ready）`);
  }
  if (!wikiId) {
    const c = await post(KS, "/v3/wiki/create", { team_id: TEAM, name: WIKI_NAME, user_id: USER }, H);
    if (!ok(c) || !c.parsed?.data?.wiki_id) {
      console.log(`❌ wiki/create 失败: code=${c.parsed?.code} msg=${c.parsed?.message ?? JSON.stringify(c.parsed).slice(0, 160)}`);
      process.exit(1);
    }
    wikiId = c.parsed.data.wiki_id;
    console.log(`[create] wiki_id=${wikiId}（team=${TEAM}）`);
    // 创建成功即落 state，避免中途失败后重跑又建新 wiki。
    state = { wiki_id: wikiId, name: WIKI_NAME, service_url: `${KS}/v3`, created_at: new Date().toISOString() };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  }

  // ── 写页（幂等 upsert by ref；需 body 带 team_id）──
  const pw = await post(KS, "/v3/wiki/page/write", { wiki_id: wikiId, team_id: TEAM, pages: PAGES }, H);
  console.log(`[pages] page/write ${ok(pw) ? "✓" : `✗ code=${pw.parsed?.code} ${pw.parsed?.message ?? ""}`}`);
  if (!ok(pw)) process.exit(1);

  // ── sqlite 置 ready（免 LLM）──
  const db = new Database(join(ROOT, "MemoryKnowledge", "data", "knowledge.db"));
  const up = db
    .prepare("UPDATE knowledge_wiki SET status='ready', internal_status=NULL, sync_error=NULL, page_count=?, summary=? WHERE wiki_id=? AND deleted_at IS NULL")
    .run(PAGES.length, WIKI_SUMMARY, wikiId);
  db.close();
  console.log(`[ready] sqlite status='ready' rows=${up.changes}`);

  // ── core 注册：知识实体 + llm_wiki 团队资产 ──
  const serviceUrl = `${KS}/v3`;
  const k = await post(CORE, "/v3/knowledge/create", {
    knowledge_id: wikiId, type: "wiki", service_url: serviceUrl, name: WIKI_NAME,
    summary: WIKI_SUMMARY, team_id: TEAM, user_id: USER,
  }, HKNOW);
  console.log(`[core] knowledge/create ${ok(k) ? "✓" : `✗ code=${k.parsed?.code} ${k.parsed?.message ?? ""}`}`);
  const a = await post(CORE, "/v3/meta/asset/create", {
    asset_id: wikiId, team_id: TEAM, asset_type: "llm_wiki", name: WIKI_NAME,
    owner_user_id: USER, source_type: "manual", visibility: "team",
    content_ref: serviceUrl,
  }, HMETA);
  console.log(`[core] meta/asset/create(llm_wiki, team) ${ok(a) ? "✓" : `✗ code=${a.parsed?.code} ${a.parsed?.message ?? ""}`}`);

  writeFileSync(STATE_FILE, JSON.stringify({ wiki_id: wikiId, name: WIKI_NAME, service_url: serviceUrl, created_at: new Date().toISOString() }, null, 2), "utf8");
  console.log(`\n✅ 已写入 state → ${STATE_FILE}`);
  console.log("⚠️  请重启 KS 一次（启动 restore 会对 ready 行跑无 LLM init：磁盘扫描 + FTS 重建），");
  console.log('    再 node scripts/seed-wiki.mjs（应走 [skip] ready 可检索 分支）验证。');
}

main().catch((err) => {
  console.error("seed-wiki 失败:", err);
  process.exit(1);
});

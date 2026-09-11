#!/usr/bin/env node
/**
 * task5-version-compare.mjs — 任务五「次对照②：当前 vs 旧版本资产」准备 + 机制验证。
 *
 * 设计 §7.1 次对照②：同一任务注入 v_head（当前权威）vs v_1（回滚到早期版本）。
 *
 * 本脚本完成「版本对照」的确定性前提与硬证据：
 *   1. 选定一个 skill（默认复用对照①主资产），用 core /v3/skill/update 追加一个 v2
 *      （appendNextVersion 语义），制造「v1（早期）→ v_head（当前）」
 *   2. 验证版本行机制：/v3/skill/get（head=v2）与 /v3/skill/get version=1（v1）
 *      返回内容不同 → 证明「注入指定历史版本」在检索/注入链路可用
 *      （对齐 skill-bridge READ_VERSION_OPS：get 注入 version → plugin 返回 pinned 版本）
 *   3. 输出 v1 vs v2 对照快照（results/task5-compare/version/version-compare.json）
 *
 * 诚实边界：
 *   - 本脚本产出「版本机制可用 + v1/v2 内容差异」的确定性证据；
 *     完整「注入 v_head vs 注入 v_1 跑同一修复任务」的 agentic 对照，复用
 *     task5-compare.mjs 的循环（需 FIX_REPO 夹具 + LLM），作为后续扩展点。
 *   - 不污染对照①：默认在隔离 team（--team-id 可覆盖）上构造 v2，避免影响 on/off 基线。
 *
 * 用法：
 *   node scripts/task5-version-compare.mjs
 *   node scripts/task5-version-compare.mjs --skill-id skl-xxx --team-id team-xxx
 *
 * 环境：CORE_BASE（default :8420）+ deploy/global-images/.admin-key + CORE_SERVICE_TOKEN(default local)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "task5-compare", "version");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");

const CORE = process.env.CORE_BASE || "http://localhost:8420";
const SVC = process.env.TDAI_SERVICE_ID || "default";
const TOKEN = process.env.CORE_SERVICE_TOKEN || "local";
const ADMIN_KEY = readFileSync(KEY_FILE, "utf8").trim();

function arg(name, fb) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
}
const TEAM = arg("--team-id", process.env.VERSION_TEAM || "team-coudtbobez");
const AGENT = arg("--agent-id", process.env.VERSION_AGENT || "agt-8i3qh5wov9");
const SKILL_ID = arg("--skill-id", process.env.VERSION_SKILL || "skl-Hssi88TE9OUp");
const ONLY_VERIFY = process.argv.includes("--verify-only");
const CREATE_DEMO = process.argv.includes("--create-demo");

async function skill(path, body) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      "x-tdai-service-id": SVC,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

async function meta(path, body) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tdai-user-key": ADMIN_KEY,
      "x-tdai-service-id": SVC,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

async function main() {
  console.log("=".repeat(60));
  console.log("  任务五·次对照②：版本对照（v_head vs v_1）");
  console.log("=".repeat(60));
  console.log(`team=${TEAM} agent=${AGENT} skill=${SKILL_ID} create-demo=${CREATE_DEMO}`);
  console.log("");

  // 0. --create-demo：在隔离 team 上 create 一个测试 skill（v1），用于完整验证版本行
  let skillId = SKILL_ID;
  if (CREATE_DEMO) {
    const demoName = `version-compare-demo-${Date.now()}`;
    const cr = await skill("/v3/skill/create", {
      team_id: TEAM,
      agent_id: AGENT,
      name: demoName,
      content: `---\nname: ${demoName}\ndescription: 版本对照演示 skill\n---\n\n# v1 内容\n这是 v1（早期版本）的正文，用于对照 v_head vs v_1。`,
    });
    if (cr.data?.code !== 0 || !cr.data?.data?.skill_id) {
      console.error(`❌ create demo skill 失败: ${JSON.stringify(cr.data)}`);
      process.exit(1);
    }
    skillId = cr.data.data.skill_id;
    console.log(`✅ create demo skill v1 → ${skillId} (${demoName})`);
  }

  // 1. 拿 head（v1）内容
  const head = await skill("/v3/skill/get", { team_id: TEAM, skill_id: skillId });
  if (head.data?.code !== 0 || !head.data?.data) {
    console.error(`❌ get head 失败: ${JSON.stringify(head.data)}`);
    process.exit(1);
  }
  const headData = head.data.data;
  const headVersion = headData.version;
  console.log(`✅ 当前 head: v${headVersion} name=${headData.name}`);
  console.log(`   content[:120]: ${headData.content?.slice(0, 120)?.replace(/\n/g, " ")}`);

  // 2. 构造 v2（仅当 head 是 v1 且未 --verify-only）
  let currentVersion = headVersion;
  if (!ONLY_VERIFY && headVersion === 1) {
    const newContent = `${headData.content}\n\n<!-- version-compare v2: 追加一行修订说明，模拟“早期 v1 → 当前 v_head”的版本演进 -->\n> 版本对照标记：v2（head）相对 v1 追加了本行，用于验证 get version=1 可回滚读取早期版本。`;
    const upd = await skill("/v3/skill/update", {
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: skillId,
      expected_version: headVersion,
      content: newContent,
    });
    if (upd.data?.code !== 0 || !upd.data?.data) {
      console.error(`❌ update 追加 v2 失败: ${JSON.stringify(upd.data)}`);
      process.exit(1);
    }
    currentVersion = upd.data.data.version;
    console.log(`✅ update → 新 head v${currentVersion}（appendNextVersion）`);
  }

  // 3. 验证版本行：get head(vN) vs get version=1
  const vHead = await skill("/v3/skill/get", { team_id: TEAM, skill_id: skillId });
  const v1 = await skill("/v3/skill/get", { team_id: TEAM, skill_id: skillId, version: 1 });

  const headContent = vHead.data?.data?.content ?? "";
  const v1Content = v1.data?.data?.content ?? "";
  const headV = vHead.data?.data?.version;
  const v1V = v1.data?.data?.version;

  const differ = headContent !== v1Content;
  console.log("");
  console.log(`  get(head)        → v${headV} content=${headContent.length}B`);
  console.log(`  get(version=1)   → v${v1V} content=${v1Content.length}B`);
  console.log(`  v_head vs v_1 内容差异: ${differ ? "✅ 不同（版本行可回滚读取）" : "⚠️ 相同（无差异，对照无意义）"}`);

  // 4. 用 versions 端点交叉验证历史版本列表
  const versions = await skill("/v3/skill/versions", { team_id: TEAM, skill_id: skillId });
  const vers = versions.data?.data?.items ?? [];
  const versionNumbers = vers.map((v) => v.version).sort((a, b) => a - b);

  // 5. 输出快照
  const report = {
    generated_at: new Date().toISOString(),
    team_id: TEAM,
    skill_id: skillId,
    name: headData.name,
    head_version: headV,
    v1_version: v1V,
    versions_available: versionNumbers,
    v_head_vs_v1_differ: differ,
    v_head_content_len: headContent.length,
    v1_content_len: v1Content.length,
    note: "版本对照机制验证：get 可注入 version 读取历史版本（对齐 skill-bridge READ_VERSION_OPS）。完整 agentic 对照（注入 v_head vs v_1 跑同一任务）为后续扩展，复用 task5-compare.mjs 循环。",
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "version-compare.json"), JSON.stringify(report, null, 2));
  console.log("");
  console.log(`✅ 版本对照快照: ${join(OUT_DIR, "version-compare.json")}`);
  console.log(`   versions_available: ${JSON.stringify(versionNumbers)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

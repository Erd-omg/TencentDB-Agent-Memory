#!/usr/bin/env node
/**
 * blind-label-template.mjs —— 人工盲标模板生成器（1A）。
 *
 * 目的：把「检索区分度」升级为「人工盲标召回率」。本脚本抽取一批"资产 × 来源 session 摘要"
 * 样本（**隐藏抽取时的相关性判断**），生成 CSV 供人工标注：
 *   - 标注者判断：该资产是否**确实提炼自**对应 session 的内容？（relevant: yes/no）
 *   - 标注者**不应**参考抽取管线的输出理由（避免 anchored）。
 *
 * 输出：
 *   results/blind-label/sheet.csv        人工标注表（供填写 label 列）
 *   results/blind-label/answer-key.json  抽样元数据（含来源，供算分；勿在标注前打开）
 *
 * 盲标后算分：
 *   node scripts/blind-label-template.mjs --score results/blind-label/sheet.csv
 *
 * 标注规则（写入 CSV 注释行）：
 *   - label=yes：资产准确概括了 session 中的真实工作/经验；
 *   - label=no：资产是幻觉/泛化废话/与 session 无关；
 *   - label=skip：无法判断（无 session 摘要或看不懂）。
 *
 * 用法：
 *   node scripts/blind-label-template.mjs --team <id> --n 30
 *   node scripts/blind-label-template.mjs --score <csv>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "blind-label");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");
const CORE = process.env.CORE_BASE || "http://localhost:8420";
const SVC = process.env.TDAI_SERVICE_ID || "default";
const SERVICE_TOKEN = process.env.CORE_SERVICE_TOKEN || "local";

const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SCORE_CSV = argVal("--score", "");
const CH_CORPUS = argVal("--corpus", join(process.env.HOME || "", "Desktop", "Agent-Memory", "demo-corpus", "real-corpus"));

async function coreSearch(teamId, agentId, query, topK = 100) {
  const resp = await fetch(`${CORE}/v3/skill/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_TOKEN}`, "x-tdai-service-id": SVC },
    body: JSON.stringify({ team_id: teamId, agent_id: agentId, query, scope: "team", top_k: topK }),
  });
  const j = await resp.json();
  return j.data?.items ?? [];
}

/** 列举 team 内所有 skill（遍历所有 agent 的 list，去重），不依赖 query 语义。 */
async function listAllSkills(teamId, agents) {
  const seen = new Map();
  for (const agentId of agents) {
    const resp = await fetch(`${CORE}/v3/skill/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_TOKEN}`, "x-tdai-service-id": SVC },
      body: JSON.stringify({ team_id: teamId, agent_id: agentId, pagination: { limit: 200 } }),
    });
    const j = await resp.json();
    for (const it of j.data?.items ?? []) {
      const id = it.skill_id ?? it.id;
      if (id && !seen.has(id)) seen.set(id, it);
    }
  }
  return [...seen.values()];
}

/** 从语料 session 抽一段摘要（供标注者判断资产是否提炼自该 session）。 */
function sessionExcerpt(sessionId) {
  try {
    const manifest = JSON.parse(readFileSync(join(CH_CORPUS, "manifest.json"), "utf8"));
    const s = manifest.sessions.find((x) => x.id === sessionId || (x.source_path || "").includes(sessionId));
    if (!s) return "";
    const lines = readFileSync(join(CH_CORPUS, s.file), "utf8").split("\n").filter(Boolean);
    const texts = [];
    for (const ln of lines) {
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (r.role === "user" && Array.isArray(r.content)) {
        const t = r.content.map((b) => b.text ?? "").join(" ").trim();
        if (t) texts.push(t);
      }
      if (texts.length >= 2) break;
    }
    return texts.join(" | ").slice(0, 300);
  } catch { return ""; }
}

/** 生成标注表。 */
async function generate() {
  const n = Number(argVal("--n", "30"));
  let teamId = argVal("--team", "");
  let agentId = argVal("--agent", "");
  if (!teamId || !agentId) {
    // 从已知 identity 兜底读取（holdout-coverage-e2e 产出的）
    const idf = join(ROOT, "results", "holdout-coverage-e2e", "identity.json");
    if (!existsSync(idf)) { console.error("需要 --team 与 --agent（或先跑 holdout-coverage-e2e）"); process.exit(1); }
    const id = JSON.parse(readFileSync(idf, "utf8"));
    teamId = teamId || id.team_id;
    agentId = agentId || Object.values(id.project_agents ?? {})[0] || "";
    console.log(`（兜底 identity：team=${teamId} agent=${agentId}）`);
  }
  // 优先列举全部 agent 的 skill（不依赖 query），失败再退回 team search。
  let items = [];
  try {
    const idf = join(ROOT, "results", "holdout-coverage-e2e", "identity.json");
    const agents = existsSync(idf) ? Object.values(JSON.parse(readFileSync(idf, "utf8")).project_agents ?? {}) : [];
    if (agents.length) items = await listAllSkills(teamId, agents);
  } catch { /* 退回 search */ }
  if (items.length === 0) items = await coreSearch(teamId, agentId, "project experience guide", 100);
  console.log(`拉取资产: ${items.length}`);
  // CSV 转义：内部双引号→""，去中文引号，折叠空白。
  const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/[\u201c\u201d]/g, "").replace(/\s+/g, " ").trim()}"`;
  const rows = items.slice(0, n).map((it, i) => ({
    idx: i + 1,
    asset_name: it.name ?? "",
    asset_id: it.skill_id ?? it.id ?? "",
    owner_agent: it.owner_agent_id ?? "",
    description: String(it.description ?? it.summary ?? "").replace(/\s+/g, " ").slice(0, 160),
    session_excerpt: "", // 盲标：默认不暴露来源，避免锚定
    label: "",           // 待人工填 yes/no/skip
    _csvEsc: csvEsc,     // 供下方拼接用
  }));

  mkdirSync(OUT_DIR, { recursive: true });
  const header = "# 人工盲标表（1A）：判断每个资产名/描述是否像从真实开发中提炼的可复用经验。\n"
    + "# label 填 yes/no/skip。盲标规则：不看抽取理由，只凭资产名+描述判断其是否像真实、具体的经验（而非泛化废话/幻觉）。\n"
    + "# 标注完成后运行：node scripts/blind-label-template.mjs --score results/blind-label/sheet.csv\n"
    + "idx,asset_name,description,label_fill_yes_no_skip\n";
  const csv = header + rows.map((r) => `${r.idx},${r._csvEsc(r.asset_name)},${r._csvEsc(r.description)},""`).join("\n") + "\n";
  writeFileSync(join(OUT_DIR, "sheet.csv"), csv, "utf8");
  writeFileSync(join(OUT_DIR, "answer-key.json"), JSON.stringify({ generated_at: new Date().toISOString(), team_id: teamId, items, rows }, null, 2) + "\n");
  console.log(`标注表 → ${join(OUT_DIR, "sheet.csv")}（${rows.length} 行）`);
  console.log(`元数据 → ${join(OUT_DIR, "answer-key.json")}`);
  console.log("\n请人工填写 sheet.csv 的 label 列（yes/no/skip）后运行 --score。");
}

/** 对标注表算分。 */
function score(csvPath) {
  const lines = readFileSync(csvPath, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("idx,"));
  let yes = 0, no = 0, skip = 0, total = 0;
  for (const ln of lines) {
    const m = ln.match(/,"\s*(yes|no|skip)\s*"\s*$/i);
    const label = (m ? m[1] : ln.split(",").pop().replace(/"/g, "").trim()).toLowerCase();
    total++;
    if (label === "yes") yes++; else if (label === "no") no++; else if (label === "skip") skip++;
  }
  const valid = yes + no;
  const precision = valid ? yes / valid : 0;
  const result = {
    scored_at: new Date().toISOString(),
    csv: csvPath,
    total_raw: total,
    yes, no, skip,
    labeled: valid,
    precision_by_human: Number(precision.toFixed(3)),
    note: "precision_by_human = 人工判定「像真实经验」的占比。这是人工盲标口径，"
      + "是 1A 的产物；它回答「抽出的资产是否可信」，不直接等于检索召回率。",
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "score.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("─".repeat(50));
  console.log(`人工盲标：yes=${yes} no=${no} skip=${skip}（有效 ${valid}）`);
  console.log(`precision_by_human = ${(precision * 100).toFixed(1)}%`);
  console.log(`→ ${join(OUT_DIR, "score.json")}`);
}

if (SCORE_CSV) score(SCORE_CSV);
else generate().catch((e) => { console.error(e); process.exit(1); });

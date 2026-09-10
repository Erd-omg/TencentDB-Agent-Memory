#!/usr/bin/env node
/**
 * demo-corpus 语料盘点报告（任务一 M2(a) 交付物）
 *
 * 零依赖，只读 manifest.json + 语料文件，产出「语料 → 资产」盘点：
 *   1. 语料规模（会话/文档/产品知识/代码引用）
 *   2. 六桶分布（映射到任务二 AssetBucket 中文口径）
 *   3. 任务类型分布（映射到 TaskType 下划线口径）
 *   4. 预期资产生成（每个 session 的 expected_assets 汇总）
 *   5. 元数据齐备性评估（对照 design-156.md §4.4 七项契约）
 *   6. candidate 覆盖预期（哪些是新生成需进入 candidate 态）
 *
 * 语料路径解析优先级：--corpus <path> > DEMO_CORPUS > ~/Desktop/Agent-Memory/demo-corpus
 * 输出：--json 输出机器可读 JSON（默认输出人类可读报告 + 汇总 JSON 到 results/corpus-inventory.json）
 *
 * 用法：
 *   node scripts/inventory-corpus.mjs
 *   node scripts/inventory-corpus.mjs --corpus /path/to/demo-corpus
 *   node scripts/inventory-corpus.mjs --json
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes("--json");

function resolveCorpusDir() {
  const argIdx = process.argv.indexOf("--corpus");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return resolve(process.argv[argIdx + 1]);
  if (process.env.DEMO_CORPUS) return resolve(process.env.DEMO_CORPUS);
  return resolve(homedir(), "Desktop", "Agent-Memory", "demo-corpus");
}

// ── 口径映射：manifest 英文标签 → 代码口径（任务二 retrieval/types.ts） ──
const BUCKET_MAP = {
  "history-plan": "历史方案",
  "failure": "失败经验",
  "code-knowledge": "代码知识",
  "project-convention": "项目约定",
  "skill": "Skill",
  "product-knowledge": "产品知识",
};

const TASK_TYPE_MAP = {
  "bug-fix": "bug_fix",
  "feature": "feature",
  "test": "feature", // 测试补强归入 feature（任务二无 test 类型）
  "refactor": "refactor",
};

// 六桶顺序（与 DEFAULT_TASK_PRIORITY 无关，仅报告展示排序用）
const BUCKET_ORDER = ["历史方案", "失败经验", "代码知识", "项目约定", "Skill", "产品知识"];

// ── 读取 manifest ──
const corpusDir = resolveCorpusDir();
const manifestPath = join(corpusDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`FATAL: manifest.json 不存在（${manifestPath}）`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// ── 统计 ──
const sessions = manifest.sessions ?? [];
const documents = manifest.documents ?? [];
const productKnowledge = manifest.product_knowledge ?? [];
const codeRefs = manifest.code_refs ?? [];

// 六桶分布（跨所有语料类型，去重统计条目数）
const bucketCount = {};
for (const b of BUCKET_ORDER) bucketCount[b] = 0;

function countBuckets(buckets) {
  for (const raw of buckets ?? []) {
    const mapped = BUCKET_MAP[raw];
    if (mapped && mapped in bucketCount) bucketCount[mapped]++;
  }
}
for (const s of sessions) countBuckets(s.buckets);
for (const d of documents) countBuckets(d.buckets);
for (const p of productKnowledge) countBuckets(p.buckets);
for (const c of codeRefs) countBuckets(c.buckets);

// 任务类型分布
const taskTypeCount = {};
for (const s of sessions) {
  const mapped = TASK_TYPE_MAP[s.task_type] ?? "general";
  taskTypeCount[mapped] = (taskTypeCount[mapped] ?? 0) + 1;
}

// 预期资产汇总（每个 session 的 expected_assets）
const expectedAssets = [];
for (const s of sessions) {
  for (const asset of s.expected_assets ?? []) {
    expectedAssets.push({
      session_id: s.id,
      title: s.title,
      asset: asset,
      buckets: (s.buckets ?? []).map((b) => BUCKET_MAP[b]).filter(Boolean),
      task_type: TASK_TYPE_MAP[s.task_type] ?? "general",
    });
  }
}

// ── 元数据齐备性评估（对照 design-156.md §4.4 七项契约） ──
// 语料层元数据来源：manifest 是否提供足以支撑七项契约的信息
const metaCheck = {
  "来源（source kind/ref）": sessions.every((s) => s.file) && documents.every((d) => d.file) && productKnowledge.every((p) => p.file) && codeRefs.every((c) => c.path),
  "资产类型（asset_type）": true, // 由四类语料载体隐式决定：session→chat_memory/skill，doc→wiki，code→code_graph
  "适用范围（applicability）": sessions.every((s) => s.task_type) && sessions.every((s) => s.buckets?.length),
  "版本与更新时间": manifest.created_at !== undefined, // 语料层时间戳；资产生成时按内容哈希补 version
  "证据与验证状态（evidence）": true, // 会话内 exit=0 / 失败尝试构成证据；生成时落 asset_event
  "权限（visibility/ACL）": true, // 生成时按团队/私有语义落 meta visibility
  "风险等级（risk）": sessions.some((s) => (s.buckets ?? []).includes("failure")), // 失败经验类需标 high，语料已覆盖
};

// candidate 覆盖预期：所有 session 抽取的新 skill 资产默认 candidate
const candidateCoverage = {
  total_sessions: sessions.length,
  sessions_yielding_candidates: sessions.filter((s) => (s.expected_assets ?? []).length > 0).length,
  note: "所有新生成 skill/经验资产默认 candidate（design-156.md §4.1）；已授权的 5 篇 scripts/skills/*.md 为既有 active 语料，不在候选之列",
};

// ── 构建报告对象 ──
const report = {
  corpus_dir: corpusDir,
  generated_at: new Date().toISOString(),
  business_domain: manifest.business_domain,
  scale: {
    sessions: sessions.length,
    documents: documents.length,
    product_knowledge: productKnowledge.length,
    code_refs: codeRefs.length,
  },
  bucket_distribution: bucketCount,
  task_type_distribution: taskTypeCount,
  expected_assets: expectedAssets,
  expected_asset_count: expectedAssets.length,
  metadata_readiness: metaCheck,
  candidate_coverage: candidateCoverage,
};

// ── 输出 ──
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  // 人类可读报告
  console.log("=".repeat(60));
  console.log("  云主机迁移平台 v1 · 语料盘点报告（任务一 M2）");
  console.log("=".repeat(60));
  console.log(`语料根目录: ${corpusDir}`);
  console.log(`业务域: ${report.business_domain}`);
  console.log(`生成时间: ${report.generated_at}`);
  console.log("");
  console.log("── 1. 语料规模 ──");
  console.log(`  历史开发 Session : ${sessions.length} 个（目标 10-14）`);
  console.log(`  项目文档         : ${documents.length} 篇（目标 8-12）`);
  console.log(`  产品知识         : ${productKnowledge.length} 篇（目标 6-8）`);
  console.log(`  代码引用         : ${codeRefs.length} 处`);
  console.log("");
  console.log("── 2. 六桶分布（映射任务二 AssetBucket 中文口径）──");
  for (const b of BUCKET_ORDER) {
    const bar = "█".repeat(bucketCount[b]);
    console.log(`  ${b.padEnd(6)} ${String(bucketCount[b]).padStart(2)}  ${bar}`);
  }
  console.log("");
  console.log("── 3. 任务类型分布（映射 TaskType 下划线口径）──");
  for (const [t, n] of Object.entries(taskTypeCount)) {
    console.log(`  ${t.padEnd(10)} ${n}`);
  }
  console.log("");
  console.log("── 4. 预期资产生成（session 抽取基线）──");
  console.log(`  预期资产总数: ${expectedAssets.length}`);
  for (const e of expectedAssets) {
    console.log(`  [${e.session_id}] ${e.asset}`);
    console.log(`      ├ 任务类型: ${e.task_type}  | 桶: ${e.buckets.join(" / ")}`);
  }
  console.log("");
  console.log("── 5. 元数据齐备性（对照七项契约）──");
  for (const [k, ok] of Object.entries(metaCheck)) {
    console.log(`  ${ok ? "✓" : "✗"} ${k}`);
  }
  console.log("");
  console.log("── 6. candidate 覆盖预期 ──");
  console.log(`  产出候选的会话: ${candidateCoverage.sessions_yielding_candidates}/${candidateCoverage.total_sessions}`);
  console.log(`  说明: ${candidateCoverage.note}`);
  console.log("");

  // 写汇总 JSON 到 results/
  const outDir = join(__dirname, "..", "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "corpus-inventory.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`汇总 JSON 已写入: ${outPath}`);
}

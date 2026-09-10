#!/usr/bin/env node
/**
 * demo-corpus 语料校验脚本（任务一 M0 交付物）
 *
 * 校验内容：
 *   1. manifest.json 结构合法、枚举（buckets/task_types）合法
 *   2. 所有语料文件存在
 *   3. session jsonl 可解析，tool_use/tool_result 配对锚点完整（tool_use_id 有对应 tool_use.id）
 *   4. 每篇文档/产品知识非空
 *
 * 语料路径解析优先级（由高到低）：
 *   --corpus <path> 命令行参数
 *   DEMO_CORPUS 环境变量
 *   默认 ~/Desktop/Agent-Memory/demo-corpus
 *
 * 用法：
 *   node scripts/validate-corpus.mjs
 *   node scripts/validate-corpus.mjs --corpus /path/to/demo-corpus
 *   node scripts/validate-corpus.mjs --strict   # 严格模式：tool_result 必须有配对 tool_use
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── 解析语料根目录 ──
function resolveCorpusDir() {
  const argIdx = process.argv.indexOf("--corpus");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    return resolve(process.argv[argIdx + 1]);
  }
  if (process.env.DEMO_CORPUS) {
    return resolve(process.env.DEMO_CORPUS);
  }
  // 默认：仓库外 demo-corpus（与 design-156.md §6.2 约定一致）
  return resolve(homedir(), "Desktop", "Agent-Memory", "demo-corpus");
}

const corpusDir = resolveCorpusDir();
const STRICT = process.argv.includes("--strict");

const VALID_BUCKETS = new Set([
  "history-plan", "failure", "code-knowledge",
  "project-convention", "skill", "product-knowledge",
]);
const VALID_TASK_TYPES = new Set(["bug-fix", "feature", "test", "refactor"]);

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

console.log(`语料根目录: ${corpusDir}`);

// ── 1. manifest ──
const manifestPath = join(corpusDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`FATAL: manifest.json 不存在（${manifestPath}）`);
  console.error("提示: 用 --corpus <path> 或 DEMO_CORPUS 指定正确路径");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// 校验 buckets 枚举
for (const [k, v] of Object.entries(manifest.buckets ?? {})) {
  if (!VALID_BUCKETS.has(k)) fail(`manifest.buckets 含非法 key: ${k}`);
  if (typeof v !== "string") fail(`manifest.buckets.${k} 应为字符串`);
}
for (const t of manifest.task_types ?? []) {
  if (!VALID_TASK_TYPES.has(t)) fail(`manifest.task_types 含非法值: ${t}`);
}

// 统计
const stats = {
  sessions: manifest.sessions?.length ?? 0,
  documents: manifest.documents?.length ?? 0,
  product_knowledge: manifest.product_knowledge?.length ?? 0,
  code_refs: manifest.code_refs?.length ?? 0,
};

// ── 2. 文件存在性 + buckets 合法性 ──
function checkFile(rel, label, buckets) {
  const full = join(corpusDir, rel);
  if (!existsSync(full)) {
    fail(`${label} 文件不存在: ${rel}`);
    return;
  }
  for (const b of buckets ?? []) {
    if (!VALID_BUCKETS.has(b)) fail(`${label} 含非法 bucket: ${b}`);
  }
}

for (const s of manifest.sessions ?? []) {
  checkFile(s.file, `session ${s.id}`, s.buckets);
  if (!VALID_TASK_TYPES.has(s.task_type)) fail(`session ${s.id} 非法 task_type: ${s.task_type}`);
}
for (const d of manifest.documents ?? []) checkFile(d.file, `document ${d.id}`, d.buckets);
for (const p of manifest.product_knowledge ?? []) checkFile(p.file, `product ${p.id}`, p.buckets);
for (const c of manifest.code_refs ?? []) {
  // code_refs 是引用，不要求文件在本目录存在（真实仓库在外部）
  for (const b of c.buckets ?? []) {
    if (!VALID_BUCKETS.has(b)) fail(`code_ref ${c.id} 含非法 bucket: ${b}`);
  }
}

// ── 3. session jsonl 可解析性 + 配对锚点 ──
for (const s of manifest.sessions ?? []) {
  const full = join(corpusDir, s.file);
  if (!existsSync(full)) continue;
  const lines = readFileSync(full, "utf8").split("\n").filter((l) => l.trim());
  const toolUseIds = new Set();
  const toolResultIds = new Set();
  let parsed = 0;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      fail(`session ${s.id} 含非法 JSON 行: ${line.slice(0, 80)}`);
      continue;
    }
    parsed++;
    if (obj.type === "session_meta") continue;
    const content = obj.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") toolUseIds.add(block.id);
      if (block?.type === "tool_result") toolResultIds.add(block.tool_use_id);
    }
  }

  // 配对检查：每个 tool_result 的 tool_use_id 都应有对应 tool_use
  for (const rid of toolResultIds) {
    if (!toolUseIds.has(rid)) {
      const msg = `session ${s.id}: tool_result 引用未配对的 tool_use_id=${rid}`;
      STRICT ? fail(msg) : warn(msg);
    }
  }
  // 每个 tool_use 都应有 tool_result（非严格，某些 tool_use 可能无结果，如部分工具）
  for (const uid of toolUseIds) {
    if (!toolResultIds.has(uid)) {
      warn(`session ${s.id}: tool_use id=${uid} 无对应 tool_result`);
    }
  }
  if (parsed === 0) fail(`session ${s.id} 无有效内容`);
}

// ── 4. 文档/产品知识非空 ──
for (const d of [...(manifest.documents ?? []), ...(manifest.product_knowledge ?? [])]) {
  const full = join(corpusDir, d.file);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, "utf8");
  if (text.trim().length < 50) warn(`${d.id} 内容过短（<50 字符）`);
}

// ── 输出 ──
console.log("=== demo-corpus 校验结果 ===");
console.log(`语料规模: ${stats.sessions} 个会话 / ${stats.documents} 篇文档 / ${stats.product_knowledge} 篇产品知识 / ${stats.code_refs} 个代码引用`);
console.log(`错误: ${errors.length} / 警告: ${warnings.length}`);
for (const w of warnings) console.log(`  [warn] ${w}`);
for (const e of errors) console.log(`  [FAIL] ${e}`);

// 规模检查（对齐 design-156.md §6.2）
if (stats.sessions < 10) warn(`会话数 ${stats.sessions} < 目标 10-14`);
if (stats.documents < 8) warn(`文档数 ${stats.documents} < 目标 8-12`);
if (stats.product_knowledge < 6) warn(`产品知识数 ${stats.product_knowledge} < 目标 6-8`);

if (errors.length > 0) {
  console.log("\n校验未通过（有错误）。");
  process.exit(1);
}
console.log("\n校验通过 ✓");

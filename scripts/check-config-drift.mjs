#!/usr/bin/env node
/**
 * check-config-drift.mjs — 任务二配置单源化防漂移。
 *
 * 单一权威默认 = `MemoryProxy/src/config.ts` 的 `DEFAULT_CONFIG`（代码）。
 * 本脚本校验两个"静态副本"没漂移：
 *   1. `MemoryProxy/config.example.yaml` 的 `retrieval:`（weights/阈值/topN/预算/effect）
 *   2. `results/task234-demo/index.html` 面板1 常量（SEL_THRESHOLD / TOPN / budget 默认值）
 *
 * 用法：node scripts/check-config-drift.mjs   （任一漂移 → 打印差异并 exit 1）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PROXY_DIR = join(ROOT, "MemoryProxy");
const EXAMPLE = join(PROXY_DIR, "config.example.yaml");
const DEMO = join(ROOT, "results", "archive", "task234-demo", "index.html");

const require = createRequire(join(PROXY_DIR, "package.json"));
const yaml = require("js-yaml");

// ── 1) 从代码取权威默认（DEFAULT_CONFIG.retrieval）───────────────────────────
const code = `const m = await import('./src/config.ts'); process.stdout.write(JSON.stringify(m.DEFAULT_CONFIG.retrieval));`;
const run = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
  cwd: PROXY_DIR,
  encoding: "utf8",
  timeout: 60_000,
});
if (run.status !== 0) {
  console.error("❌ 无法导入 config.ts DEFAULT（tsx 解析失败）：", (run.stderr || run.stdout || "").slice(0, 400));
  process.exit(1);
}
const def = JSON.parse(run.stdout);
const defRerank = def.rerank;
const defEffect = def.effect ?? {};
const defRefresh = def.refresh ?? {};

let fail = 0;
const chk = (label, a, b, tol = 1e-9) => {
  const same = Math.abs(Number(a) - Number(b)) <= tol;
  if (!same) {
    fail = 1;
    console.error(`   ❌ ${label}: config.default=${a}  ${label.includes("example") ? "example" : "demo"}=${b}`);
  }
};

// ── 2) config.example.yaml ───────────────────────────────────────────────────
const exampleCfg = yaml.load(readFileSync(EXAMPLE, "utf8"));
const ex = exampleCfg?.retrieval;
console.log("── 校验 config.example.yaml vs DEFAULT_CONFIG.retrieval ──");
if (!ex) {
  console.error("   ❌ config.example.yaml 缺少 retrieval: 段");
  fail = 1;
} else {
  const w = ex.rerank?.weights ?? {};
  for (const k of ["relevance", "credibility", "freshness", "envCompat", "historicalEffect", "tokenCost"]) {
    chk(`weights.${k} (example)`, defRerank.weights[k], w[k]);
  }
  chk("selectedThreshold (example)", defRerank.selectedThreshold, ex.rerank?.selectedThreshold);
  chk("topN (example)", defRerank.topN, ex.rerank?.topN);
  chk("candidateTopK (example)", defRerank.candidateTopK, ex.rerank?.candidateTopK);
  chk("budgetTokens (example)", defRerank.budgetTokens, ex.rerank?.budgetTokens);
  chk("freshnessHalfLifeDays (example)", defRerank.freshnessHalfLifeDays, ex.rerank?.freshnessHalfLifeDays);
  const exEffect = ex.effect ?? {};
  chk("effect.sameTeamOnly (example)", Number(defEffect.sameTeamOnly ?? true), Number(exEffect.sameTeamOnly ?? true));
  chk("effect.windowDays (example)", defEffect.windowDays ?? 90, exEffect.windowDays ?? 90);
}

// ── 3) demo 面板1 常量 ──────────────────────────────────────────────────────
const demoHtml = readFileSync(DEMO, "utf8");
console.log("── 校验 results/task234-demo/index.html 面板1 常量 ──");
const sel = demoHtml.match(/SEL_THRESHOLD\s*=\s*([\d.]+)/);
const topn = demoHtml.match(/TOPN\s*=\s*(\d+)/);
const budget = demoHtml.match(/renderBudget\((\d+)\)/);
if (sel) chk("SEL_THRESHOLD (demo)", defRerank.selectedThreshold, Number(sel[1]));
else { console.error("   ❌ demo 找不到 SEL_THRESHOLD"); fail = 1; }
if (topn) chk("TOPN (demo)", defRerank.topN, Number(topn[1]));
else { console.error("   ❌ demo 找不到 TOPN"); fail = 1; }
if (budget) chk("budgetTokens (demo)", defRerank.budgetTokens, Number(budget[1]));
else { console.error("   ❌ demo 找不到 renderBudget(...)"); fail = 1; }

console.log(fail === 0 ? "✅ 无漂移（config.ts DEFAULT 为单一权威，example/demo 对齐）" : "❌ 存在漂移");
process.exit(fail);

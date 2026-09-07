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
    const srcName = label.includes("example") ? "example" : label.includes("demo") ? "demo" : label.includes("local") ? "local" : "src";
    console.error(`   ❌ ${label}: config.default=${a}  ${srcName}=${b}`);
  }
};

// ── 1b) 本地运行 config.yaml（fallback 感知：rerank 缺字段/effect 缺段=默认）────
const LOCAL = join(PROXY_DIR, "config.yaml");
let localCfg = null;
try { localCfg = yaml.load(readFileSync(LOCAL, "utf8")); } catch { /* 缺失本地文件不阻断 example/demo 校验 */ }
if (localCfg) {
  const lc = localCfg?.retrieval;
  console.log("── 校验 MemoryProxy/config.yaml（本地实际运行）vs DEFAULT_CONFIG.retrieval ──");
  if (!lc) {
    console.error("   ❌ config.yaml 缺少 retrieval: 段（本地联调应显式声明 rerank/effect，便于评审对齐）");
    fail = 1;
  } else {
    const lw = lc.rerank?.weights ?? {};
    for (const k of ["relevance", "credibility", "freshness", "envCompat", "historicalEffect", "tokenCost"]) {
      chk(`weights.${k} (local)`, defRerank.weights[k], lw[k]);
    }
    chk("selectedThreshold (local)", defRerank.selectedThreshold, lc.rerank?.selectedThreshold);
    chk("topN (local)", defRerank.topN, lc.rerank?.topN);
    chk("candidateTopK (local)", defRerank.candidateTopK, lc.rerank?.candidateTopK);
    chk("budgetTokens (local)", defRerank.budgetTokens, lc.rerank?.budgetTokens);
    chk("freshnessHalfLifeDays (local)", defRerank.freshnessHalfLifeDays, lc.rerank?.freshnessHalfLifeDays);
    // effect 段缺失 = 运行时回退默认（true/90）→ 不算漂移；有段但不同 → exit 1。
    const lEffect = lc.effect ?? {};
    chk("effect.sameTeamOnly (local)", Number(defEffect.sameTeamOnly ?? true), Number(lEffect.sameTeamOnly ?? true));
    chk("effect.windowDays (local)", defEffect.windowDays ?? 90, lEffect.windowDays ?? 90);
    // sources 差异仅提示（本地联调开 chat-memory/wiki 是预期，不属于数值漂移）。
    const src = lc.sources ?? {};
    const defSources = def.sources ?? {};
    const chatOn = src.chatMemory?.enabled ?? false;
    const wikiOn = src.wiki?.enabled ?? false;
    if (chatOn !== (defSources.chatMemory?.enabled ?? false) || wikiOn !== (defSources.wiki?.enabled ?? false)) {
      console.warn(`   ⚠ sources 与 DEFAULT 保守默认不同（本地联调预期，不阻断）：chatMemory=${chatOn} wiki=${wikiOn}`
        + `（DEFAULT: chatMemory=${defSources.chatMemory?.enabled ?? false} wiki=${defSources.wiki?.enabled ?? false}）`);
    }
  }
}

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

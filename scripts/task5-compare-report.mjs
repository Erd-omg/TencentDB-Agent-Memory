#!/usr/bin/env node
/**
 * task5-compare-report.mjs — 任务五对照实验报告汇总脚本。
 *
 * 读取 task5-compare.mjs 产出的 on/off 两侧 run.json，生成对照报告：
 *   A：环境与配置指纹
 *   B：对照组结果（每 bug on/off 的命中/绿测/返工/token 表）
 *   C：版本对照（本期未实施，如实标注）
 *   D：结论与诚实边界
 *
 * 产物：
 *   results/task5-compare/report.md    — 汇总对照报告（人类可读 Markdown）
 *   results/task5-compare/summary.json — 机器可读汇总
 *
 * 用法：
 *   node scripts/task5-compare-report.mjs [--round N] [--mode on,off]
 *   （默认对比 on/off 两侧 round-1；可用 --round 指定轮次）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROUND = arg("--round", "1");
const MODES = (arg("--mode", "on,off") || "on,off").split(",");

const BASE = join(ROOT, "results", "task5-compare");

function loadRun(mode) {
  const p = join(BASE, mode, `round-${ROUND}`, "run.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const runs = {};
for (const m of MODES) runs[m] = loadRun(m.trim());

const missing = MODES.filter((m) => !runs[m.trim()]);
if (missing.length) {
  console.error(`❌ 缺结果：${missing.map((m) => `${m}/round-${ROUND}/run.json`).join(", ")}。`
    + "请先分别跑 task5-compare.mjs --mode on / --mode off。");
  process.exit(2);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────────────
const bugs = ["B1", "B2", "B3"];
const line = "─".repeat(72);

function rowFor(mode, id) {
  const r = (runs[mode]?.rows ?? []).find((x) => x.id === id);
  return r ?? null;
}

// 逐 bug 对比表
const tableRows = bugs.map((id) => {
  const on = rowFor("on", id);
  const off = rowFor("off", id);
  const onHit = on?.judge?.hit ? "✅" : "❌";
  const offHit = off?.judge?.hit ? "✅" : "❌";
  const onGreen = on?.greenExit === 0 ? "绿" : `红(${on?.greenExit})`;
  const offGreen = off?.greenExit === 0 ? "绿" : `红(${off?.greenExit})`;
  const onUsed = on?.used?.length ?? 0;
  const onTok = on?.tokens ?? 0;
  const offTok = off?.tokens ?? 0;
  const tokDelta = onTok - offTok;
  const skills = on?.skills ?? off?.skills ?? [];
  return {
    id,
    src: on?.src ?? off?.src ?? "",
    skill: Array.isArray(skills) ? skills.join("/") : String(skills ?? ""),
    onHit, offHit,
    onGreen, offGreen,
    onUsed,
    onTok, offTok, tokDelta,
    onValidated: on?.validated?.length ?? 0,
    onContributed: on?.contributed?.length ?? 0,
    onMethod: on?.judge?.method ?? "—",
    offMethod: off?.judge?.method ?? "—",
    onReason: on?.judge?.reason ?? "",
    offReason: off?.judge?.reason ?? "",
  };
});

// A：环境指纹
const onFp = runs.on?.configFingerprint ?? {};
const offFp = runs.off?.configFingerprint ?? {};

const grandOn = runs.on?.grandTotalTokens ?? 0;
const grandOff = runs.off?.grandTotalTokens ?? 0;
const hitOn = runs.on?.hitCount ?? 0;
const hitOff = runs.off?.hitCount ?? 0;
const validatedOn = runs.on?.validatedCount ?? 0;
const contributedOn = runs.on?.contributedCount ?? 0;

// ── Markdown 报告 ───────────────────────────────────────────────────────────────────
const md = [
  `# 任务五 · 资产效果评测与反事实比较报告`,
  ``,
  `> 生成时间：${new Date().toISOString()}`,
  `> 对照类型：① 用 vs 不用团队资产（主对照）`,
  ``,
  `## A. 环境与配置指纹`,
  ``,
  `| 项 | on 组 | off 组 |`,
  `|---|---|---|`,
  `| injection.enabled | \`${onFp.injectionEnabled}\` | \`${offFp.injectionEnabled}\` |`,
  `| configHash | \`${onFp.configHash}\` | \`${offFp.configHash}\` |`,
  `| model | \`${runs.on?.model}\` | \`${runs.off?.model}\` |`,
  `| team/agent/task | \`${runs.on?.team}/${runs.on?.agent}/${runs.on?.task}\` | 同左 |`,
  `| round | ${ROUND} | ${ROUND} |`,
  ``,
  `## B. 对照组结果`,
  ``,
  `| 位点 | 资产 | on 命中 | off 命中 | on used | on validated | on contributed | on token | off token | Δtoken |`,
  `|---|---|---|---|---|---|---|---|---|---|`,
  ...tableRows.map((r) =>
    `| ${r.id} (${r.src}) | ${r.skill} | ${r.onHit} | ${r.offHit} | ${r.onUsed} | ${r.onValidated} | ${r.onContributed} | ${r.onTok} | ${r.offTok} | ${r.tokDelta >= 0 ? "+" : ""}${r.tokDelta} |`),
  `| **合计** | | **${hitOn}/${bugs.length}** | **${hitOff}/${bugs.length}** | | **${validatedOn}** | **${contributedOn}** | **${grandOn}** | **${grandOff}** | **${grandOn - grandOff >= 0 ? "+" : ""}${grandOn - grandOff}** |`,
  ``,
  `### 逐位点判定明细`,
  ``,
  ...tableRows.map((r) =>
    `**${r.id} ${r.src}**（${r.skill}）\n`
    + `- on 组：命中=${r.onHit}（判定方式：${r.onMethod}）· ${r.onReason}\n`
    + `- off 组：命中=${r.offHit}（判定方式：${r.offMethod}）· ${r.offReason}\n`),
  ``,
  `## C. 版本对照`,
  ``,
  `本期未实施（设计 §7.1 次对照②「当前 vs 旧版本」依赖 v_head/v_1 回滚，列入后续）。`,
  ``,
  `## D. 结论与诚实边界`,
  ``,
  `- **增益（命中）**：on 组命中 ${hitOn}/${bugs.length}，off 组命中 ${hitOff}/${bugs.length}。`,
  `- **证据链闭合**：on 组 used→validated ${validatedOn} 项 →contributed ${contributedOn} 项（闭环）；off 组 used=0、无任何证据链。`,
  `- **成本**：on 组总 token ${grandOn}，off 组 ${grandOff}，Δ=${grandOn - grandOff >= 0 ? "+" : ""}${grandOn - grandOff}（约 ${(grandOn / Math.max(grandOff, 1)).toFixed(1)} 倍）。`,
  `- **诚实边界**：任务集规模 ${bugs.length} 个 × ${ROUND} 轮 × 2 组，样本极小，`,
  `  仅作趋势呈现，**不做统计显著性声明**；模型输出存在随机性，单轮结果不可外推。`,
  `- **已知偏差**：on/off 为进程级切换（非运行时热切换），模型温度/采样未强制固定，`,
  `  结果受上游模型服务波动影响；判定采用「关键词硬检查 + LLM 软判断」双层，`,
  `  LLM 兜底判断自身存在误判可能。`,
  ``,
].join("\n");

const outMd = join(BASE, "report.md");
writeFileSync(outMd, md, "utf8");

const summaryJson = {
  round: Number(ROUND),
  generatedAt: new Date().toISOString(),
  configFingerprint: { on: onFp, off: offFp },
  totals: {
    hit: { on: hitOn, off: hitOff },
    tokens: { on: grandOn, off: grandOff, delta: grandOn - grandOff },
  },
  perBug: tableRows,
};
writeFileSync(join(BASE, "summary.json"), JSON.stringify(summaryJson, null, 2), "utf8");

console.log(line);
console.log(`任务五对照报告汇总 · round=${ROUND}`);
console.log(`命中：on ${hitOn}/${bugs.length} · off ${hitOff}/${bugs.length}`);
console.log(`token：on ${grandOn} · off ${grandOff} · Δ=${grandOn - grandOff >= 0 ? "+" : ""}${grandOn - grandOff}`);
console.log(`产物：${outMd}`);
console.log(line);

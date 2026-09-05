/**
 * 任务二 预算裁剪 —— 在 token 预算内保留「最小但充分」的入选候选。
 *
 * 语义（对齐 demo 面板1 预算滑块）：
 *   - 只对 **passed**（过六维阈值）的候选裁剪；未入选（筛选排除）只停留在
 *     recalled，不进 kept 也不进 trimmed。
 *   - 贪心按 rank 顺序塞入预算：塞得下的进 kept（将注入），塞不下的进 trimmed
 *     （落 selected 但不落 injected —— 保留"为何预算裁"的证据）。
 *   - 预算过小 kept 为空 → 注入器降级渲染摘要/骨架（demo「退化为空应降级」）。
 */

import type { BudgetResult, RerankedCandidate } from "./types.js";

/** 字符数 → token 近似（中英混合，平均约 3 字符/token）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

/** 单条候选的指针 token 估算：name + description + snippet。 */
export function candidateTokenEstimate(c: RerankedCandidate): number {
  const parts = [c.hit.name, c.hit.description, c.hit.snippet]
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return estimateTokens(parts.join(" "));
}

/**
 * 贪心按 rank 裁剪。
 * @param cands 已按加权总分降序（rank 已回填）的候选。
 * @param budgetTokens token 预算。
 */
export function trimByBudget(
  cands: RerankedCandidate[],
  budgetTokens: number,
): BudgetResult {
  const kept: RerankedCandidate[] = [];
  const trimmed: RerankedCandidate[] = [];
  let used = 0;
  for (const c of cands) {
    if (!c.passed) continue;
    const est = candidateTokenEstimate(c);
    if (used + est <= budgetTokens) {
      kept.push(c);
      used += est;
    } else {
      trimmed.push(c);
    }
  }
  return { kept, trimmed };
}

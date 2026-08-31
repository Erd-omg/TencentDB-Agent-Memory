/**
 * 风险维度（任务四 D）—— 从 asset_event 表评估资产的风险标记。
 *
 * 赛题 §9 任务四要求回执展示"冲突/过期/低置信风险"。这些风险都能从事件表
 * 的既有事实推导（不引入 LLM 自述）：
 *   - 低置信：召回相关度分低于阈值（score 来自检索命中）。
 *   - 可能过期：资产被纠正（corrected）之后仍被使用/注入 —— 过期的内容还在被引用。
 *   - 多来源：同一 asset_id 出现多个来源（self/team/imported_from/agent）—— 归属不确定。
 *
 * 纯函数：不落库、不 IO。回执（mem:receipt）调用它对资产卡追加风险行。
 */

import type { AssetEvent, AssetStageSummary } from "../db/asset-event.js";

export interface AssetRisk {
  level: "low" | "medium" | "high";
  label: string;
  detail?: string;
}

/** 低置信阈值：召回 score 低于此值视为相关度不足。 */
export const LOW_SCORE_THRESHOLD = 0.5;

/** 评估一张资产卡的风险。 */
export function evaluateRisks(summary: AssetStageSummary, events: AssetEvent[]): AssetRisk[] {
  const risks: AssetRisk[] = [];
  const assetId = summary.asset.assetId;
  const mine = events.filter((e) => e.asset.assetId === assetId);

  // 低置信：recalled 命中里最低 score 低于阈值（有 score 才算数）。
  // 已 used/validated 的资产不再标低置信 —— 召回分低只说明"检索相关度不足"，
  // 一旦内容已被定向读取并（可能）通过验证，该信号已无意义，避免误报。
  const hasUseOrValidated = summary.stages.includes("used") || summary.stages.includes("validated");
  const scores = mine
    .filter((e) => e.stage === "recalled" && typeof e.asset.score === "number")
    .map((e) => e.asset.score as number);
  if (!hasUseOrValidated && scores.length > 0 && Math.min(...scores) < LOW_SCORE_THRESHOLD) {
    risks.push({
      level: "medium",
      label: "低置信",
      detail: `召回相关度最低 ${Math.min(...scores).toFixed(2)}（< ${LOW_SCORE_THRESHOLD}）`,
    });
  }

  // 可能过期：被纠正后仍被使用/注入。对**最新**纠正时间比较（资产可能被纠正多次，
  // 只看首次纠正会漏掉"最后一次纠正之后仍被引用"的情况）。
  const correctedAt = mine
    .filter((e) => e.stage === "corrected")
    .map((e) => e.createdAt);
  if (correctedAt.length > 0) {
    const latestCorrectedAt = Math.max(...correctedAt);
    const reusedAfterCorrect = mine.some(
      (e) => (e.stage === "used" || e.stage === "injected") && e.createdAt > latestCorrectedAt,
    );
    if (reusedAfterCorrect) {
      risks.push({ level: "high", label: "可能过期", detail: "被纠正后仍被使用/注入" });
    }
  }

  // 多来源：不同 source 计数 > 1（归属不确定）。
  const sources = new Set(mine.map((e) => e.asset.source).filter((s): s is string => !!s));
  if (sources.size > 1) {
    risks.push({ level: "low", label: "多来源", detail: `来自 ${[...sources].join(" / ")}` });
  }

  return risks;
}

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
  /** i18n 文案键（前端统一映射渲染，消除中英混排）；detail 保留动态文本。 */
  messageKey: string;
  detail?: string;
}

/** 低置信阈值：召回 score 低于此值视为相关度不足。 */
export const LOW_SCORE_THRESHOLD = 0.5;

/** 评估一张资产卡的风险。 */
export function evaluateRisks(summary: AssetStageSummary, events: AssetEvent[]): AssetRisk[] {
  const risks: AssetRisk[] = [];
  const assetId = summary.asset.assetId;
  const mine = events.filter((e) => e.asset.assetId === assetId);

  // 低置信：优先用任务二六维重排的**归一化加权总分**（selected evidence.rerank.weightedScore ∈ [0,1]），
  // 否则回落召回原始 score（core 当前是 -bm25，无界，任务二相关性维已在候选集内 min-max 归一化）。
  // 两套口径并存时（重排入选 + 召回分低）以归一化分为准 —— 否则同一资产同时显示"低置信"与
  // "六维重排入选"，回执观感矛盾（见 results/codebuddy-live-5 README 边界记录）。
  // 已 used/validated 的资产不再标低置信 —— 召回分低只说明"检索相关度不足"，
  // 一旦内容已被定向读取并（可能）通过验证，该信号已无意义，避免误报。
  const hasUseOrValidated = summary.stages.includes("used") || summary.stages.includes("validated");
  const rerankScores = mine
    .filter((e) => e.stage === "selected" && e.evidence?.decision === "rerank")
    .map((e) => e.evidence?.rerank?.weightedScore)
    .filter((s): s is number => typeof s === "number");
  const recallScores = mine
    .filter((e) => e.stage === "recalled" && typeof e.asset.score === "number")
    .map((e) => e.asset.score as number);
  const lowScore =
    rerankScores.length > 0
      ? Math.min(...rerankScores)
      : recallScores.length > 0
        ? Math.min(...recallScores)
        : undefined;
  if (!hasUseOrValidated && lowScore !== undefined && lowScore < LOW_SCORE_THRESHOLD) {
    const sourceLabel = rerankScores.length > 0 ? "六维加权" : "召回相关度";
    risks.push({
      level: "medium",
      messageKey: "risk.low_confidence",
      detail: `${sourceLabel}最低 ${lowScore.toFixed(2)}（< ${LOW_SCORE_THRESHOLD}）`,
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
      risks.push({ level: "high", messageKey: "risk.possibly_stale", detail: "被纠正后仍被使用/注入" });
    }
  }

  // 多来源：不同 source 计数 > 1（归属不确定）。
  const sources = new Set(mine.map((e) => e.asset.source).filter((s): s is string => !!s));
  if (sources.size > 1) {
    risks.push({ level: "low", messageKey: "risk.multi_source", detail: `来自 ${[...sources].join(" / ")}` });
  }

  return risks;
}

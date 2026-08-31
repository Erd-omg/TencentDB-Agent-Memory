/**
 * 会话级结果信号（任务四 ①）—— 从 ClickHouse 聚合会话效率/可靠性语境。
 *
 * 归因边界（重要）：CH 是**会话维度**（无 assetId），这些信号是「会话级语境」——
 * 展示在回执汇总区 + 失败率高时警示，**不参与逐资产有效性判定**
 * （那由 asset_event 行为×结果交叉验证决定，见 effectiveness.ts）。
 *
 * 降级友好：CH 未启用 / 不可用 / 查询失败 → querySessionSignals 返回 null，
 * 回执静默跳过「会话信号」行。
 */

import type { SessionSignals } from "../clickhouse.js";

/** 会话失败率警示阈值：bridge 调用失败率 ≥30% → ⚠️ 可靠性警示。 */
export const SESSION_FAIL_RATE_THRESHOLD = 0.3;

/** 从 CH 查询会话信号（包装 clickhouse.querySessionSignals）。 */
export { querySessionSignals } from "../clickhouse.js";
export type { SessionSignals } from "../clickhouse.js";

/** 会话级可靠性判定：失败率 ≥ 阈值 → 警示。 */
export function sessionReliability(signals: SessionSignals): {
  ok: boolean;
  warning?: string;
} {
  if (signals.toolCallCount === 0) return { ok: true };
  if (signals.bridgeFailRate >= SESSION_FAIL_RATE_THRESHOLD) {
    return {
      ok: false,
      warning: `会话工具调用失败率高（${Math.round(signals.bridgeFailRate * 100)}% ≥ ${Math.round(SESSION_FAIL_RATE_THRESHOLD * 100)}%）`,
    };
  }
  return { ok: true };
}

/** 渲染「会话信号」行文本（回执汇总区用）。null = 无信号不显示。 */
export function formatSessionSignals(signals: SessionSignals | null): string | null {
  if (!signals) return null;
  const parts: string[] = [];
  if (signals.turnCount > 0) parts.push(`${signals.turnCount} 轮`);
  if (signals.toolCallCount > 0) {
    parts.push(`bridge 调用 ${signals.toolCallCount} 次`);
    if (signals.bridgeFailCount > 0) {
      parts.push(`失败 ${signals.bridgeFailCount}（${Math.round(signals.bridgeFailRate * 100)}%）`);
    }
    if (signals.avgLatencyMs > 0) parts.push(`均耗 ${Math.round(signals.avgLatencyMs)}ms`);
  }
  if (signals.totalTokens > 0) parts.push(`token ${signals.totalTokens}`);
  if (signals.credit > 0) parts.push(`credit ${Math.round(signals.credit)}`);
  if (parts.length === 0) return null;
  return `会话信号：${parts.join(" · ")}`;
}

/**
 * 有效性判定（任务四 A）—— 异步行为遥测 × 结果信号交叉验证。
 *
 * 目标：回答"这条资产到底有没有用"，而不是"它被调用了多少次"。
 * 避免"被调用 ≠ 有效"：只展示阶段事实（recalled/used）不足以宣称有效，
 * 必须交叉行为信号（复用轨迹）与结果信号（validated/corrected）。
 *
 * 信号来源（全部来自 asset_event 表，本地零新采集；CH 可选增强见 effectiveness-CH）：
 *   - 行为信号：同一资产被 used 的次数 / distinct turn 数（复用 = 间接验证）；
 *               被 corrected（用户/验证器判错）；仅 recalled（从未采用）。
 *   - 结果信号：validated（真实校验通过）、corrected（证明错误/过期/不适用）。
 *
 * 交叉验证规则（优先级从高到低）：
 *   corrected                → ❌ 需修正（结果信号否定）
 *   validated && used        → ✅ 已通过测试验证（结果信号确认 + 行为信号成立）
 *   validated && !used       → ⚠️ 已标记验证（缺使用证据）（与 F4 一致，降级）
 *   used 且 复用信号          → 🔄 已被复用（间接验证）（行为信号：多次被使用）
 *   used 且 单次              → ⏳ 已采用待验证
 *   selected                  → ⏳ 已选中待采用
 *   其余（recalled/injected）→ 💤 仅背景参考
 *
 * 纯函数：不落库、不 IO，方便单元测试。回执（mem:receipt）调用它渲染状态行。
 */

import type { AssetEvent, AssetStageSummary } from "../db/asset-event.js";

export type AssetEffectiveness =
  | "corrected"
  | "validated"
  | "validated_no_use"
  | "reused"
  | "adopted"
  | "selected"
  | "reference_only";

export const EFFECTIVENESS_META: Record<AssetEffectiveness, { icon: string; label: string }> = {
  corrected: { icon: "❌", label: "需修正" },
  validated: { icon: "✅", label: "已通过测试验证" },
  validated_no_use: { icon: "⚠️", label: "已标记验证（缺使用证据）" },
  reused: { icon: "🔄", label: "已被复用（间接验证）" },
  adopted: { icon: "⏳", label: "已采用待验证" },
  selected: { icon: "⏳", label: "已选中待采用" },
  reference_only: { icon: "💤", label: "仅背景参考" },
};

/** 该资产在会话内的全部事件（按 asset_id 过滤）。 */
function eventsFor(assetId: string, events: AssetEvent[]): AssetEvent[] {
  return events.filter((e) => e.asset.assetId === assetId);
}

/**
 * 复用信号：该资产被"实际使用"的次数 / 跨 turn 数。
 * - used 事件数 >= 2（多次定向读取/修改）→ 强复用
 * - used 的 distinct turn 数 >= 2 → 跨轮次复用
 * bridge 触发的 used 事件 turn_seq 可能为空，因此两条都算。
 */
export function reuseSignals(assetId: string, events: AssetEvent[]): { usedCount: number; distinctUseTurns: number } {
  const used = eventsFor(assetId, events).filter((e) => e.stage === "used");
  const distinctUseTurns = new Set(
    used.filter((e) => typeof e.turnSeq === "number").map((e) => e.turnSeq),
  ).size;
  return { usedCount: used.length, distinctUseTurns };
}

/** 交叉验证 → 有效性状态。 */
export function evaluateEffectiveness(summary: AssetStageSummary, events: AssetEvent[]): AssetEffectiveness {
  const stages = summary.stages;
  const { usedCount, distinctUseTurns } = reuseSignals(summary.asset.assetId, events);

  // 结果信号否定优先：被纠正 → 无效。
  if (stages.includes("corrected")) return "corrected";
  // 结果信号确认：validated（需 used 前置，否则 F4 降级）。
  if (stages.includes("validated")) {
    return stages.includes("used") ? "validated" : "validated_no_use";
  }
  // 行为信号：被实际使用过。
  if (stages.includes("used")) {
    return (usedCount >= 2 || distinctUseTurns >= 2) ? "reused" : "adopted";
  }
  if (stages.includes("selected")) return "selected";
  // 仅召回/注入 → 背景参考。
  return "reference_only";
}

/** 汇总一组资产卡的有效性统计（回执汇总行用）。 */
export function effectivenessCounts(summaries: AssetStageSummary[], events: AssetEvent[]): Record<AssetEffectiveness, number> {
  const counts: Record<AssetEffectiveness, number> = {
    corrected: 0, validated: 0, validated_no_use: 0,
    reused: 0, adopted: 0, selected: 0, reference_only: 0,
  };
  for (const s of summaries) {
    counts[evaluateEffectiveness(s, events)]++;
  }
  return counts;
}

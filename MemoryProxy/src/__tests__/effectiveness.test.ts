/**
 * effectiveness 有效性判定测试 —— 行为信号 × 结果信号交叉验证。
 */

import { describe, it, expect } from "vitest";
import type { AssetEvent, AssetStageSummary } from "../db/asset-event.js";
import { evaluateEffectiveness, effectivenessCounts, reuseSignals } from "../evidence/effectiveness.js";

function summary(stages: AssetStageSummary["stages"]): AssetStageSummary {
  return {
    asset: { assetId: "skl-1", assetType: "skill", name: "demo" },
    stages,
    lastStageAt: {} as AssetStageSummary["lastStageAt"],
  };
}

function evt(stage: AssetEvent["stage"], over: Partial<AssetEvent> = {}): AssetEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    stage,
    asset: { assetId: "skl-1", assetType: "skill", name: "demo" },
    sessionKey: "codebuddy:conv-x",
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe("evaluateEffectiveness 交叉验证", () => {
  it("corrected → ❌ 需修正（结果信号否定优先）", () => {
    const s = summary(["recalled", "used", "corrected"]);
    expect(evaluateEffectiveness(s, [evt("corrected")])).toBe("corrected");
  });

  it("validated && used → ✅ 已通过测试验证", () => {
    const s = summary(["recalled", "selected", "used", "validated"]);
    expect(evaluateEffectiveness(s, [evt("used"), evt("validated")])).toBe("validated");
  });

  it("validated && !used → ⚠️ 已标记验证（缺使用证据，F4 降级）", () => {
    const s = summary(["recalled", "injected", "validated"]);
    expect(evaluateEffectiveness(s, [evt("validated")])).toBe("validated_no_use");
  });

  it("used 多次（复用信号）→ 🔄 已被复用（间接验证）", () => {
    const s = summary(["recalled", "used"]);
    const events = [evt("used"), evt("used", { asset: { assetId: "skl-1", assetType: "skill" } })];
    expect(reuseSignals("skl-1", events).usedCount).toBe(2);
    expect(evaluateEffectiveness(s, events)).toBe("reused");
  });

  it("used 跨 turn → 🔄 已被复用", () => {
    const s = summary(["recalled", "used"]);
    const events = [
      evt("used", { turnSeq: 3 }),
      evt("used", { turnSeq: 7 }),
    ];
    expect(reuseSignals("skl-1", events).distinctUseTurns).toBe(2);
    expect(evaluateEffectiveness(s, events)).toBe("reused");
  });

  it("used 单次 → ⏳ 已采用待验证", () => {
    const s = summary(["recalled", "used"]);
    expect(evaluateEffectiveness(s, [evt("used")])).toBe("adopted");
  });

  it("selected → ⏳ 已选中待采用", () => {
    const s = summary(["recalled", "selected"]);
    expect(evaluateEffectiveness(s, [evt("selected")])).toBe("selected");
  });

  it("仅 recalled/injected → 💤 仅背景参考", () => {
    const s = summary(["recalled", "injected"]);
    expect(evaluateEffectiveness(s, [evt("injected")])).toBe("reference_only");
  });
});

describe("effectivenessCounts", () => {
  it("跨资产汇总各有效性状态计数", () => {
    const s1 = summary(["used", "validated"]);
    const s2 = summary(["recalled", "used"]);
    const s3 = summary(["recalled"]);
    const counts = effectivenessCounts([s1, s2, s3], [evt("used"), evt("validated")]);
    expect(counts.validated).toBe(1);
    expect(counts.adopted).toBe(1);
    expect(counts.reference_only).toBe(1);
  });
});

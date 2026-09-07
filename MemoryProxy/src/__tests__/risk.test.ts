/**
 * risk 风险维度测试 —— 低置信 / 可能过期 / 多来源。
 */

import { describe, it, expect } from "vitest";
import type { AssetEvent, AssetStageSummary } from "../db/asset-event.js";
import { evaluateRisks } from "../evidence/risk.js";

function summary(stages: AssetStageSummary["stages"] = []): AssetStageSummary {
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

describe("evaluateRisks", () => {
  it("recalled score 低于阈值 → 低置信风险", () => {
    const risks = evaluateRisks(summary(["recalled"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.3 } }),
    ]);
    expect(risks.map((r) => r.messageKey)).toContain("risk.low_confidence");
    expect(risks.find((r) => r.messageKey === "risk.low_confidence")?.level).toBe("medium");
  });

  it("score 高于阈值 → 无低置信风险", () => {
    const risks = evaluateRisks(summary(["recalled"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.82 } }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.low_confidence");
  });

  it("被纠正后仍被使用 → 可能过期（high）", () => {
    const risks = evaluateRisks(summary(["used", "corrected", "used"]), [
      evt("corrected", { createdAt: 200 }),
      evt("used", { createdAt: 300 }),
    ]);
    const stale = risks.find((r) => r.messageKey === "risk.possibly_stale");
    expect(stale).toBeDefined();
    expect(stale?.level).toBe("high");
  });

  it("纠正后无再使用 → 无过期风险", () => {
    const risks = evaluateRisks(summary(["used", "corrected"]), [
      evt("used", { createdAt: 100 }),
      evt("corrected", { createdAt: 200 }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.possibly_stale");
  });

  it("多来源 → 多来源风险（low）", () => {
    const risks = evaluateRisks(summary(["recalled"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", source: "self" } }),
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", source: "team" } }),
    ]);
    const multi = risks.find((r) => r.messageKey === "risk.multi_source");
    expect(multi).toBeDefined();
    expect(multi?.level).toBe("low");
  });

  it("无风险 → 空数组", () => {
    const risks = evaluateRisks(summary(["used", "validated"]), [
      evt("used", { asset: { assetId: "skl-1", assetType: "skill", source: "self", score: 0.9 } }),
      evt("validated", { createdAt: 200 }),
    ]);
    expect(risks).toEqual([]);
  });

  it("已使用（used）的资产即使召回分低也不再标低置信（避免误报）", () => {
    const risks = evaluateRisks(summary(["recalled", "used"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.0 } }),
      evt("used", { createdAt: 200 }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.low_confidence");
  });

  it("已验证（validated）的资产即使召回分低也不再标低置信（避免误报）", () => {
    const risks = evaluateRisks(summary(["recalled", "validated"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.0 } }),
      evt("validated", { createdAt: 200 }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.low_confidence");
  });

  it("重排入选（selected decision=rerank）用归一化加权分判低置信——加权≥阈值不标，即使召回分低", () => {
    // migration-expert-tips 场景：core 原始 score（-bm25≈0）低，但六维归一化加权 0.59 入选。
    const risks = evaluateRisks(summary(["recalled", "selected"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.0 } }),
      evt("selected", {
        evidence: {
          decision: "rerank",
          rerank: { weightedScore: 0.59, dims: { relevance: 0.5, credibility: 0.5, freshness: 0.5, envCompat: 0.5, historicalEffect: 0.5, tokenCost: 0.5 }, passed: true, trimmedByBudget: false, rank: 5, threshold: 0.55 },
        },
      }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.low_confidence");
  });

  it("重排入选但加权分仍低于阈值 → 标低置信（detail 标注口径为六维加权）", () => {
    const risks = evaluateRisks(summary(["selected"]), [
      evt("selected", {
        evidence: {
          decision: "rerank",
          rerank: { weightedScore: 0.3, dims: { relevance: 0.3, credibility: 0.3, freshness: 0.3, envCompat: 0.3, historicalEffect: 0.3, tokenCost: 0.3 }, passed: false, trimmedByBudget: false, rank: 6, threshold: 0.55 },
        },
      }),
    ]);
    const low = risks.find((r) => r.messageKey === "risk.low_confidence");
    expect(low).toBeDefined();
    expect(low?.detail).toContain("六维加权最低 0.30");
  });

  it("无重排证据时回落召回原始 score（direct-read 场景不变）", () => {
    // direct-read：bridge 搜索落 recalled（带原始 score），get-by-name 落 selected(decision=direct-read)。
    const risks = evaluateRisks(summary(["recalled", "selected"]), [
      evt("recalled", { asset: { assetId: "skl-1", assetType: "skill", score: 0.3 } }),
      evt("selected", {
        evidence: { decision: "direct-read", tool_call: { bridge: "skill-bridge", endpoint: "get-by-name", httpStatus: 200 } },
      }),
    ]);
    const low = risks.find((r) => r.messageKey === "risk.low_confidence");
    expect(low).toBeDefined();
    expect(low?.detail).toContain("召回相关度最低 0.30");
  });

  it("可能过期：对最新纠正时间比较——首次纠正后、末次纠正前使用不标过期", () => {
    // 两次纠正（t=200 / t=400），used 在 t=300（首次纠正后、末次纠正前）→ 不标过期。
    const risks = evaluateRisks(summary(["used", "corrected"]), [
      evt("corrected", { createdAt: 200 }),
      evt("used", { createdAt: 300 }),
      evt("corrected", { createdAt: 400 }),
    ]);
    expect(risks.map((r) => r.messageKey)).not.toContain("risk.possibly_stale");
  });

  it("可能过期：末次纠正之后仍被使用 → 标过期（high）", () => {
    const risks = evaluateRisks(summary(["used", "corrected", "used"]), [
      evt("corrected", { createdAt: 200 }),
      evt("used", { createdAt: 300 }),
      evt("corrected", { createdAt: 400 }),
      evt("used", { createdAt: 500 }),
    ]);
    const stale = risks.find((r) => r.messageKey === "risk.possibly_stale");
    expect(stale).toBeDefined();
    expect(stale?.level).toBe("high");
  });
});

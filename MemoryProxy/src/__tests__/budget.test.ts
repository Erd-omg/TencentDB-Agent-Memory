/**
 * 任务二 预算裁剪 —— 单测。
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, candidateTokenEstimate, trimByBudget } from "../retrieval/budget.js";
import type { RerankedCandidate } from "../retrieval/types.js";

/** 构造一条测试候选（desc 长度决定 token 估算）。 */
function makeCand(opts: { id: string; rank: number; passed: boolean; desc?: string }): RerankedCandidate {
  const desc = opts.desc ?? `desc for ${opts.id}`;
  return {
    hit: { assetId: opts.id, assetType: "skill", name: opts.id, description: desc, version: 1, score: 0.8, snippet: "" },
    asset: { assetId: opts.id, assetType: "skill", name: opts.id },
    bucket: "Skill",
    dimScores: {
      relevance: 0.8, credibility: 0.5, freshness: 0.5, envCompat: 0.5, historicalEffect: 0.5, tokenCost: 0.5,
    },
    weightedScore: 1 - opts.rank / 10,
    rank: opts.rank,
    passed: opts.passed,
  };
}

describe("estimateTokens", () => {
  it("近似 字符数/3", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("空串 → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("candidateTokenEstimate", () => {
  it("按 name+desc+snippet 估算", () => {
    const c = makeCand({ id: "a", rank: 1, passed: true, desc: "1234567890" });
    // name("a") + " " + desc(10) = 12 latin chars → ceil(12/4)=3 tokens（snippet 空；中文按 1 字/token）
    expect(candidateTokenEstimate(c)).toBe(3);
  });
});

describe("trimByBudget", () => {
  it("未入选不进 kept 也不进 trimmed（筛选排除停留 recalled）", () => {
    const cands = [
      makeCand({ id: "a", rank: 1, passed: false }),
      makeCand({ id: "b", rank: 2, passed: false }),
    ];
    const { kept, trimmed } = trimByBudget(cands, 10000);
    expect(kept).toHaveLength(0);
    expect(trimmed).toHaveLength(0);
  });

  it("贪心按 rank：预算内保留、超出裁剪", () => {
    // 每条 ≈3 tokens（新估算）：预算 8 → 保留前 2（3+3=6），第 3 条 6+3=9 >8 被裁
    const cands = [
      makeCand({ id: "a", rank: 1, passed: true }),
      makeCand({ id: "b", rank: 2, passed: true }),
      makeCand({ id: "c", rank: 3, passed: true }),
    ];
    const { kept, trimmed } = trimByBudget(cands, 8);
    expect(kept.map((c) => c.hit.assetId)).toEqual(["a", "b"]);
    expect(trimmed.map((c) => c.hit.assetId)).toEqual(["c"]);
  });

  it("预算过小 kept 为空 → 全部入选者进 trimmed（降级摘要）", () => {
    const cands = [
      makeCand({ id: "a", rank: 1, passed: true }),
      makeCand({ id: "b", rank: 2, passed: true }),
    ];
    const { kept, trimmed } = trimByBudget(cands, 0);
    expect(kept).toHaveLength(0);
    expect(trimmed).toHaveLength(2);
  });

  it("预算充足全部保留、无裁剪", () => {
    const cands = [
      makeCand({ id: "a", rank: 1, passed: true }),
      makeCand({ id: "b", rank: 2, passed: true }),
    ];
    const { kept, trimmed } = trimByBudget(cands, 100000);
    expect(kept).toHaveLength(2);
    expect(trimmed).toHaveLength(0);
  });
});

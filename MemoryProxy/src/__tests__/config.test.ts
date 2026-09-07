/**
 * config 新配置项解析测试 —— injection.assetEvidence.enabled 可关 +
 * validation.autoValidateOnCompletion 解析。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConfig, validateRetrievalConfig } from "../config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function cfg(yamlText: string): ReturnType<typeof buildConfig> {
  const file = join(tmpDir, "config.yaml");
  writeFileSync(file, yamlText, "utf-8");
  return buildConfig({ configFile: file });
}

describe("buildConfig 新配置项", () => {
  it("injection.assetEvidence.enabled=false → 证据打点可关", () => {
    const c = cfg("injection:\n  assetEvidence:\n    enabled: false\n");
    expect(c.injection.assetEvidence?.enabled).toBe(false);
  });

  it("injection.assetEvidence 缺省 → 默认开启", () => {
    const c = cfg("# empty\n");
    expect(c.injection.assetEvidence?.enabled).toBe(true);
  });

  it("validation.autoValidateOnCompletion=false → 解析生效", () => {
    const c = cfg("validation:\n  enabled: true\n  autoValidateOnCompletion: false\n");
    expect(c.validation?.enabled).toBe(true);
    expect(c.validation?.autoValidateOnCompletion).toBe(false);
  });

  it("validation 缺省 → validation 未配置（undefined）", () => {
    const c = cfg("# empty\n");
    expect(c.validation).toBeUndefined();
  });
});

describe("validateRetrievalConfig — 六维权重/范围校验", () => {
  const cfgWith = (w: Partial<Record<"relevance" | "credibility" | "freshness" | "envCompat" | "historicalEffect" | "tokenCost", number>>, th = 0.55, topN = 5, budget = 800, candK = 20, half = 30): Parameters<typeof validateRetrievalConfig>[0] => ({
    enabled: true,
    rerank: { weights: { relevance: 0.4, credibility: 0.15, freshness: 0.1, envCompat: 0.1, historicalEffect: 0.15, tokenCost: 0.1, ...w }, selectedThreshold: th, topN, candidateTopK: candK, budgetTokens: budget, freshnessHalfLifeDays: half },
    router: { rules: {} },
    refresh: { minTurnsBetween: 2, refreshEveryTurns: 8 },
    effect: { sameTeamOnly: true, windowDays: 90 },
    sources: { teamSkill: { enabled: true }, chatMemory: { enabled: false, perAgentLimit: 5 }, wiki: { enabled: false, perWikiLimit: 3 } },
  });

  it("默认权重和=1 → 通过", () => {
    expect(validateRetrievalConfig(cfgWith({}))).toEqual([]);
  });

  it("权重和≠1 → 报错并给出实际和", () => {
    const errs = validateRetrievalConfig(cfgWith({ relevance: 0.7 })); // 0.7+0.15+0.1+0.1+0.15+0.1=1.3
    expect(errs.some((e) => e.includes("权重和") && e.includes("1.3"))).toBe(true);
  });

  it("单维权重越界 → 报错", () => {
    expect(validateRetrievalConfig(cfgWith({ tokenCost: 1.5 })).some((e) => e.includes("weights.tokenCost"))).toBe(true);
  });

  it("selectedThreshold 越界 / topN≤0 → 报错", () => {
    expect(validateRetrievalConfig(cfgWith({}, 2)).some((e) => e.includes("selectedThreshold"))).toBe(true);
    expect(validateRetrievalConfig(cfgWith({}, 0.5, 0)).some((e) => e.includes("topN"))).toBe(true);
  });

  it("buildConfig：retrieval.rerank 权重和≠1 → fail-fast 抛错", () => {
    expect(() => cfg("retrieval:\n  enabled: true\n  rerank:\n    weights:\n      relevance: 0.9\n")).toThrow();
  });
});

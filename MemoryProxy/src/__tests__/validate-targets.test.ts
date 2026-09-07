/**
 * mem:validate 防伪证目标选择（pickValidateTargets）—— 三入口统一收紧的单测。
 *
 * 断言：validated 必须有 used/selected 前置（仅召回/注入不校验）；已 corrected 拒绝
 * （含显式 <id>）；--all 与默认同集。
 */

import { describe, it, expect } from "vitest";
import type { AssetStageSummary, AssetEventStage, AssetRef } from "../db/asset-event.js";
import { pickValidateTargets } from "../mem-command/commands/validate.js";

function summary(
  assetId: string,
  name: string,
  stages: AssetEventStage[],
  assetType: AssetRef["assetType"] = "skill",
): AssetStageSummary {
  return {
    asset: { assetId, assetType, name },
    stages,
    lastStageAt: {} as AssetStageSummary["lastStageAt"],
  };
}

const HAS_RULE = (t: AssetRef["assetType"]): boolean => t === "skill";

/** 典型会话：skl-used（used）、skl-sel（仅 selected）、skl-recall（仅 recalled）、skl-corr（used+corrected）、skl-prof（selected profile）。 */
function sampleSummaries(): AssetStageSummary[] {
  return [
    summary("skl-used", "cloud-migration-tool-guide", ["used"]),
    summary("skl-sel", "migration-expert-tips", ["selected"]),
    summary("skl-recall", "acl-migrate 影响路径", ["recalled"]),
    summary("skl-corr", "memory-hub-asset-guide", ["used", "corrected"]),
    summary("prof-x", "profile", ["selected"], "profile"),
  ];
}

describe("pickValidateTargets — 三入口统一门禁", () => {
  it("默认：只收 used/selected 且有规则；仅召回/注入/已纠正被跳过", () => {
    const r = pickValidateTargets(sampleSummaries(), { hasRule: HAS_RULE });
    // prof-x 有 selected 但类型无规则 → hasRule 过滤掉
    expect(r.assets.map((a) => a.assetId).sort()).toEqual(["skl-sel", "skl-used"]);
    expect(r.note).toContain("已跳过 2 项");
  });

  it("显式 <id>：used 资产放行", () => {
    const r = pickValidateTargets(sampleSummaries(), { assetIdArg: "skl-used", hasRule: HAS_RULE });
    expect(r.assets.map((a) => a.assetId)).toEqual(["skl-used"]);
  });

  it("显式 <id>：仅 recalled 的资产被拒绝（validated 无 used/selected 前置 = 伪证）", () => {
    const r = pickValidateTargets(sampleSummaries(), { assetIdArg: "skl-recall", hasRule: HAS_RULE });
    expect(r.assets).toEqual([]);
    expect(r.note).toContain("拒绝校验");
  });

  it("显式 <id>：已 corrected 资产被拒绝（含 used 也拒绝——纠正已否定它）", () => {
    const r = pickValidateTargets(sampleSummaries(), { assetIdArg: "skl-corr", hasRule: HAS_RULE });
    expect(r.assets).toEqual([]);
    expect(r.note).toContain("拒绝校验");
  });

  it("显式 <id>：资格内但类型无规则 → 拒绝并说明", () => {
    const r = pickValidateTargets(sampleSummaries(), { assetIdArg: "prof-x", hasRule: HAS_RULE });
    expect(r.assets).toEqual([]);
    expect(r.note).toContain("未配置校验规则");
  });

  it("显式 <id>：会话内不存在 → 会话内未找到", () => {
    const r = pickValidateTargets(sampleSummaries(), { assetIdArg: "skl-nonexistent", hasRule: HAS_RULE });
    expect(r.assets).toEqual([]);
    expect(r.note).toContain("会话内未找到");
  });

  it("--all：与默认同集（收紧后统一），仅召回/注入/已纠正仍不进", () => {
    const def = pickValidateTargets(sampleSummaries(), { hasRule: HAS_RULE });
    const all = pickValidateTargets(sampleSummaries(), { allFlag: true, hasRule: HAS_RULE });
    expect(all.assets.map((a) => a.assetId).sort()).toEqual(def.assets.map((a) => a.assetId).sort());
    expect(all.assets.map((a) => a.assetId).sort()).toEqual(["skl-sel", "skl-used"]);
    expect(all.note).toBeTruthy(); // 仍报告跳过了仅召回/已纠正项
  });
});

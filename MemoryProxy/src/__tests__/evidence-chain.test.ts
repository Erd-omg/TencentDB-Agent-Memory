/**
 * F4 测试 —— 证据链完整性校验（validateChain）+ 回执状态降级。
 *
 * 覆盖赛题 F4：
 *   - validated 必须有 used 前置，否则报 error（防止『仅注入就宣称验证有效』）。
 *   - used 缺 injected/selected 前置时给 warning。
 *   - corrected 不要求 used（用户主动纠正合法）。
 *   - 回执 effectStatus：validated 无 used → 降级为「缺使用证据」，不显示 ✅ 已验证。
 */

import { describe, it, expect } from "vitest";
import { validateChain, validateChains } from "../evidence/chain-validator.js";
import type { AssetStageSummary } from "../db/asset-event.js";

function summary(assetId: string, stages: AssetStageSummary["stages"]): AssetStageSummary {
  const lastStageAt = {} as AssetStageSummary["lastStageAt"];
  for (const s of stages) lastStageAt[s] = 1_700_000_000_000;
  return {
    asset: { assetId, assetType: "skill" },
    stages,
    lastStageAt,
  };
}

describe("validateChain（F4）", () => {
  it("validated 无 used → error（仅注入就宣称已验证是过度归因）", () => {
    const issues = validateChain(summary("skl-1", ["injected", "validated"]));
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].missing).toBe("used");
    expect(issues[0].message).toContain("skl-1");
  });

  it("validated + used → 无 error，链路完整", () => {
    const issues = validateChain(summary("skl-2", ["injected", "used", "validated"]));
    expect(issues).toEqual([]);
  });

  it("used 缺 injected/selected → warning（可跨工具读取）", () => {
    const issues = validateChain(summary("skl-3", ["used"]));
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].missing).toBe("injected|selected");
  });

  it("corrected 不要求 used —— 用户主动纠正合法", () => {
    // 只有 corrected 的事件（用户纠正一个仅被 recalled 的资产）→ 不报错。
    const issues = validateChain(summary("skl-4", ["recalled", "corrected"]));
    expect(issues).toEqual([]);
  });

  it("validated 无 used 但已 corrected → 不报 error（纠正已否定验证宣称，P1 噪声修复）", () => {
    // 资产先被 mem:validate 校验（validated）后被 mem:correct（corrected）→
    // 纠正已覆盖"验证有效"宣称（❌ 需修正），不再重复报"缺 used"。
    const issues = validateChain(summary("skl-6", ["injected", "validated", "corrected"]));
    expect(issues).toEqual([]);
  });

  it("used + injected（有前置）→ 无 warning", () => {
    const issues = validateChain(summary("skl-5", ["injected", "used"]));
    expect(issues).toEqual([]);
  });
});

describe("validateChains（聚合）", () => {
  it("批量汇总多个资产的问题", () => {
    const issues = validateChains([
      summary("a", ["validated"]),
      summary("b", ["used"]),
      summary("c", ["injected", "used", "validated"]),
    ]);
    expect(issues.length).toBe(2);
    expect(issues.some((i) => i.assetId === "a" && i.level === "error")).toBe(true);
    expect(issues.some((i) => i.assetId === "b" && i.level === "warning")).toBe(true);
  });
});

/**
 * 证据链完整性校验（赛题 F4）—— 防止"仅被召回/注入就宣称有效"的过度归因。
 *
 * 作用对象是 `AssetStageSummary`（一张回执卡：某资产的 asset + stages）。
 * 校验规则（对应赛题 F1–F4 的依赖语义）：
 *   1. validated 必须有 used 前置 —— 没有"使用"就谈不上"验证有效"；
 *      但资产已 corrected 时不报（纠正已覆盖"验证"宣称，避免"已验证+已纠正"矛盾噪声）。
 *   2. used 应尽量有 injected / selected 前置 —— 使用通常发生在资产被放入
 *      prompt（injected）或定向展开（selected）之后；缺少时降级警告而非报错
 *      （agent 可能跨工具直接读，链路允许断一节）。
 *   3. corrected 不要求 used —— 用户主动纠正（mem:correct）可以针对任何进入过
 *      链路的资产，这是合法语义。
 *
 * 返回每个问题（warning / error），调用方（回执 mem:receipt）据此追加警告行。
 * 纯函数：不落库、不 IO，方便单元测试。
 */

import type { AssetStageSummary } from "../db/asset-event.js";

export type ChainIssueLevel = "warning" | "error";

export interface ChainIssue {
  level: ChainIssueLevel;
  assetId: string;
  /** 缺的前置阶段。 */
  missing: string;
  /** 人类可读说明。 */
  message: string;
}

/** 校验一张资产卡的证据链完整性。 */
export function validateChain(summary: AssetStageSummary): ChainIssue[] {
  const issues: ChainIssue[] = [];
  const assetId = summary.asset.assetId;
  const stages = summary.stages;

  // 规则 1（error）：validated 需要 used 前置，否则"只注入就宣称验证有效"。
  // 已 corrected 的资产跳过：纠正已否定"验证有效"（❌ 需修正），再报"缺 used"是噪声。
  if (stages.includes("validated") && !stages.includes("used") && !stages.includes("corrected")) {
    issues.push({
      level: "error",
      assetId,
      missing: "used",
      message: `资产 ${assetId} 标记为「已验证」但没有 used 事件——仅注入/召回不能支撑「验证有效」。`
        + " 请确认该资产确实被模型使用后再断言 validated，或用 mem:correct 纠正。",
    });
  }

  // 规则 2（warning）：used 尽量有 injected/selected 前置（缺失时降级提示）。
  if (stages.includes("used") && !stages.includes("injected") && !stages.includes("selected")) {
    issues.push({
      level: "warning",
      assetId,
      missing: "injected|selected",
      message: `资产 ${assetId} 被标记为「使用」，但缺少 injected/selected 前置事件。`
        + " 可能是跨工具直接读取——若确属使用，请补充 injected（mem:sync）或 selected 事件以完善链路。",
    });
  }

  return issues;
}

/** 校验一组资产卡，汇总全部问题。 */
export function validateChains(summaries: AssetStageSummary[]): ChainIssue[] {
  return summaries.flatMap((s) => validateChain(s));
}

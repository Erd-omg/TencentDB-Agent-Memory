/**
 * 任务收尾自动验证（任务四 ②）—— 把"手动 mem:validate"变成"收尾自动触发"。
 *
 * 场景：shouldAutoAppendReceipt 判定任务收尾时，本模块自动对
 * "已使用（used）但尚未验证"的 skill 跑一遍真实验证器，让回执直接带
 * validated/corrected 结果，无需用户手动 mem:validate。
 *
 * 约束：
 *   - 有界：每会话收尾最多验证 AUTO_VALIDATE_CAP 项（避免收尾路径被拖慢）。
 *   - 静默降级：验证未启用 / 无规则 / 内容取不到 → 跳过，绝不抛错阻塞业务。
 *   - 接线：非流式有界 await；流式 fire-and-forget（不阻塞 [DONE]）。
 */

import { getAssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEvent, AssetRef } from "../db/asset-event.js";
import { validateAsset } from "../validation/run-validation.js";
import type { ProxyConfig } from "../types.js";

/** 每次收尾最多自动验证的资产数。 */
export const AUTO_VALIDATE_CAP = 3;

/** 自动验证开关：validation.enabled 为前提，autoValidateOnCompletion 缺省跟随开启。 */
export function autoValidateEnabled(config: ProxyConfig): boolean {
  if (!config.validation?.enabled) return false;
  return config.validation.autoValidateOnCompletion ?? true;
}

/**
 * 收集"应自动验证"的目标：used 且 未 validated 且 未 corrected 的 skill，
 * 按最近一次 used 事件时间倒序，截断到 AUTO_VALIDATE_CAP。
 * 只验证 skill（validateAsset 目前只支持 skill 内容加载）。
 */
export function collectAutoValidateTargets(
  summaries: Array<{ stages: string[]; asset: AssetRef }>,
  events: AssetEvent[],
): AssetRef[] {
  const usedAt = new Map<string, number>();
  for (const e of events) {
    if (e.stage === "used" && e.asset.assetType === "skill") {
      const prev = usedAt.get(e.asset.assetId);
      if (prev === undefined || e.createdAt > prev) usedAt.set(e.asset.assetId, e.createdAt);
    }
  }
  const targets = summaries
    .filter((s) => {
      if (s.asset.assetType !== "skill") return false;
      if (!s.stages.includes("used")) return false;
      if (s.stages.includes("validated")) return false;
      if (s.stages.includes("corrected")) return false;
      return true;
    })
    .sort((a, b) => (usedAt.get(b.asset.assetId) ?? 0) - (usedAt.get(a.asset.assetId) ?? 0))
    .slice(0, AUTO_VALIDATE_CAP)
    .map((s) => s.asset);
  return targets;
}

/**
 * 执行自动验证：收集目标 → 逐个 validateAsset（复用 run-validation 的
 * 真实命令 runner）。返回实际执行验证的资产数（跳过的不算）。
 * 全程 try-catch，任何失败都静默吞掉（自动验证绝不阻塞收尾）。
 */
export async function runAutoValidation(input: {
  sessionKey: string;
  sessionInfo: Record<string, unknown>;
  config: ProxyConfig;
}): Promise<number> {
  if (!autoValidateEnabled(input.config)) return 0;
  try {
    const repo = getAssetEventRepo();
    if (!repo) return 0;
    const events = repo.bySessionKey(input.sessionKey);
    if (events.length === 0) return 0;
    const summaries = repo.distinctAssets(input.sessionKey);
    const targets = collectAutoValidateTargets(summaries, events);
    if (targets.length === 0) return 0;

    let ran = 0;
    for (const asset of targets) {
      const outcome = await validateAsset({
        asset,
        config: input.config,
        sessionKey: input.sessionKey,
        sessionInfo: input.sessionInfo,
      });
      if (outcome.result) ran++;
    }
    return ran;
  } catch {
    // 静默：自动验证失败不影响任务收尾主流程。
    return 0;
  }
}

/**
 * 验证编排（任务三 validated/corrected）——
 * 给定一个资产：按配置规则解析验证器 → 加载资产正文 → 真实执行 → 落事件。
 *
 * 落点：
 *   - pass  (exit 0)            → `validated` 事件
 *   - fail  (非 0 / 超时 / 异常)  → `corrected` 事件（资产被证明不通过/不适用）
 * evidence 带 test_result（runner/command/exitCode/output/durationMs）。
 *
 * 静默降级：验证未启用 / 无规则 / 内容取不到 → 返回 null 并附原因，不写事件。
 */

import { getCoreSkillClient } from "../skill/core-client.js";
import { getAssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetRef } from "../db/asset-event.js";
import { CommandRunnerValidator } from "./command-runner.js";
import type { AssetValidator, ValidationResult } from "./types.js";
import type { ProxyConfig } from "../types.js";

export interface ValidateAssetInput {
  asset: AssetRef;
  config: ProxyConfig;
  sessionKey: string;
  sessionInfo: Record<string, unknown>;
}

export interface ValidateAssetOutcome {
  result: ValidationResult | null;
  /** 未执行时的原因（验证关闭/无规则/取不到内容）。 */
  reason?: string;
}

/** 从 sessionInfo 里取身份字段（与注入侧一致）。 */
function pick(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** 按资产类型解析验证器（从 config.validation.rules 取命令模板）。 */
function resolveValidator(
  assetType: string,
  config: ProxyConfig,
): AssetValidator | null {
  const rule = config.validation?.rules?.[assetType];
  if (!rule || !rule.trim()) return null;
  return new CommandRunnerValidator(rule, config.validation?.timeoutMs ?? 30_000);
}

/** 加载资产正文。目前支持 skill（core /v3/skill/get 数据面，team-scoped）。 */
async function loadAssetContent(
  asset: AssetRef,
  config: ProxyConfig,
  sessionInfo: Record<string, unknown>,
): Promise<string | null> {
  const teamId = pick(sessionInfo.team_id);
  const agentId = pick(sessionInfo.agent_id);
  const spaceId = pick(sessionInfo.space_id);

  if (asset.assetType === "skill") {
    if (!teamId || !agentId) return null;
    try {
      const client = getCoreSkillClient(config.coreSkill);
      const detail = await client.getSkill(
        {
          team_id: teamId,
          agent_id: agentId,
          skill_id: asset.assetId,
          include_content: true,
        },
        spaceId ? { serviceId: spaceId } : {},
      );
      return (detail.content ?? "").trim() ? detail.content! : null;
    } catch {
      return null; // 取不到正文 → 不写事件（避免假验证）
    }
  }

  // 其他资产类型（chat-memory / profile / …）暂未实现内容加载 → 不验证。
  return null;
}

/**
 * 验证单个资产并落 validated/corrected 事件。
 * 返回 null（含 reason）表示未执行验证。
 */
export async function validateAsset(input: ValidateAssetInput): Promise<ValidateAssetOutcome> {
  const { asset, config, sessionKey, sessionInfo } = input;

  if (!config.validation?.enabled) {
    return { result: null, reason: "validation disabled in config" };
  }
  const validator = resolveValidator(asset.assetType, config);
  if (!validator) {
    return { result: null, reason: `no validation rule for asset type "${asset.assetType}"` };
  }

  const content = await loadAssetContent(asset, config, sessionInfo);
  if (!content) {
    return { result: null, reason: `cannot load content for asset ${asset.assetId}` };
  }

  const result = await validator.validate({
    asset,
    content,
    sessionKey,
    sessionInfo,
    config,
  });

  // 落 validated / corrected 事件（静默降级：DB 不可用则跳过）。
  const repo = getAssetEventRepo();
  if (repo) {
    repo.insert(repo.newEvent({
      stage: result.pass ? "validated" : "corrected",
      asset,
      sessionKey,
      taskId: pick(sessionInfo.task_id),
      agentId: pick(sessionInfo.agent_id),
      teamId: pick(sessionInfo.team_id),
      userId: pick(sessionInfo.user_id),
      evidence: {
        test_result: {
          runner: result.runner,
          command: result.command,
          exitCode: result.exitCode,
          output: result.output,
          durationMs: result.durationMs,
        },
        validator: {
          id: validator.id,
          pass: result.pass,
          detail: result.output.slice(0, 300),
        },
      },
    }));
  }

  return { result };
}

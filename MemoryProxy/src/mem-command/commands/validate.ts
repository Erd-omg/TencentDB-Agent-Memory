/**
 * mem:validate — 资产真实校验（任务三 validated/corrected）。
 *
 * 用法：
 *   mem:validate                  → 校验本会话「已使用/已选中」且未纠正的、有校验规则的资产
 *   mem:validate --all            → 校验本会话全部有规则的资产（除已纠正）
 *   mem:validate <assetId>        → 只校验指定资产（如 skl-xxx）
 *
 * 默认只校验 used/selected 资产（与 auto-validate 对齐），避免对从未使用的资产
 * 写 validated 造成 F4「validated 无 used」误报；已 corrected 的资产一律跳过
 * （纠正已否定该资产，不再重复写 validated）。
 *
 * 行为：按 config.validation.rules 解析资产类型的校验命令 → 加载资产正文 →
 * 真实执行（真实进程/exit code/输出）→ exit 0 落 `validated`、非 0 落 `corrected`
 * 事件（evidence 带 test_result）。
 *
 * 未启用 / 无规则 / 取不到内容 → 返回原因，不写事件（不假装验证过）。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import type { AssetRef } from "../../db/asset-event.js";
import { validateAsset } from "../../validation/run-validation.js";
import type { ValidationResult } from "../../validation/types.js";

/** 从会话事件里找目标资产（指定 id / 默认 used/selected / --all 全部）。 */
function collectTargetAssets(
  ctx: MemCommandContext,
  repo: NonNullable<ReturnType<typeof getAssetEventRepo>>,
  assetIdArg: string | undefined,
  allFlag: boolean,
): { assets: AssetRef[]; note?: string } {
  const sessionKey = ctx.sessionKey;

  if (assetIdArg) {
    const events = repo.bySessionKey(sessionKey);
    const found = events.find((e) => e.asset.assetId === assetIdArg);
    if (!found) return { assets: [], note: `会话内未找到资产 ${assetIdArg}` };
    return { assets: [found.asset] };
  }

  // 无参数：取会话内去重资产中「有校验规则」的。
  // 默认只校验「已使用/已选中」的资产（与 auto-validate 对齐）——避免对从未使用的
  // 资产写 validated 造成 F4「validated 无 used」误报；`--all` 显式校验全部。
  // 已 corrected 的资产一律跳过：纠正已否定该资产（❌ 需修正），不再重复写 validated。
  const cfg = ctx.config.validation;
  const all = repo.distinctAssets(sessionKey).filter((s) => !s.stages.includes("corrected"));
  const targets = allFlag ? all : all.filter((s) => s.stages.includes("used") || s.stages.includes("selected"));
  const assets = targets.map((s) => s.asset).filter((a) => cfg?.rules?.[a.assetType]);
  const skipped = all.length - targets.length;
  const note = !allFlag && skipped > 0
    ? `已跳过 ${skipped} 项未使用/未选中的资产（默认只校验 used/selected；${assets.length} 项有规则）。需要全量格式校验用 \`mem:validate --all\``
    : undefined;
  return { assets, note };
}

function resultLine(asset: AssetRef, r: ValidationResult | null, reason?: string): string {
  if (!r) {
    return `  ⏭  ${asset.assetId}（${asset.assetType}）：未验证 — ${reason ?? "unknown"}`;
  }
  const status = r.pass ? "✅ 通过" : "❌ 未通过";
  const excerpt = r.output.slice(0, 120).replace(/\n/g, " ");
  return `  ${status} ${asset.assetId}（${asset.assetType}${asset.version ? ` v${asset.version}` : ""}）`
    + ` [${r.exitCode}] ${excerpt || "(无输出)"}`;
}

export async function executeValidate(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const repo = getAssetEventRepo();
  if (!repo) {
    const text = "⚠️ 本地证据库不可用，无法校验。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const args = ctx.args.trim();
  // --all 以非词字符开头，\b--all\b 不匹配（\b 需词边界）；用 (^|\s) 锚定。
  const allFlag = /(^|\s)--all(\s|$)/.test(args);
  const assetIdArg = args.replace(/(^|\s)--all(\s|$)/, " ").trim().split(/\s+/)[0] || undefined;
  const { assets, note } = collectTargetAssets(ctx, repo, assetIdArg, allFlag);

  if (assets.length === 0) {
    const text = note
      ? `ℹ️ ${note}`
      : "ℹ️ 本会话暂无可用资产记录（没有 used/injected 事件）或没有对应校验规则。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  if (!ctx.config.validation?.enabled) {
    const text = "⚠️ 验证未启用：请在 config 中设置 `validation.enabled: true`。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 校验需要会话身份来加载资产正文。
  const si = ctx.sessionInfo ?? {};
  if (!si.team_id || !si.agent_id) {
    const text = "⚠️ 当前会话未绑定团队资产，无法加载资产正文。请先 `mem:session-reset` 选择 Team/Agent。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const lines: string[] = [`🔬 资产验证（${assets.length} 项）`];
  if (note) lines.push(`> ${note}`);
  let passCount = 0;
  const data: { results: Array<Record<string, unknown>> } = { results: [] };
  for (const asset of assets) {
    const outcome = await validateAsset({
      asset,
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      sessionInfo: si,
    });
    lines.push(resultLine(asset, outcome.result, outcome.reason));
    if (outcome.result?.pass) passCount++;
    data.results.push({
      asset_id: asset.assetId,
      asset_type: asset.assetType,
      pass: outcome.result?.pass ?? null,
      exit_code: outcome.result?.exitCode ?? null,
      command: outcome.result?.command ?? null,
      output: outcome.result?.output ?? null,
      reason: outcome.reason ?? null,
      duration_ms: outcome.result?.durationMs ?? null,
    });
  }
  lines.push(`—— ${passCount}/${assets.length} 通过，已写入 validated/corrected 事件`);

  const messageText = lines.join("\n");
  const response = buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking });
  return { success: true, messageText, data, response };
}

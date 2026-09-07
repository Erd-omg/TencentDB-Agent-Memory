/**
 * mem:validate — 资产真实校验（任务三 validated/corrected）。
 *
 * 用法：
 *   mem:validate                  → 校验本会话「已使用/已选中」且未纠正的、有校验规则的资产
 *   mem:validate --all            → 同门禁全量：三入口统一后与默认同集（保留为兼容空操作）
 *   mem:validate <assetId>        → 只校验指定资产（如 skl-xxx）
 *
 * 防伪证门禁（2026-09 边界硬化，三入口统一）：
 *   - validated 必须有 used/selected 前置：只放行本会话 used 或 selected 的资产，
 *     杜绝「仅召回/注入就写 validated」造成的 F4「validated 无 used」；
 *   - 已 corrected 的资产一律拒绝（纠正已否定它，不再重复写 validated）——含显式 <id>。
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
import type { AssetRef, AssetStageSummary } from "../../db/asset-event.js";
import { validateAsset } from "../../validation/run-validation.js";
import type { ValidationResult } from "../../validation/types.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdFootnote, mdJoin } from "../md.js";

/**
 * 防伪证目标选择（纯函数，可单测）：三入口统一。
 * 资格 = 本会话 used ∥ selected 且未 corrected（validated 的 used/selected 前置），
 * 再叠加 hasRule（资产类型配了校验规则才可校验）。
 *  - assetIdArg：资格集内按 id 找；不在（不存在 / 仅召回注入 / 已纠正）→ 拒绝并给原因。
 *  - allFlag：保留兼容——收紧后与默认同集。
 */
export interface ValidatePickOptions {
  assetIdArg?: string;
  allFlag?: boolean;
  /** 该资产类型是否配了校验规则（config.validation.rules）。 */
  hasRule: (assetType: AssetRef["assetType"]) => boolean;
}
export interface ValidatePickResult {
  assets: AssetRef[];
  note?: string;
}
export function pickValidateTargets(
  summaries: AssetStageSummary[],
  opts: ValidatePickOptions,
): ValidatePickResult {
  const { assetIdArg, allFlag = false, hasRule } = opts;
  const eligible = summaries.filter(
    (s) => (s.stages.includes("used") || s.stages.includes("selected")) && !s.stages.includes("corrected"),
  );

  if (assetIdArg) {
    const found = eligible.find((s) => s.asset.assetId === assetIdArg);
    if (!found) {
      const exists = summaries.some((s) => s.asset.assetId === assetIdArg);
      const note = exists
        ? `资产 ${assetIdArg} 本会话未使用/未选中或已被纠正，拒绝校验（防伪证：validated 需 used/selected 前置）`
        : `会话内未找到资产 ${assetIdArg}`;
      return { assets: [], note };
    }
    if (!hasRule(found.asset.assetType)) {
      return { assets: [], note: `资产 ${assetIdArg} 类型 ${found.asset.assetType} 未配置校验规则（validation.rules），跳过` };
    }
    return { assets: [found.asset] };
  }

  const assets = eligible.map((s) => s.asset).filter((a) => hasRule(a.assetType));
  const skipped = summaries.length - eligible.length;
  const mode = allFlag ? "--all" : "默认";
  const note = skipped > 0
    ? `已跳过 ${skipped} 项仅召回/注入或已纠正的资产（${mode}门禁：validated 需 used/selected 前置；--all 收紧后与默认同集）。校验 ${assets.length} 项有规则资产。`
    : undefined;
  return { assets, note };
}

/** 从会话事件里找目标资产（指定 id / 默认 used/selected / --all）。 */
function collectTargetAssets(
  ctx: MemCommandContext,
  repo: NonNullable<ReturnType<typeof getAssetEventRepo>>,
  assetIdArg: string | undefined,
  allFlag: boolean,
): { assets: AssetRef[]; note?: string } {
  const cfg = ctx.config.validation;
  const summaries = repo.distinctAssets(ctx.sessionKey);
  return pickValidateTargets(summaries, {
    assetIdArg,
    allFlag,
    hasRule: (t) => Boolean(cfg?.rules?.[t]),
  });
}

function resultLine(asset: AssetRef, r: ValidationResult | null, reason?: string): string {
  if (!r) {
    return mdBullet(`⏭ ${asset.assetId}（${asset.assetType}）：未验证 — ${reason ?? "unknown"}`);
  }
  const status = r.pass ? "✅ 通过" : "❌ 未通过";
  const excerpt = r.output.slice(0, 120).replace(/\n/g, " ");
  return mdBullet(`${status} ${asset.assetId}（${asset.assetType}${asset.version ? ` v${asset.version}` : ""}）`
    + ` [${r.exitCode}] ${excerpt || "(无输出)"}`);
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

  const mdLines: Array<string | undefined> = [
    mdHeader("🔬", `资产验证（${assets.length} 项）`),
    mdBlank(),
  ];
  if (note) mdLines.push(mdBullet(note), mdBlank());
  let passCount = 0;
  let failCount = 0;
  const data: { results: Array<Record<string, unknown>>; summary?: Record<string, unknown> } = { results: [] };
  for (const asset of assets) {
    const outcome = await validateAsset({
      asset,
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      sessionInfo: si,
    });
    mdLines.push(resultLine(asset, outcome.result, outcome.reason));
    if (outcome.result?.pass) passCount++;
    else failCount++;
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
  mdLines.push(
    mdBlank(),
    mdSection("汇总"),
    mdBullet(`✅ 通过 ${passCount} · ❌ 未通过 ${failCount} · 共 ${assets.length} 项，已写入 validated/corrected 事件`),
  );
  // 顺带增强 data：summary（脚本/--json 可消费）。
  data.summary = { total: assets.length, pass: passCount, fail: failCount };
  const messageText = mdJoin(mdLines);

  const response = buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking });
  return { success: true, messageText, data, response };
}

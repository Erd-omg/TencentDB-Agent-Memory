/**
 * mem:proposal — 提案（proposal）机制（任务六 §8.5「原资产修订建议 / 过期冲突降权建议」）。
 *
 * 提案不是新资产，而是一条「变更建议」记录，目标是对既有权威资产（approved）做
 * 原子变更。落地方式（复用现有候选审核闭环，最少侵入）：
 *   - 提案以 `asset_type=skill` 的 candidate 资产承载，metadata_json 顶层带
 *     `is_proposal: true` + `proposal` 结构（kind / target_asset_id / reasons /
 *     evidence_refs / expected_version），与普通候选（经验/修复/纠错）区分。
 *   - 提案与候选同受 §4.3 门控：未 apply 前消费侧不可见。
 *   - 审核沿用 `mem:review apply`：apply 时识别 is_proposal，对目标资产执行对应
 *     原子变更（deprecate → deprecated；downgrade → 降 risk），而非落地新 skill。
 *
 * 用法：
 *   mem:proposal create <target_asset_id> --kind=revise|deprecate|conflict|downgrade --reason=...
 *   mem:proposal list [--status=proposed|approved|rejected|all]
 *
 * 提案结构对齐 design-156.md §8.5 AssetProposal（kind/targetAssetId/expectedVersion/
 * reasons/evidenceRefs/status）。status 映射到 meta 资产状态：
 *   proposed → candidate；approved → approved；rejected → failed；superseded → deprecated。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getMetadataClient } from "../../meta/client.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdJoin } from "../md.js";

/** 提案类型（design-156.md §8.5 AssetProposal.kind）。 */
export type ProposalKind = "revise" | "deprecate" | "conflict" | "downgrade";

const PROPOSAL_KIND_LABEL: Record<ProposalKind, string> = {
  revise: "修订建议",
  deprecate: "过期/废弃建议",
  conflict: "冲突建议",
  downgrade: "降权建议",
};

/** metadata_json 里的提案结构（§8.5 AssetProposal 子集，status 由 meta 资产 status 表达）。 */
export interface ProposalMeta {
  kind: ProposalKind;
  target_asset_id: string;
  reasons: string[];
  evidence_refs: string[];
  expected_version?: { baseHash: string; diffHint: string };
}

/** 从资产 metadata_json 提取提案结构（非提案资产返回 undefined）。 */
export function parseProposalMeta(metadataJson: string | null | undefined): ProposalMeta | undefined {
  if (!metadataJson) return undefined;
  try {
    const m = JSON.parse(metadataJson) as { is_proposal?: boolean; proposal?: ProposalMeta };
    if (m.is_proposal !== true || !m.proposal?.target_asset_id) return undefined;
    return m.proposal;
  } catch {
    return undefined;
  }
}

/** 提案 id：`prop-<target>-<kind>-<hash>` 前 80 字符，保证对同一目标+kind 幂等可重识别。 */
function proposalId(targetAssetId: string, kind: ProposalKind): string {
  const base = `prop-${targetAssetId}-${kind}`;
  return base.slice(0, 80);
}

/** 提案名（skill name 约束：kebab-case）。 */
function proposalName(targetAssetId: string, kind: ProposalKind): string {
  const safe = targetAssetId.replace(/[^a-z0-9-]/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
  return `${kind}-${safe}`;
}

/** 提案正文（审核 show 时展示）。 */
function proposalContent(p: ProposalMeta, targetName: string): string {
  const lines = [
    `# ${PROPOSAL_KIND_LABEL[p.kind]}：${targetName}`,
    "",
    `- 目标资产：\`${p.target_asset_id}\``,
    `- 类型：${PROPOSAL_KIND_LABEL[p.kind]}`,
  ];
  if (p.expected_version) {
    lines.push(`- 期望版本：base=${p.expected_version.baseHash} ${p.expected_version.diffHint ? `（${p.expected_version.diffHint}）` : ""}`);
  }
  if (p.reasons.length > 0) {
    lines.push("", "## 依据", ...p.reasons.map((r) => `- ${r}`));
  }
  if (p.evidence_refs.length > 0) {
    lines.push("", "## 证据引用", ...p.evidence_refs.map((e) => `- \`${e}\``));
  }
  return lines.join("\n");
}

type ProposalAction = "create" | "list";

function parseAction(args: string): {
  action: ProposalAction;
  targetAssetId?: string;
  kind?: ProposalKind;
  reason?: string;
  status?: string;
  err?: string;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "list") {
    const statusArg = parts.find((p) => p.startsWith("--status="));
    return { action: "list", status: statusArg ? statusArg.slice("--status=".length) : "all" };
  }
  if (parts[0] === "create") {
    const targetAssetId = parts[1];
    const kindArg = parts.find((p) => p.startsWith("--kind="));
    const reasonArg = parts.find((p) => p.startsWith("--reason="));
    const kind = kindArg ? (kindArg.slice("--kind=".length) as ProposalKind) : undefined;
    if (!targetAssetId) return { action: "create", err: "缺少目标资产 id" };
    if (!kind || !(kind in PROPOSAL_KIND_LABEL)) {
      return { action: "create", targetAssetId, err: `--kind 必须为 ${Object.keys(PROPOSAL_KIND_LABEL).join("|")}` };
    }
    return { action: "create", targetAssetId, kind, reason: reasonArg ? reasonArg.slice("--reason=".length) : undefined };
  }
  return { action: "list" };
}

export async function executeProposal(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const si = ctx.sessionInfo ?? {};
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const teamId = pick(si.team_id);
  const userId = pick(si.user_id);

  if (!teamId || !userId) {
    const text = "❌ 缺少 team_id / user_id，无法创建提案。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const meta = getMetadataClient(ctx.config.coreSkill, ctx.spaceId, ctx.apiKey);
  const { action, targetAssetId, kind, reason, status, err } = parseAction(ctx.args);

  // ── create ──
  if (action === "create") {
    if (err || !targetAssetId || !kind) {
      const text = mdJoin([
        mdHeader("❌", "提案用法错误"),
        mdBlank(),
        mdBullet(err ?? "用法：`mem:proposal create <target_asset_id> --kind=revise|deprecate|conflict|downgrade --reason=...`"),
      ]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }

    try {
      // 读目标资产，确认存在（提案必须指向真实权威资产）。
      const items = await meta.listAssets({ team_id: teamId });
      const target = items.find((a) => a.asset_id === targetAssetId);
      if (!target) {
        const text = mdJoin([mdHeader("❌", "目标资产不存在"), mdBlank(), mdBullet(`\`${targetAssetId}\` 不在本团队资产中。`)]);
        return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }

      const reasons = [reason ?? `用户发起 ${PROPOSAL_KIND_LABEL[kind]} 提案`];
      const proposal: ProposalMeta = {
        kind,
        target_asset_id: targetAssetId,
        reasons,
        evidence_refs: [`user:${userId}`, `session:${ctx.sessionKey}`],
      };
      const name = proposalName(targetAssetId, kind);
      const id = proposalId(targetAssetId, kind);

      // 幂等：同 target+kind 已有提案则复用，不重复创建。
      const existing = items.find((a) => a.asset_id === id);
      if (existing) {
        const text = mdJoin([
          mdHeader("♻️", "提案已存在（幂等复用）"),
          mdBlank(),
          mdBullet(`\`${id}\` 已存在（target=${targetAssetId} kind=${kind}），未重复创建。`),
          mdBullet("用 `mem:review show <id>` 查看，`mem:review apply <id>` 审核执行。"),
        ]);
        return { success: true, messageText: text, data: { proposal_id: id, reused: true }, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }

      await meta.createAsset({
        asset_id: id,
        team_id: teamId,
        asset_type: "skill",
        name,
        owner_user_id: userId,
        source_type: "manual",
        description: `${PROPOSAL_KIND_LABEL[kind]}：${target.name ?? targetAssetId}`,
        source_ref: `proposal:${targetAssetId}`,
        status: "candidate",
        visibility: "team",
        metadata_json: JSON.stringify({
          is_proposal: true,
          proposal,
          bucket: PROPOSAL_KIND_LABEL[kind],
          risk: kind === "downgrade" ? "low" : "medium",
          evidence: { validated: false },
          content: proposalContent(proposal, target.name ?? targetAssetId),
        }),
      });

      const text = mdJoin([
        mdHeader("📝", "提案已创建（candidate，待审核）"),
        mdBlank(),
        mdBullet(`\`${id}\` — ${PROPOSAL_KIND_LABEL[kind]}：${target.name ?? targetAssetId}`),
        mdBullet("未 apply 前不生效（§4.3 门控）；`mem:review apply <id>` 审核后对目标资产执行变更。"),
      ]);
      return {
        success: true,
        messageText: text,
        data: { proposal_id: id, target_asset_id: targetAssetId, kind },
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    } catch (e) {
      const text = mdJoin([mdHeader("❌", "提案创建失败"), mdBlank(), mdBullet((e as Error).message.slice(0, 200))]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
  }

  // ── list ──
  const statusFilter = status === "all" ? undefined : status;
  const items = await meta.listAssets({ team_id: teamId, ...(statusFilter ? { status: statusFilter } : {}) });
  const proposals = items.filter((a) => parseProposalMeta(a.metadata_json) !== undefined);

  if (proposals.length === 0) {
    const text = mdJoin([
      mdHeader("📋", "提案列表"),
      mdBlank(),
      mdBullet(`无 ${statusFilter ?? "全部"} 状态提案。用 \`mem:proposal create <id> --kind=...\` 创建。`),
    ]);
    return { success: true, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const md: Array<string | undefined> = [
    mdHeader("📋", `提案列表（status=${statusFilter ?? "all"}）`),
    mdBlank(),
  ];
  for (const p of proposals) {
    const pm = parseProposalMeta(p.metadata_json)!;
    md.push(mdBullet(`\`${p.asset_id}\` — ${PROPOSAL_KIND_LABEL[pm.kind]} → \`${pm.target_asset_id}\` [${p.status ?? "?"}]`));
  }
  md.push(mdBlank(), mdBullet("用 `mem:review show <id>` 看详情，`mem:review apply <id>` 审核执行变更。"));
  const text = mdJoin(md);
  return {
    success: true,
    messageText: text,
    data: { items: proposals.map((p) => ({ proposal_id: p.asset_id, kind: parseProposalMeta(p.metadata_json)?.kind, target_asset_id: parseProposalMeta(p.metadata_json)?.target_asset_id, status: p.status })) },
    response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
  };
}

/**
 * mem:review — 候选资产审核（任务六「候选资产生命周期」审核闭环，CLI 通道）。
 *
 * 用法：
 *   mem:review list [--status=candidate|approved|failed|all]   → 列出资产（缺省 candidate）
 *   mem:review show <asset_id>                                → 查看来源/证据/正文
 *   mem:review apply <asset_id>                               → 批准（candidate → approved）
 *   mem:review reject <asset_id> [原因]                        → 拒绝（candidate → failed）
 *   mem:review supersede <旧asset_id> <新asset_id>             → 旧资产被新版替代（approved → deprecated）
 *
 * 语义（design-156.md §8.6）：
 *   - apply 是唯一使候选进入权威资产库的动作（candidate → approved）。
 *   - skill 类候选 apply 后落地 skill 域（幂等：按 name 命中唯一索引则复用，不重复创建）。
 *   - 落地 agent 兜底统一为「team 首个 active agent」（与 Panel 审核页同源，见 §8.6 M5）。
 *   - reject 落 failed（保留审计），不物理删除。
 *   - supersede 把旧 approved 资产标记 deprecated（用已有状态表达"被替代"，消费侧
 *     自动过滤 deprecated），并在 metadata_json 追加 superseded_by（保留替代关系审计）。
 *   - 未 apply 的候选受 §4.3 门控，注入/检索/面板"已发布"视图均不可见。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getMetadataClient } from "../../meta/client.js";
import { getCoreSkillClient } from "../../skill/core-client.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdJoin } from "../md.js";
import { parseProposalMeta } from "./proposal.js";

type ReviewAction = "list" | "show" | "apply" | "reject" | "supersede";

/**
 * 确保 content 符合 SKILL.md 契约（MemoryCore skill-format.ts）：
 * 必须 `---\nname: xxx\ndescription: xxx\n---\n` 开头，否则 create 报
 * SKILL_FRONTMATTER_INVALID。propose 生成的 content 可能是纯正文，
 * 此处兜底补全 frontmatter（不覆盖已有 frontmatter）。
 */
export function ensureSkillFrontmatter(content: string, name: string, description: string): string {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimStart();
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    return content; // 已有 frontmatter，原样保留
  }
  const safeName = name.replace(/[^a-z0-9-]/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "skill";
  const safeDesc = (description || "candidate skill").replace(/\n/g, " ").slice(0, 1024);
  return `---\nname: ${safeName}\ndescription: ${safeDesc}\n---\n\n${content}`;
}

/**
 * 解析 skill 落地目标 agent_id（CLI 与 Panel 双通道同源，design-156.md §8.6）：
 * candidate 资产不绑定 agent（属于 team），落地 skill 域需要一个 agent 作为
 * owner 维度（skill 唯一索引 `(team_id, owner_agent_id, name)`）。
 *
 * 统一策略：优先 team 的首个 active agent（保证双通道落到同一 agent，从而
 * 幂等去重时 name 命中唯一索引）；无可选 agent 时回退 `"default"`。
 * 不再用 `si.agent_id`（那是"当前会话 agent"，Panel 无会话，语义无法对齐）。
 */
export async function resolveLandingAgentId(
  meta: ReturnType<typeof getMetadataClient>,
  teamId: string,
): Promise<string> {
  try {
    const agents = await meta.listAgents(teamId);
    if (agents.length > 0) return agents[0].agent_id;
  } catch { /* 忽略，回退 default */ }
  return "default";
}

function parseAction(args: string): {
  action: ReviewAction;
  assetId?: string;
  newAssetId?: string;
  note?: string;
  status?: string;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "list" };
  const head = parts[0];
  if (head === "list") {
    const statusArg = parts.find((p) => p.startsWith("--status="));
    return { action: "list", status: statusArg ? statusArg.slice("--status=".length) : "candidate" };
  }
  if (head === "show" || head === "apply" || head === "reject") {
    const assetId = parts[1];
    const note = parts.slice(2).join(" ").trim();
    return { action: head, assetId, note: note || undefined };
  }
  if (head === "supersede") {
    return { action: "supersede", assetId: parts[1], newAssetId: parts[2] };
  }
  return { action: "list" };
}

export async function executeReview(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const si = ctx.sessionInfo ?? {};
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const teamId = pick(si.team_id);
  const userId = pick(si.user_id);

  if (!teamId || !userId) {
    const text = "❌ 缺少 team_id / user_id，无法审核候选资产。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const meta = getMetadataClient(ctx.config.coreSkill, ctx.spaceId, ctx.apiKey);
  const { action, assetId, newAssetId, note, status } = parseAction(ctx.args);

  // ── list ──
  if (action === "list") {
    const statusFilter = status === "all" ? undefined : (status ?? "candidate");
    const items = await meta.listAssets({ team_id: teamId, status: statusFilter });
    if (items.length === 0) {
      const text = mdJoin([
        mdHeader("📋", "候选资产审核列表"),
        mdBlank(),
        mdBullet(`无 ${statusFilter ?? "全部"} 状态资产。`),
      ]);
      return { success: true, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
    const md: Array<string | undefined> = [
      mdHeader("📋", `候选资产审核列表（status=${statusFilter ?? "all"}）`),
      mdBlank(),
    ];
    for (const a of items) {
      let metaHint = "";
      try {
        if (a.metadata_json) {
          const m = JSON.parse(a.metadata_json) as { risk?: string; bucket?: string };
          metaHint = ` · ${m.bucket ?? "?"} · 风险:${m.risk ?? "?"}`;
        }
      } catch { /* ignore */ }
      md.push(mdBullet(`\`${a.asset_id}\` — ${a.name ?? "(未命名)"} [${a.status ?? "?"}]${metaHint}`));
    }
    md.push(
      mdBlank(),
      mdBullet("用 `mem:review show <id>` 看详情，`apply <id>` / `reject <id>` 审核。"),
    );
    const text = mdJoin(md);
    const data = { items: items.map((a) => ({ asset_id: a.asset_id, name: a.name, status: a.status })) };
    return { success: true, messageText: text, data, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // ── show / apply / reject 需要 assetId ──
  if (!assetId) {
    const text = mdJoin([
      mdHeader("❌", "缺少 asset_id"),
      mdBlank(),
      mdBullet("用法：`mem:review show <asset_id>` / `apply <asset_id>` / `reject <asset_id> [原因]`"),
    ]);
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // ── show ──
  if (action === "show") {
    const items = await meta.listAssets({ team_id: teamId });
    const asset = items.find((a) => a.asset_id === assetId);
    if (!asset) {
      const text = mdJoin([mdHeader("❌", "未找到资产"), mdBlank(), mdBullet(`\`${assetId}\` 不在本团队资产中（或已被门控过滤）。`)]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
    let content = "", risk = "?", bucket = "?", evidence = "";
    try {
      if (asset.metadata_json) {
        const m = JSON.parse(asset.metadata_json) as Record<string, unknown>;
        content = typeof m.content === "string" ? m.content : "";
        risk = String(m.risk ?? "?");
        bucket = String(m.bucket ?? "?");
        // evidence 现在是结构化对象 { validated, resultRef, at }（§6.4）
        const ev = m.evidence as { validated?: boolean; resultRef?: string } | undefined;
        evidence = ev ? `validated=${ev.validated ?? "?"} · ${ev.resultRef ?? ""}` : "";
      }
    } catch { /* ignore */ }
    const text = mdJoin([
      mdHeader("📄", `候选资产详情：${asset.name ?? asset.asset_id}`),
      mdBlank(),
      mdSection("基本信息"),
      mdBullet(`asset_id：\`${asset.asset_id}\``),
      mdBullet(`类型：${asset.asset_type} · 状态：${asset.status ?? "?"}`),
      mdBullet(`语义桶：${bucket} · 风险：${risk}`),
      mdBullet(`来源：${asset.source_ref ?? "?"}`),
      asset.description ? mdBullet(`描述：${asset.description}`) : undefined,
      evidence ? mdBullet(`证据：${evidence}`) : undefined,
      mdBlank(),
      mdSection("正文"),
      content ? mdBullet(content.slice(0, 1000)) : mdBullet("（无正文，或未存于 metadata_json）"),
    ]);
    return { success: true, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // ── apply ──
  if (action === "apply") {
    try {
      // 先读资产，拿到 asset_type + metadata_json（正文可能存于 metadata_json.content）。
      const items = await meta.listAssets({ team_id: teamId });
      const cur = items.find((a) => a.asset_id === assetId);
      if (!cur) {
        const text = mdJoin([mdHeader("❌", "未找到资产"), mdBlank(), mdBullet(`\`${assetId}\` 不在本团队资产中。`)]);
        return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }

      // ── 提案识别（§8.5）：apply 提案 = 对目标资产执行原子变更，而非落地新 skill ──
      const proposal = parseProposalMeta(cur.metadata_json);
      if (proposal) {
        const target = items.find((a) => a.asset_id === proposal.target_asset_id);
        if (!target) {
          const text = mdJoin([
            mdHeader("❌", "提案目标资产不存在"),
            mdBlank(),
            mdBullet(`提案指向 \`${proposal.target_asset_id}\`，但该资产不在本团队中，无法执行变更。`),
          ]);
          return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
        }

        // 原子变更：deprecate/conflict → 目标 deprecated；downgrade → 降 risk（metadata_json.risk=low）。
        // revise 需要补丁草案（expected_version.diffHint）—— v1 只记录提案通过，实际正文修订
        // 由人工在 skill 域完成（诚实边界：不自动改写权威正文，避免误伤）。
        let targetPatch: { status?: string; metadata_json?: string };
        if (proposal.kind === "deprecate" || proposal.kind === "conflict") {
          let orig: Record<string, unknown> = {};
          try {
            if (target.metadata_json) orig = JSON.parse(target.metadata_json) as Record<string, unknown>;
          } catch { /* ignore */ }
          targetPatch = {
            status: "deprecated",
            metadata_json: JSON.stringify({
              ...orig,
              deprecated_by_proposal: assetId,
              deprecate_kind: proposal.kind,
            }),
          };
        } else if (proposal.kind === "downgrade") {
          let orig: Record<string, unknown> = {};
          try {
            if (target.metadata_json) orig = JSON.parse(target.metadata_json) as Record<string, unknown>;
          } catch { /* ignore */ }
          targetPatch = {
            metadata_json: JSON.stringify({ ...orig, risk: "low", downgraded_by_proposal: assetId }),
          };
        } else {
          // revise：不自动改写正文，仅记录提案通过（诚实边界）。
          targetPatch = {};
        }

        await meta.updateAsset(assetId, { status: "approved" });
        if (targetPatch.status || targetPatch.metadata_json) {
          await meta.updateAsset(proposal.target_asset_id, targetPatch);
        }

        const actionLabel = proposal.kind === "deprecate" || proposal.kind === "conflict"
          ? "已标记目标资产 deprecated（消费侧自动过滤）"
          : proposal.kind === "downgrade"
            ? "已降目标资产风险为 low"
            : "已通过（revise：正文修订由人工在 skill 域完成）";
        const text = mdJoin([
          mdHeader("✅", "提案已批准并执行"),
          mdBlank(),
          mdBullet(`提案 \`${assetId}\` → approved。`),
          mdBullet(`目标资产 \`${proposal.target_asset_id}\`：${actionLabel}。`),
        ]);
        return {
          success: true,
          messageText: text,
          data: { proposal_id: assetId, status: "approved", target_asset_id: proposal.target_asset_id, kind: proposal.kind },
          response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
        };
      }

      const updated = await meta.updateAsset(assetId, { status: "approved" });

      // 发布联动（design-156.md §4.2）：skill 类候选 apply 后，把 meta 侧写的正文
      // 真正落成 skill 数据域（status=active），否则 approved 资产只有 meta 行、
      // 无 skill 正文，注入/检索拿不到内容。
      let skillId: string | undefined;
      let skillNote = "";
      if (cur.asset_type === "skill") {
        let content = "";
        try {
          if (cur.metadata_json) {
            const m = JSON.parse(cur.metadata_json) as { content?: unknown };
            if (typeof m.content === "string") content = m.content;
          }
        } catch { /* ignore */ }

        if (content) {
          try {
            const core = getCoreSkillClient(ctx.config.coreSkill);
            const agentId = await resolveLandingAgentId(meta, teamId);
            const skillName = cur.name ?? assetId;

            // 幂等保护（P0-1）：skill 唯一索引 (team_id, owner_agent_id, name)。
            // 重复 apply（或 CLI 与 Panel 交叉 apply）不应产生孤儿重复 skill。
            // 先按 name 查是否已存在；命中则复用，不再 create。
            const existing = await core.listSkills(
              {
                team_id: teamId,
                agent_id: agentId,
                filters: { name_prefix: skillName },
                pagination: { limit: 50, offset: 0 },
              },
              { serviceId: ctx.spaceId },
            );
            const hit = existing.items.find((s) => s.name === skillName);
            if (hit) {
              skillId = hit.skill_id;
              skillNote = ` · skill 域已存在（\`${skillId}\`），幂等复用，未重复创建`;
            } else {
              // SKILL.md 契约（MemoryCore skill-format.ts）：content 必须带
              // `---\nname: xxx\ndescription: xxx\n---\n` frontmatter，否则 create 报
              // SKILL_FRONTMATTER_INVALID。propose 生成的 content 可能是纯正文，
              // 这里兜底补全 frontmatter（name 用 skill 名，description 用资产描述）。
              const finalContent = ensureSkillFrontmatter(
                content,
                skillName,
                cur.description ?? "",
              );
              const created = await core.post<{ skill_id?: string; name?: string; version?: number }>(
                "/v3/skill/create",
                {
                  user_id: userId,
                  team_id: teamId,
                  agent_id: agentId,
                  name: skillName,
                  description: cur.description ?? "",
                  content: finalContent,
                },
                { serviceId: ctx.spaceId },
              );
              skillId = created.skill_id;
              skillNote = skillId ? ` · skill 域已落地（\`${skillId}\`）` : "";
            }
          } catch (err) {
            // meta 已 approved，但 skill 域落地失败 —— 诚实报告，不静默。
            skillNote = ` · ⚠ skill 域落地失败：${(err as Error).message.slice(0, 120)}`;
          }
        } else {
          skillNote = " · （无 metadata_json.content 正文，未落地 skill 域）";
        }
      }

      const text = mdJoin([
        mdHeader("✅", "候选资产已批准（approved）"),
        mdBlank(),
        mdBullet(`\`${assetId}\` → approved，已进入权威资产库，可被注入/检索。`),
        mdBullet(`版本：${updated.version ?? "（未变）"}`),
        skillNote ? mdBullet(skillNote.trim()) : undefined,
      ]);
      return {
        success: true,
        messageText: text,
        data: { asset_id: assetId, status: "approved", skill_id: skillId },
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    } catch (err) {
      const text = mdJoin([mdHeader("❌", "批准失败"), mdBlank(), mdBullet((err as Error).message.slice(0, 200))]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
  }

  // ── reject ──
  if (action === "reject") {
    try {
      const patch: Record<string, unknown> = { status: "failed" };
      // 先读原 metadata_json，追加 reject_reason/rejected_by，而非整体覆盖 ——
      // 保留候选资产的原始 source/bucket/risk/evidence/content（「保留审计」语义，
      // 被拒资产应能追溯其原始来源与证据）。
      // rejected_by 无条件记录（无论是否带原因），保证审计链完整。
      let original: Record<string, unknown> = {};
      try {
        const items = await meta.listAssets({ team_id: teamId });
        const cur = items.find((a) => a.asset_id === assetId);
        if (cur?.metadata_json) {
          original = JSON.parse(cur.metadata_json) as Record<string, unknown>;
        }
      } catch { /* 读失败则按空对象合并，不阻断拒绝 */ }
      const merged: Record<string, unknown> = { ...original, rejected_by: userId };
      if (note) merged.reject_reason = note;
      patch.metadata_json = JSON.stringify(merged);
      await meta.updateAsset(assetId, patch);
      const text = mdJoin([
        mdHeader("🚫", "候选资产已拒绝（failed）"),
        mdBlank(),
        mdBullet(`\`${assetId}\` → failed（保留审计，不物理删除）。`),
        note ? mdBullet(`原因：${note}`) : undefined,
      ]);
      return { success: true, messageText: text, data: { asset_id: assetId, status: "failed" }, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    } catch (err) {
      const text = mdJoin([mdHeader("❌", "拒绝失败"), mdBlank(), mdBullet((err as Error).message.slice(0, 200))]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
  }

  // ── supersede ──
  if (action === "supersede") {
    try {
      if (!assetId || !newAssetId) {
        const text = mdJoin([
          mdHeader("❌", "supersede 用法错误"),
          mdBlank(),
          mdBullet("用法：`mem:review supersede <旧asset_id> <新asset_id>`"),
        ]);
        return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }

      // 读旧资产，确认存在且为 approved（只有已发布资产才需要「被替代」标记）。
      const items = await meta.listAssets({ team_id: teamId });
      const oldAsset = items.find((a) => a.asset_id === assetId);
      if (!oldAsset) {
        const text = mdJoin([mdHeader("❌", "旧资产不存在"), mdBlank(), mdBullet(`\`${assetId}\` 不在本团队资产中。`)]);
        return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }
      if (oldAsset.status !== "approved") {
        const text = mdJoin([
          mdHeader("❌", "仅 approved 资产可 supersede"),
          mdBlank(),
          mdBullet(`\`${assetId}\` 当前状态为 ${oldAsset.status ?? "?"}，仅 approved 可被替代。`),
        ]);
        return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
      }

      // 读旧 metadata_json，追加 superseded_by + superseded_at，保留原有字段（审计）。
      let original: Record<string, unknown> = {};
      try {
        if (oldAsset.metadata_json) original = JSON.parse(oldAsset.metadata_json) as Record<string, unknown>;
      } catch { /* ignore */ }
      const merged: Record<string, unknown> = {
        ...original,
        superseded_by: newAssetId,
        superseded_at: new Date().toISOString(),
        superseded_by_user: userId,
      };
      await meta.updateAsset(assetId, {
        status: "deprecated",
        metadata_json: JSON.stringify(merged),
      });

      const text = mdJoin([
        mdHeader("🔄", "资产已标记为被替代（deprecated）"),
        mdBlank(),
        mdBullet(`\`${assetId}\` → deprecated（被 \`${newAssetId}\` 替代）。`),
        mdBullet("消费侧（注入/检索/面板「已发布」视图）将自动过滤 deprecated。"),
      ]);
      return {
        success: true,
        messageText: text,
        data: { asset_id: assetId, status: "deprecated", superseded_by: newAssetId },
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    } catch (err) {
      const text = mdJoin([mdHeader("❌", "supersede 失败"), mdBlank(), mdBullet((err as Error).message.slice(0, 200))]);
      return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
    }
  }

  const text = "❌ 未知操作。";
  return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
}

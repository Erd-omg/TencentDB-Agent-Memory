/**
 * mem:review — 候选资产审核（任务六「候选资产生命周期」审核闭环，CLI 通道）。
 *
 * 用法：
 *   mem:review list [--status=candidate|approved|failed|all]   → 列出资产（缺省 candidate）
 *   mem:review show <asset_id>                                → 查看来源/证据/正文
 *   mem:review apply <asset_id>                               → 批准（candidate → approved）
 *   mem:review reject <asset_id> [原因]                        → 拒绝（candidate → failed）
 *
 * 语义（design-156.md §8.6）：
 *   - apply 是唯一使候选进入权威资产库的动作（candidate → approved）。
 *   - reject 落 failed（保留审计），不物理删除。
 *   - 未 apply 的候选受 §4.3 门控，注入/检索/面板"已发布"视图均不可见。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getMetadataClient } from "../../meta/client.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdJoin } from "../md.js";

type ReviewAction = "list" | "show" | "apply" | "reject";

function parseAction(args: string): { action: ReviewAction; assetId?: string; note?: string; status?: string } {
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
  const { action, assetId, note, status } = parseAction(ctx.args);

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
      const updated = await meta.updateAsset(assetId, { status: "approved" });
      const text = mdJoin([
        mdHeader("✅", "候选资产已批准（approved）"),
        mdBlank(),
        mdBullet(`\`${assetId}\` → approved，已进入权威资产库，可被注入/检索。`),
        mdBullet(`版本：${updated.version ?? "（未变）"}`),
      ]);
      return { success: true, messageText: text, data: { asset_id: assetId, status: "approved" }, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
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

  const text = "❌ 未知操作。";
  return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
}

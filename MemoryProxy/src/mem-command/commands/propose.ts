/**
 * mem:propose — 手动触发候选资产生成（任务六「任务经验回流」手动入口）。
 *
 * 用法：
 *   mem:propose [task_id]   → 对指定任务重放生成；无参数时用当前会话证据链
 *
 * 行为：
 *   - 从证据链（used/validated/contributed 事件）+ 用户纠正记录提炼候选
 *     （规则/模板，零 LLM，见 evidence/propose.ts）。
 *   - 指定 task_id 时，事件来源 = AssetEventRepo.byTaskId(task_id)（§8.7 验收 3：
 *     可对指定任务重放生成）；无参数时 = 当前会话 session_key。
 *   - 候选一律落 meta asset/create（status=candidate，asset_type=skill），
 *     不直接成为权威资产（design-156.md §4.1）。
 *   - 与 mem:finalize 自动回流钩子共用同一生成器（generateCandidates）。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import { getMetadataClient } from "../../meta/client.js";
import { generateCandidates } from "../../evidence/propose.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdJoin } from "../md.js";

export async function executePropose(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const si = ctx.sessionInfo ?? {};
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const teamId = pick(si.team_id);
  const userId = pick(si.user_id);

  if (!teamId || !userId) {
    const text = "❌ 缺少 team_id / user_id，无法生成候选资产。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 解析 `mem:propose [task_id]`：显式 task_id 时对该任务重放生成（§8.1/§8.7 验收 3）。
  // 无参数时退回当前会话（session_key）的证据链。
  const argTaskId = ctx.args.trim().split(/\s+/)[0] || undefined;
  const repo = getAssetEventRepo();

  // 事件来源：指定 task_id → byTaskId；否则 → bySessionKey（当前会话）。
  const sourceEvents = repo
    ? argTaskId
      ? repo.byTaskId(argTaskId)
      : repo.bySessionKey(ctx.sessionKey)
    : [];

  const usedEvents = sourceEvents.filter(
    (e) => e.stage === "used" || e.stage === "validated" || e.stage === "contributed",
  );

  // 提取用户纠正记录（corrected 事件）
  const corrections = sourceEvents
    .filter((e) => e.stage === "corrected")
    .map((e) => ({
      assetId: e.asset.assetId,
      note: (e.evidence as { decision?: string } | undefined)?.decision ?? "（无原因）",
    }));

  // 生成候选草案（sourceRef 用重放 task_id 或当前会话 task_id）
  const effTaskId = argTaskId ?? pick(si.task_id);
  const effectiveSessionInfo = { ...si, ...(effTaskId ? { task_id: effTaskId } : {}) };
  const drafts = generateCandidates({
    sessionKey: ctx.sessionKey,
    sessionInfo: effectiveSessionInfo,
    usedEvents,
    corrections,
  });

  if (drafts.length === 0) {
    const text = mdJoin([
      mdHeader("📭", "无可复用经验（候选生成）"),
      mdBlank(),
      mdBullet("本会话未发现可沉淀的新经验：无 used/validated/contributed 资产，也无用户纠正。"),
      mdBullet("诚实起见不生成空候选（design-156.md §8.4 默认规则）。"),
    ]);
    return { success: true, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 落库 candidate 资产
  const meta = getMetadataClient(ctx.config.coreSkill, ctx.spaceId, ctx.apiKey);
  const created: Array<{ assetId: string; name: string }> = [];
  const failed: Array<{ name: string; err: string }> = [];
  for (const d of drafts) {
    try {
      await meta.createAsset({
        asset_id: d.assetId,
        team_id: teamId,
        asset_type: "skill",
        name: d.name,
        owner_user_id: userId,
        source_type: d.source.kind === "task" ? "task" : "session",
        description: d.description,
        source_ref: d.sourceRef,
        status: "candidate",
        visibility: "team",
        // metadata_json 契约对齐 design-156.md §6.4：source / bucket / risk /
        // evidence（结构化）。bucket 由 categorizeSkill 归类，不硬编码二值。
        // content（草稿正文侧写，§4.1）暂存 metadata_json，供 mem:review show 展示。
        metadata_json: JSON.stringify({
          source: d.source,
          bucket: d.bucket,
          risk: d.risk,
          evidence: d.evidence,
          content: d.content,
        }),
      });
      created.push({ assetId: d.assetId, name: d.name });
    } catch (err) {
      failed.push({ name: d.name, err: (err as Error).message });
    }
  }

  const md: Array<string | undefined> = [
    mdHeader("🧠", "候选资产生成（mem:propose）"),
    mdBlank(),
    mdSection("结果"),
  ];
  if (created.length > 0) {
    md.push(mdBullet(`生成 ${created.length} 条候选（status=candidate，待审核）：`));
    for (const c of created) {
      md.push(mdBullet(`  • \`${c.assetId}\` — ${c.name}`));
    }
  }
  if (failed.length > 0) {
    md.push(mdSection("失败"));
    for (const f of failed) {
      md.push(mdBullet(`  ✗ ${f.name}: ${f.err.slice(0, 120)}`));
    }
  }
  md.push(
    mdBlank(),
    mdBullet("候选资产未进入权威资产库，需 `mem:review apply <id>` 审核后方可注入（design-156.md §4.3 门控）。"),
  );

  const text = mdJoin(md);
  const data = {
    created: created.map((c) => c.assetId),
    failed: failed.map((f) => f.name),
    task_id: effTaskId ?? null,
    source: argTaskId ? "task" : "session",
  };
  return { success: created.length > 0, messageText: text, data, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
}

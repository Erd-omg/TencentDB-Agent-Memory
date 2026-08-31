/**
 * mem:correct — 用户主动纠正资产（任务三 corrected 的用户反馈路径，赛题 F3）。
 *
 * 背景：`corrected` 事件原本只能由验证器判错（mem:validate 非 0 exit）产生。
 * 但用户/评审发现资产有错、过期或不适用时，应当有**用户反馈**路径也能落
 * `corrected` 事件 —— 否则"纠正"永远只能靠跑测试，无法反映人工判断。
 *
 * 用法：
 *   mem:correct <assetId> [原因]   → 为指定资产落一条 corrected 事件
 *
 * 行为：
 *   - 只对会话内「已召回/使用/注入过」的资产落 corrected（不能凭空纠正一个
 *     从没出现过的资产 —— 那会让证据链失真）。
 *   - evidence.source = "user"，evidence.decision 记录用户给的纠正原因。
 *   - 幂等：对同一资产重复 correct 只追加事件，不报错。
 *
 * 原则（与验证器路径一致）：证据独立于 LLM 自述 —— 这里的事实来源是"用户指令"。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import type { AssetEventStage } from "../../db/asset-event.js";

/** corrected 需有这些前置阶段之一才允许（资产确实进入过链路，纠正才有意义）。 */
const PREREQ_STAGES: AssetEventStage[] = ["recalled", "selected", "injected", "used", "validated"];

/** 从会话事件里找一个资产，并校验它是否值得纠正。 */
function findCorrigibleAsset(
  repo: NonNullable<ReturnType<typeof getAssetEventRepo>>,
  sessionKey: string,
  assetId: string,
): { ok: boolean; reason?: string } {
  const events = repo.bySessionKey(sessionKey);
  const found = events.find((e) => e.asset.assetId === assetId);
  if (!found) {
    return { ok: false, reason: `本会话未找到资产 ${assetId}，无法纠正（没有可回溯的证据链）` };
  }
  const hasPrereq = events.some(
    (e) => e.asset.assetId === assetId && PREREQ_STAGES.includes(e.stage),
  );
  if (!hasPrereq) {
    return {
      ok: false,
      reason: `资产 ${assetId} 本会话只被记录过 ${found.stage}，尚未进入证据链，纠正无意义`,
    };
  }
  return { ok: true };
}

export async function executeCorrect(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const repo = getAssetEventRepo();
  if (!repo) {
    const text = "⚠️ 本地证据库不可用，无法记录纠正。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 解析参数：<assetId> [原因…]
  const parts = ctx.args.trim().split(/\s+/);
  const assetId = parts[0] || undefined;
  if (!assetId) {
    const text = "❌ 用法：`mem:correct <assetId> [原因]`\n"
      + "例：`mem:correct skl-xxx 里面的命令过时了，新版 API 已改名`";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const sessionKey = ctx.sessionKey;
  const check = findCorrigibleAsset(repo, sessionKey, assetId);
  if (!check.ok) {
    const text = `❌ ${check.reason}`;
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 取会话内该资产最新引用（保证 asset 信息最新）。
  const events = repo.bySessionKey(sessionKey);
  const latest = events
    .filter((e) => e.asset.assetId === assetId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const asset = latest.asset;

  const reason = parts.slice(1).join(" ").trim();
  const si = ctx.sessionInfo ?? {};
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  repo.insert(repo.newEvent({
    stage: "corrected",
    asset,
    sessionKey,
    sessionId: pick(si.session_id),
    taskId: pick(si.task_id),
    agentId: pick(si.agent_id),
    teamId: pick(si.team_id),
    userId: pick(si.user_id),
    evidence: {
      source: "user",
      ...(reason ? { decision: reason } : {}),
    },
  }));

  const reasonLine = reason ? `原因：${reason}` : "未附原因";
  const text = `✅ 已记录用户纠正（corrected）\n`
    + `  资产：${asset.name || asset.assetId}（${asset.assetType}${asset.version ? ` v${asset.version}` : ""}）\n`
    + `  ${reasonLine}\n`
    + `  证据来源：user（用户/评审主动反馈）`;
  return { success: true, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
}

/**
 * 任务收尾检测（任务四 B）—— 工具工作结束后连续 N 轮无工具调用 → 自动追加回执。
 *
 * 赛题 §9 任务四：Proxy 在任务收尾自动追加一段简短回执，无需用户主动输入。
 *
 * 收尾信号（2026-08-28 组合修复，修复"触发太早 + double-bug"）：
 *   1. **注册轮不计**：session-init 注册轮（question_answer 的纯文本回复）由调用方
 *      （handler.ts `sessionJustRegistered`）跳过，不参与 streak —— 否则注册轮+首个
 *      纯文本回复就凑成 2，过早开闸。
 *   2. **工具轮重置**：出现工具调用（工具链在工作）→ streak 归零；无工具轮 → +1。
 *      触发 = 连续 2 个无工具轮 且 该 2 轮之间没有工具调用。
 *   3. **证据锚定**：本会话必须已出现 used/selected 资产事件（`hasEvidence` 粘性）
 *      才触发 —— 纯对话/仅检索的会话不追加空回执。
 *   4. **修 double-bug**：`autoShown` 只在真正触发（有证据且达阈值）时消费 ——
 *      无证据绝不吞掉本会话的触发机会（旧版在 render 之前消费标志，导致"吞掉
 *      但回执不显示"）。
 *
 * 会话级状态（内存 Map，进程重启即清空——只影响自动追加，不影响已落库的证据）。
 * 每会话只自动追加一次，避免每轮都刷屏。
 */

import { getAssetEventRepo } from "../db/assetEventRepo.js";

/** 连续 N 轮无工具调用 → 判定任务收尾。 */
export const AUTO_RECEIPT_THRESHOLD = 2;

interface SessionTurnState {
  noToolStreak: number;
  autoShown: boolean;
  /** 会话是否已出现实质资产使用（used/selected）——粘性，一旦 true 不再回落。 */
  hasEvidence: boolean;
}

const state = new Map<string, SessionTurnState>();

/** 本轮是否"无工具调用"（工具链终止 = 自然结束）。 */
export function isToolFreeTurn(
  assistantMessage: Record<string, unknown> | null | undefined,
): boolean {
  const calls = assistantMessage?.tool_calls;
  return !Array.isArray(calls) || calls.length === 0;
}

/**
 * 会话是否已出现"实质资产使用"（used/selected 事件）—— 自动回执的证据锚定。
 * 同步、便宜（indexed 查询）；DB 不可用 → false（不触发）。
 */
export function hasAssetEngagement(sessionKey: string): boolean {
  const repo = getAssetEventRepo();
  if (!repo) return false;
  return repo.bySessionKey(sessionKey, "used").length > 0
    || repo.bySessionKey(sessionKey, "selected").length > 0;
}

/**
 * 记录一轮并返回是否应自动追加回执。
 * @param assistantMessage 本轮 assistant 消息（含 tool_calls；工具轮传非空数组）。
 * @param hasEvidence 本会话是否已出现 used/selected 资产事件（调用方从 repo 查）。
 * @returns true = 达收尾阈值且本会话已有资产使用且尚未自动追加过。
 */
export function shouldAutoAppendReceipt(
  sessionKey: string,
  assistantMessage: Record<string, unknown> | null | undefined,
  hasEvidence: boolean,
): boolean {
  const s = state.get(sessionKey) ?? { noToolStreak: 0, autoShown: false, hasEvidence: false };
  const noTool = isToolFreeTurn(assistantMessage);
  // 工具轮重置 streak；无工具轮 +1。
  s.noToolStreak = noTool ? s.noToolStreak + 1 : 0;
  // 证据粘性：一旦出现 used/selected 即保持。
  s.hasEvidence = s.hasEvidence || hasEvidence;
  state.set(sessionKey, s);
  if (s.autoShown) return false;
  // 证据锚定：本会话尚无实质资产使用 → 不触发，也不消费 autoShown（修 double-bug）。
  if (!s.hasEvidence) return false;
  if (noTool && s.noToolStreak >= AUTO_RECEIPT_THRESHOLD) {
    s.autoShown = true;
    return true;
  }
  return false;
}

/** 重置会话收尾状态（会话切换 / 测试用）。 */
export function resetAutoReceipt(sessionKey: string): void {
  state.delete(sessionKey);
}

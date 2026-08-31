/**
 * turn-tracker — 会话级"当前对话轮次"跟踪（任务四 ② 证据链补充）。
 *
 * 背景：桥接事件（skill-bridge / memory-bridge 的 used/selected/recalled）发生在
 * 两次 /chat/completions 之间，天然没有 turn_seq。注入侧（evidence-observer）的
 * injected 事件从 pipeline meta 的 turnSeq 取轮次（= 该请求里 human 消息数，
 * 见 handler.ts countHumanTurns）。为了让桥接事件与注入事件在同一轮次坐标系里
 * 可对齐，这里在每次主对话请求时记下当前轮次；桥接打点时查询。
 *
 * 边界：
 *   - 只覆盖 OpenAI 协议主链路（handler.ts，CodeBuddy 主目标）；claude-code /
 *     codex 的桥接事件 turn_seq 仍为空，reuseSignals 用 usedCount 兜底。
 *   - 内存 Map，进程重启即清（与 task-completion 的会话级状态同寿命）。
 *   - 不阻塞、无 IO；查询未命中返回 undefined（调用方容忍）。
 */

/** sessionKey → 最近一次主对话请求的 human 轮次。 */
const turnBySession = new Map<string, number>();

/** 记录某会话当前轮次（主对话请求进入时调用）。 */
export function recordChatTurn(sessionKey: string, turnSeq: number): void {
  turnBySession.set(sessionKey, turnSeq);
}

/** 查询某会话最近记录的轮次；未记录过返回 undefined。 */
export function currentChatTurn(sessionKey: string): number | undefined {
  return turnBySession.get(sessionKey);
}

/** 测试用：清空跟踪表。 */
export function __resetTurnTracker(): void {
  turnBySession.clear();
}

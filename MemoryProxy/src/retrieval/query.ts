/**
 * 任务二 检索词构建 —— 从 session_init 的 task/agent 描述拼主动检索 query。
 *
 * 弱信号启发式复刻 `skill-injector.ts` 的 `buildListingQuery`（去重小写后
 * <3 个长度≥3 的 distinct token 视为弱信号，core 会退化 mode=full / 命中差），
 * 但与它有两个差异：
 *   1. 以 `taskDetail.name`（任务名）为"新任务"最强信号，放最前；
 *   2. 只在注入器内部使用（skill-injector 保持原样，不动其行为）。
 */

import type { PrewarmInput } from "../injection/types.js";

/** 任务二检索信号（从 PrewarmInput 提取的扁平结构，便于单测）。 */
export interface Task2QuerySignals {
  taskName?: string;
  taskDescription?: string;
  taskGoal?: string;
  agentDescription?: string;
  agentPrompt?: string;
}

/**
 * 弱信号检查：合并文本去重 + 小写后 ≥3 个长度≥3 的 distinct token 才算有效。
 * 复刻 skill-injector.ts `buildListingQuery` 的启发式（保留独立副本，避免
 * 为了抽公共函数去动 skill-injector 的行为与测试）。
 */
export function hasWeakSearchSignal(text: string): boolean {
  const tokens = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
  return tokens.size >= 3;
}

/** 从 PrewarmInput 提取任务二检索信号。 */
export function signalsFromPrewarm(input: PrewarmInput): Task2QuerySignals {
  const td = input.taskDetail;
  const ad = input.agentDetail;
  return {
    taskName: td?.name,
    taskDescription: td?.description,
    taskGoal: td?.goal,
    agentDescription: ad?.description,
    agentPrompt: ad?.prompt,
  };
}

/**
 * 构建任务二主动检索词。优先级：任务名 > task 描述 > task goal > agent 描述/prompt。
 * 弱信号或空 → undefined（注入器返回空候选，不造弱注入）。
 */
export function buildTask2Query(signals: Task2QuerySignals): string | undefined {
  const parts: string[] = [];
  if (signals.taskName?.trim()) parts.push(signals.taskName.trim());
  if (signals.taskDescription?.trim()) parts.push(signals.taskDescription.trim());
  if (signals.taskGoal?.trim()) parts.push(signals.taskGoal.trim());
  if (signals.agentDescription?.trim()) parts.push(signals.agentDescription.trim());
  if (signals.agentPrompt?.trim()) parts.push(signals.agentPrompt.trim());

  const combined = parts.join(" ").trim();
  if (!combined) return undefined;
  if (!hasWeakSearchSignal(combined)) return undefined;
  return combined;
}

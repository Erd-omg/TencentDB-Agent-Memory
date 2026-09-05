/**
 * 任务二 任务分类路由 —— 规则式意图识别。
 *
 * 输入：task 名/描述/goal（prewarm）或用户 query（execute 自 heal）；
 * 输出：TaskType + 该任务类型需要的资产桶优先级（对齐 demo 面板1 路由 chip：
 * Bug Fix → 失败经验 > 历史方案 > 代码知识 > 项目约定 > Skill > 产品知识）。
 *
 * 关键词规则来自 `config.retrieval.router.rules`（TaskType → 逗号分隔关键词）。
 * 桶优先级是代码常量（v1 不做配置化，避免过度设计）。
 */

import type { AssetBucket, TaskType } from "./types.js";

/** 每类任务 → 资产内容桶优先级（demo 面板1 路由 chip 的扩展：覆盖六类任务）。 */
export const DEFAULT_TASK_PRIORITY: Record<TaskType, AssetBucket[]> = {
  bug_fix: ["失败经验", "历史方案", "代码知识", "项目约定", "Skill", "产品知识"],
  feature: ["历史方案", "代码知识", "Skill", "产品知识", "项目约定", "失败经验"],
  refactor: ["代码知识", "历史方案", "项目约定", "Skill", "失败经验", "产品知识"],
  review: ["项目约定", "代码知识", "历史方案", "Skill", "产品知识", "失败经验"],
  devops: ["历史方案", "失败经验", "Skill", "项目约定", "产品知识", "代码知识"],
  general: ["历史方案", "Skill", "失败经验", "代码知识", "项目约定", "产品知识"],
};

/** 任务分类信号（只用到这些文本）。 */
export interface TaskSignals {
  name?: string;
  description?: string;
  goal?: string;
  query?: string;
}

const KNOWN_TASK_TYPES: readonly string[] = [
  "bug_fix",
  "feature",
  "refactor",
  "review",
  "devops",
  "general",
];

/**
 * 规则式分类：所有信号文本合并小写，逐规则统计关键词命中数，命中最多者胜
 * （并列取 rules 插入序靠前者）。无命中或命中的是未知规则键 → "general"。
 */
export function classifyTask(
  signals: TaskSignals,
  rules: Record<string, string>,
): TaskType {
  const text = [signals.name, signals.description, signals.goal, signals.query]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();

  let bestKey: string | null = null;
  let bestHits = 0;
  for (const [key, keywordCsv] of Object.entries(rules)) {
    if (!KNOWN_TASK_TYPES.includes(key)) continue;
    const keywords = keywordCsv
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);
    let hits = 0;
    for (const kw of keywords) {
      if (kw && text.includes(kw)) hits++;
    }
    if (hits > bestHits) {
      bestKey = key;
      bestHits = hits;
    }
  }
  if (bestKey) return bestKey as TaskType;
  return "general";
}

/** 任务类型 → 资产桶优先级。未知类型回退 general。 */
export function assetPriorityForTask(taskType: TaskType): AssetBucket[] {
  return DEFAULT_TASK_PRIORITY[taskType] ?? DEFAULT_TASK_PRIORITY.general;
}

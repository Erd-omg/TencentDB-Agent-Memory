/**
 * 任务二 资产内容类型桶 —— 从 skill 的 name/description 关键词归类到六桶。
 *
 * 用途：① 注入块 pill 标签（对齐 demo 面板1 六类资产）；② 任务分类路由的
 * 桶优先级匹配（task-router 的优先级数组按桶序决定相关性微调）。
 */

import type { AssetBucket } from "./types.js";

/** 桶 → 关键词（命中数最多者胜，并列取表序靠前者；无命中 → "Skill" 兜底）。 */
const BUCKET_KEYWORDS: ReadonlyArray<{ bucket: AssetBucket; keywords: readonly string[] }> = [
  {
    bucket: "失败经验",
    keywords: ["失败", "踩坑", "教训", "规避", "workaround", "pitfall", "常见问题", "故障", "报错", "error", "issue", "复盘", "postmortem", "错误"],
  },
  {
    bucket: "历史方案",
    keywords: ["方案", "sop", "指南", "guide", "教程", "how-to", "runbook", "步骤", "流程", "迁移", "handbook", "最佳实践", "solutions"],
  },
  {
    bucket: "代码知识",
    keywords: ["代码", "调用", "接口", "api", "函数", "依赖", "影响路径", "结构", "源码", "实现", "分析", "trace", "调用关系"],
  },
  {
    bucket: "项目约定",
    keywords: ["约定", "规范", "标准", "convention", "style", "格式", "编码", "目录结构", "standards"],
  },
  {
    bucket: "产品知识",
    keywords: ["产品", "需求", "业务", "幂等", "product", "business", "用户", "场景", "重试", "retry"],
  },
  // "Skill" 桶无关键词 —— 只作兜底默认，任何命中都不计入它。
];

/** 把一条 skill 归入六桶之一。 */
export function categorizeSkill(hit: { name?: string; description?: string }): AssetBucket {
  const text = [hit.name, hit.description]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();

  let best: AssetBucket = "Skill";
  let bestHits = 0;
  for (const { bucket, keywords } of BUCKET_KEYWORDS) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw && text.includes(kw)) hits++;
    }
    if (hits > bestHits) {
      best = bucket;
      bestHits = hits;
    }
  }
  return best;
}

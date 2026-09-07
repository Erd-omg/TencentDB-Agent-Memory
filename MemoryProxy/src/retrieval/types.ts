/**
 * 任务二「面向新任务的检索与最小上下文」— 共享类型。
 *
 * 链路：任务分类路由（task-router）→ 主动检索 → 六维重排（rerank）→
 * 预算裁剪（budget）→ 资产类型桶（categorize）→ 注入 `<task2_selected_assets>`。
 *
 * 六维口径（对齐 docs/competition-task4-understanding.md §9）：
 *   相关性 × 可信度 × 新鲜度 × 环境兼容性 × 历史效果 × Token 成本。
 * 各维归一化到 [0,1]，加权总分 ∈ [0,1]，selectedThreshold 只对归一化总分有意义
 * （core search score 当前是 -bm25，无界，相关性维在候选集内 min-max 归一化）。
 */

import type { SearchHit } from "../skill/core-client.js";
import type { AssetRef, AssetType } from "../db/asset-event.js";
import type { AssetEventRepo } from "../db/assetEventRepo.js";

/** 任务类型（任务分类路由输出）。 */
export type TaskType =
  | "bug_fix"
  | "feature"
  | "refactor"
  | "review"
  | "devops"
  | "general";

/** 资产内容类型桶（对齐竞赛六类资产 + demo 面板1 pill）。 */
export type AssetBucket =
  | "历史方案"
  | "失败经验"
  | "代码知识"
  | "项目约定"
  | "Skill"
  | "产品知识";

/**
 * 任务二候选来源（多源，来源轴 × 六桶内容轴正交 —— 任务二 #1 主诉求）：
 *   - team-skill：团队 Skill（含 team-visible + agent 自有）
 *   - chat-memory：绑定代理的 L1 原子（self + 借调 ≤2，逐 ctx 扇出 /v3/atomic/search）
 *   - wiki：注册到团队的 wiki 知识库（正文经 KS /wiki/search）
 */
export type RetrievalSourceId = "team-skill" | "chat-memory" | "wiki";

/**
 * 规范化候选（把 skill SearchHit / chat-memory atom / wiki 页归一成同一形状，
 * rerank/injector/事件都只认它，不再强耦合 skill SearchHit）。
 */
export interface RetrievalHit {
  assetId: string;
  assetType: AssetType;
  name?: string;
  description?: string;
  /** 命中摘录 / why 片段（≤512B 指针）。 */
  snippet?: string;
  /** 来源相关度分（**全候选池一次 min-max 归一化**，非分类型校准；各源原始分
   * 尺度不同（skill -bm25 / atomic / wiki BM25），属池内相对信号；无 RRF、无按来源加权混合）。 */
  score?: number;
  version?: string | number;
  ownerAgentId?: string;
  ownerName?: string;
  teamId?: string;
  updatedAtMs?: number;
  createdAtMs?: number;
  /** 借调记忆的身份标注：self / imported_from。 */
  sourceRole?: "self" | "imported_from";
  /** 候选来源。 */
  sourceId?: RetrievalSourceId;
}

/** skill SearchHit → RetrievalHit（技能正文检索候选统一入口）。 */
export function skillHitToRetrieval(h: SearchHit): RetrievalHit {
  return {
    assetId: h.skill_id,
    assetType: "skill",
    name: h.name,
    description: h.description,
    snippet: h.snippet,
    score: h.score,
    version: h.version,
    ownerAgentId: h.owner_agent_id,
    ownerName: h.owner_agent_id,
    teamId: h.team_id,
    updatedAtMs: h.updated_at_ms,
    createdAtMs: h.created_at_ms,
    sourceId: "team-skill",
  };
}

/** 六维重排分值（各维度归一化到 [0,1]）。 */
export interface DimScores {
  relevance: number;
  credibility: number;
  freshness: number;
  envCompat: number;
  historicalEffect: number;
  tokenCost: number;
}

/** 一条重排后的候选（含六维分、加权总分、名次、是否入选）。 */
export interface RerankedCandidate {
  hit: RetrievalHit;
  /** 落 asset_event 用的资产引用（score=来源原始分，source=归属）。 */
  asset: AssetRef;
  /** 内容类型桶（pill）。 */
  bucket: AssetBucket;
  dimScores: DimScores;
  /** 加权总分（∈[0,1]）。 */
  weightedScore: number;
  /** 按加权总分降序的名次（1-based）。 */
  rank: number;
  /** 是否入选：weightedScore ≥ threshold AND rank ≤ topN。 */
  passed: boolean;
}

/** 重排上下文（会话身份 + 检索词）。 */
export interface RerankContext {
  teamId: string;
  agentId: string;
  taskId?: string;
  userId?: string;
  sessionKey: string;
  query: string;
}

/** 重排外部依赖（可注入以便单测）。 */
export interface RerankDeps {
  /** asset_event 仓库（可信度/历史效果维数据源）。缺省走单例。 */
  repo?: AssetEventRepo | null;
  /** 时钟（新鲜度维用）。 */
  now?: () => number;
}

/** 重排配置切片（注入器从 RetrievalConfig 取）。 */
export interface RerankConfigShape {
  weights: {
    relevance: number;
    credibility: number;
    freshness: number;
    envCompat: number;
    historicalEffect: number;
    tokenCost: number;
  };
  selectedThreshold: number;
  topN: number;
  /** 新鲜度半衰期（天）。 */
  freshnessHalfLifeDays: number;
  /**
   * 历史效果/可信度聚合过滤（可选，见 ProxyConfig.retrieval.effect）：
   * sameTeamOnly=true 只计同 team；windowDays 只计最近 N 天。缺省生效（不传等同默认）。
   */
  effect?: {
    sameTeamOnly?: boolean;
    windowDays?: number;
  };
}

/** 预算裁剪结果。 */
export interface BudgetResult {
  /** 预算内保留（将注入）。 */
  kept: RerankedCandidate[];
  /** 入选但超出预算被裁剪（落 selected 但不落 injected，保留"为何排除"证据）。 */
  trimmed: RerankedCandidate[];
}

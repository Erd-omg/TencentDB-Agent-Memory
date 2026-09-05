/**
 * asset_event 共享类型 —— 任务三「资产使用链路记录与可信归因」。
 *
 * 证据链七阶段（赛题定义）：
 *   recalled → selected → injected → used → validated → corrected → contributed
 *
 * 设计原则（docs/competition-task4-understanding.md §8 / §9 任务三）：
 *   - 证据独立于 LLM 自述：只有结构化事实（工具调用 / diff / 验证器回调）
 *     才能宣称"被使用 / 被验证"，避免"仅被召回就宣称有效"。
 *   - 事件即事实：每阶段一条记录，供任务四回执聚合、任务五评测引用。
 */

/** 证据链阶段枚举（稳定字符串，持久化到 asset_event.stage）。 */
export type AssetEventStage =
  | "recalled"
  | "selected"
  | "injected"
  | "used"
  | "validated"
  | "corrected"
  | "contributed";

/** 资产类型（对齐竞赛六类资产 + v2 内部类型）。 */
export type AssetType =
  | "skill"           // 可复用 SOP
  | "chat-memory"     // L0–L3 记忆
  | "profile"         // L3 长期画像
  | "wiki"
  | "code-graph"
  | "product-knowledge";

/** 一条资产的轻量引用（注入 / 使用 / 验证打点都带上）。 */
export interface AssetRef {
  /** 资产唯一 id（skill_id / atomic id / persona id …）。 */
  assetId: string;
  assetType: AssetType;
  /** 版本号（skill version / 记忆 updatedAt 简化）。 */
  version?: string | number;
  /** 展示名（skill name / 记忆摘要前缀 / 画像名）。 */
  name?: string;
  /** 召回 / 命中相关度分。 */
  score?: number;
  /** 来源归属："self" | "team" | "imported_from" | agent_id。 */
  source?: string;
}

/** 结构化证据体 —— 独立于 LLM 自述的事实来源。 */
export interface AssetEventEvidence {
  /** 证据来源（corrected：`user` 用户主动纠正 / `validator` 验证器判错）。 */
  source?: string;
  /** 决策证据（selected：为什么选 / 排除）。 */
  decision?: string;
  /** 代码变更证据（validated / corrected：关联 diff）。 */
  code_diff?: string;
  /** 结果证据（赛题 F2：资产使用后的可观测结果，建立 资产→决策/变更→结果 归因）。 */
  outcome?: string;
  /** 工具调用证据（used：哪个工具 / 端点 / 查询）。 */
  tool_call?: {
    bridge: "skill-bridge" | "memory-bridge";
    endpoint: string;       // sub path，如 skill/search、atomic/search
    query?: string;         // 检索词
    snippet?: string;       // 命中摘录（≤512B）
    httpStatus?: number;
  };
  /** 测试结果证据（validated / corrected）。 */
  test_result?: {
    runner: string;         // "vitest" | "command" | ...
    command?: string;
    exitCode: number;
    output?: string;        // 截断输出摘录
    durationMs?: number;
  };
  /** 验证器证据（validated / corrected）。 */
  validator?: {
    id: string;
    pass: boolean;
    detail?: string;
  };
  /**
   * 任务二 六维重排决策证据（selected(decision="rerank")）。
   * 记录"选了谁 / 为什么 / 排除谁"：加权总分 + 六维分 + 入选判定 + 是否被预算裁剪。
   * 与 selected(decision="direct-read") 用 decision 字段区分。
   */
  rerank?: {
    weightedScore: number;
    dims: {
      relevance: number;
      credibility: number;
      freshness: number;
      envCompat: number;
      historicalEffect: number;
      tokenCost: number;
    };
    passed: boolean;
    /** 入选但超出 token 预算被裁剪（落 selected 但不落 injected）。 */
    trimmedByBudget: boolean;
    rank: number;
    threshold: number;
  };
}

/** 一条持久化的资产事件（asset_event 表行）。 */
export interface AssetEvent {
  id: string;
  stage: AssetEventStage;
  asset: AssetRef;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  teamId?: string;
  userId?: string;
  turnSeq?: number;
  evidence?: AssetEventEvidence;
  /** 低置信 / 冲突 / 过期风险标记（任务二 confidence 维度预留）。 */
  confidence?: string;
  /** epoch ms。 */
  createdAt: number;
}

/** 一张回执用：某资产的阶段汇总。 */
export interface AssetStageSummary {
  asset: AssetRef;
  stages: AssetEventStage[];
  /** 各阶段最新事件时间。 */
  lastStageAt: Record<AssetEventStage, number>;
}

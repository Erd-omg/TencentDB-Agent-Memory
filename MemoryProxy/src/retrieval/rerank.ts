/**
 * 任务二 六维重排 —— 对主动检索候选做多阶段重排。
 *
 * 六维口径（权重默认值见 config.ts DEFAULT_CONFIG.retrieval.rerank.weights，此处不重复数值）：
 *   相关性 × 可信度 × 历史效果 × 新鲜度 × 环境兼容性 × Token成本。
 *
 * 输入为规范化候选 RetrievalHit（skill / chat-memory / wiki 归一），不再耦合 skill SearchHit：
 *   - 相关性维对候选集内 score 做 min-max 归一化（core -bm25 / atomic 等无界分可比）；
 *   - 可信度/历史效果来自 asset_event 表，按 assetId 跨会话聚合，经 cfg.effect 收敛到
 *     「同 team + 时间窗」——跨 team / 过期的 validated/used 不再抬高他人资产的可信度。
 *   - 桶（六类内容标签）由 name/description 推断 → taskMatch 让"Bug Fix 要失败经验"影响排序。
 */

import { getAssetEventRepo, type AssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEventStage } from "../db/asset-event.js";
import { categorizeSkill } from "./categorize.js";
import { estimateTokens } from "./budget.js";
import { assetPriorityForTask } from "./task-router.js";
import type {
  AssetBucket,
  DimScores,
  RerankConfigShape,
  RerankContext,
  RerankDeps,
  RerankedCandidate,
  RetrievalHit,
  TaskType,
} from "./types.js";

/** 任务分类路由对相关性维的贡献占比（0.7 归一化分 + 0.3 桶匹配）。 */
const TASK_MATCH_BLEND = 0.3;
/** tokenCost 维的"贵"阈值（内容 ≥ 此 token 数视为满成本）。 */
const COST_MAX_TOKENS = 1500;
/** 缺 updated_at / 无历史时的中性分。 */
const NEUTRAL = 0.5;
/** 桶优先级里找不到的桶的 taskMatch 下限。 */
const TASK_MATCH_UNKNOWN_BUCKET = 0.2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 从候选集内对原始 score 做 min-max 归一化（全相等 → 0.5）。 */
function minMaxNormalize(scores: number[]): number[] {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min < 1e-9) return scores.map(() => NEUTRAL);
  return scores.map((s) => (s - min) / (max - min));
}

/** 阶段计数（跨会话按 assetId 聚合；可按 team/时间窗过滤——历史效果收敛）。 */
function stageCounts(
  repo: AssetEventRepo | null,
  assetId: string,
  teamScope: string | undefined,
  sinceMs: number | undefined,
): {
  validated: number;
  used: number;
  corrected: number;
  contributed: number;
} {
  const out = { validated: 0, used: 0, corrected: 0, contributed: 0 };
  if (!repo) return out;
  let events;
  try {
    events = repo.byAssetId(assetId, {
      ...(teamScope ? { teamId: teamScope } : {}),
      ...(typeof sinceMs === "number" ? { sinceMs } : {}),
    });
  } catch {
    return out;
  }
  for (const e of events) {
    const stage = e.stage as AssetEventStage;
    if (stage === "validated") out.validated++;
    else if (stage === "used") out.used++;
    else if (stage === "corrected") out.corrected++;
    else if (stage === "contributed") out.contributed++;
  }
  return out;
}

/**
 * 可信度：contributed（证据链终点，测试通过+保守归因通过）与 validated 同为强信号（×2）、
 * used 中、无历史中性；有 corrected → 打对折。
 * teamScope/sinceMs 交给 stageCounts 收敛（同 team + 时间窗，避免他人/过期待验证当高可信）。
 *
 * ⚠️ 去重语义（方案 A）：contributed 是 validated 的**严格子集**——finalize 里 validated
 * 写成功后**立即追加** contributed（同资产、同任务），二者必然成对出现。若简单相加
 * `(validated + contributed) * 2`，会把「同一份贡献」重复计成 2 次强信号，系统性抬升
 * 刚结束任务的资产分数。因此用 `strong = Math.max(validated, contributed)` 去重：一次
 * 贡献只算一次强信号（contributed 覆盖 validated，语义 = 「验证」升级为「已贡献」）。
 */
function credibilityFrom(
  repo: AssetEventRepo | null,
  assetId: string,
  teamScope: string | undefined,
  sinceMs: number | undefined,
): number {
  const { validated, used, corrected, contributed } = stageCounts(repo, assetId, teamScope, sinceMs);
  if (validated + used + corrected + contributed === 0) return NEUTRAL;
  const strong = Math.max(validated, contributed);
  const base = Math.min(1, (strong * 2 + used) / 6);
  return base * (corrected === 0 ? 1 : 0.5);
}

/**
 * 历史效果（跨 agent/团队内复用信号）：有效复用比 = (strong + 0.5·used) / 复用次数，
 * corrected 拉低。无复用历史 → 中性。
 * contributed 是证据链终点（validated 的严格子集：真测试通过 + 保守归因通过），此处用
 * `strong = Math.max(validated, contributed)` 去重（见 credibilityFrom 方案 A 说明）——
 * 同一次「贡献」不被 validated 与 contributed 重复计入复用比，避免同一证据双算。
 */
function historicalEffectFrom(
  repo: AssetEventRepo | null,
  assetId: string,
  teamScope: string | undefined,
  sinceMs: number | undefined,
): number {
  const { validated, used, corrected, contributed } = stageCounts(repo, assetId, teamScope, sinceMs);
  if (used + validated + contributed === 0) return NEUTRAL;
  const strong = Math.max(validated, contributed);
  const ratio = (strong + 0.5 * used) / Math.max(1, used + strong);
  return Math.max(0, Math.min(1, ratio - (corrected > 0 ? 0.2 : 0)));
}

/** 新鲜度：0.5^(Δ/半衰期)，缺 updated_at → 中性。 */
function freshnessFrom(
  updatedAtMs: number | undefined,
  now: number,
  halfLifeDays: number,
): number {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return NEUTRAL;
  }
  const deltaDays = Math.max(0, (now - updatedAtMs) / DAY_MS);
  return Math.pow(0.5, deltaDays / halfLifeDays);
}

/** 环境兼容性：同 agent 1.0 / 同 team 0.7 / 跨 team 0.3 / 缺 owner 0.5。 */
function envCompatFrom(hit: RetrievalHit, ctx: RerankContext): number {
  if (!hit.ownerAgentId) return NEUTRAL;
  if (hit.ownerAgentId === ctx.agentId) return 1.0;
  if (hit.teamId && hit.teamId === ctx.teamId) return 0.7;
  return 0.3;
}

/** tokenCost：内容越短越"便宜"分越高。 */
function tokenCostFrom(hit: RetrievalHit): number {
  const text = [hit.name, hit.description, hit.snippet]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
  const est = estimateTokens(text);
  return 1 - Math.min(1, est / COST_MAX_TOKENS);
}

/** 桶在优先级数组中的匹配度（数组首 → 1.0，未出现 → 0.2）。 */
function taskMatchFor(bucket: AssetBucket, priority: AssetBucket[] | undefined): number {
  if (!priority) return NEUTRAL;
  const idx = priority.indexOf(bucket);
  if (idx < 0) return TASK_MATCH_UNKNOWN_BUCKET;
  return (priority.length - 1 - idx) / Math.max(1, priority.length - 1);
}

/** 落事件的来源归属：借调 → owner agent；self → "self"；同 team 无主 → "team"。 */
function sourceOf(hit: RetrievalHit, ctx: RerankContext): string {
  if (hit.sourceRole === "imported_from") return hit.ownerAgentId ?? "team";
  if (hit.ownerAgentId === ctx.agentId) return "self";
  return hit.ownerAgentId ?? "team";
}

/**
 * 六维重排。输入规范化候选 + 会话上下文 + 重排配置，输出按加权总分
 * 降序、带 rank/passed 的候选列表。纯函数（repo/now 由 deps 注入）。
 */
export function rerankCandidates(args: {
  hits: RetrievalHit[];
  ctx: RerankContext;
  cfg: RerankConfigShape;
  /** 任务类型（可选）；给出时按桶优先级微调相关性维。 */
  taskType?: TaskType;
  deps?: RerankDeps;
}): RerankedCandidate[] {
  const { hits, ctx, cfg, taskType, deps } = args;
  if (hits.length === 0) return [];

  const repo = deps?.repo !== undefined ? deps.repo : getAssetEventRepo();
  const now = deps?.now ? deps.now() : Date.now();
  const priority = taskType ? assetPriorityForTask(taskType) : undefined;

  // 历史效果收敛（#3）：同 team 才计入 + 时间窗（缺省 90 天）。跨 team / 过期的
  // validated/used 不再抬高他人资产的可信度（旧行 team 为空按同部署计入，不丢历史）。
  const effect = cfg.effect ?? {};
  const sameTeamOnly = effect.sameTeamOnly ?? true;
  const windowDays = effect.windowDays ?? 90;
  const teamScope = sameTeamOnly && ctx.teamId ? ctx.teamId : undefined;
  const sinceMs = windowDays > 0 ? now - windowDays * DAY_MS : undefined;

  const rawScores = hits.map((h) =>
    typeof h.score === "number" && Number.isFinite(h.score) ? h.score : 0,
  );
  const normScores = minMaxNormalize(rawScores);

  const ranked: RerankedCandidate[] = hits.map((hit, i) => {
    const bucket = categorizeSkill(hit);
    const norm = normScores[i];
    const relevance = Math.max(
      0,
      Math.min(1, (1 - TASK_MATCH_BLEND) * norm + TASK_MATCH_BLEND * taskMatchFor(bucket, priority)),
    );
    const dimScores: DimScores = {
      relevance,
      credibility: credibilityFrom(repo, hit.assetId, teamScope, sinceMs),
      freshness: freshnessFrom(hit.updatedAtMs ?? hit.createdAtMs, now, cfg.freshnessHalfLifeDays),
      envCompat: envCompatFrom(hit, ctx),
      historicalEffect: historicalEffectFrom(repo, hit.assetId, teamScope, sinceMs),
      tokenCost: tokenCostFrom(hit),
    };
    const weightedScore =
      cfg.weights.relevance * dimScores.relevance
      + cfg.weights.credibility * dimScores.credibility
      + cfg.weights.freshness * dimScores.freshness
      + cfg.weights.envCompat * dimScores.envCompat
      + cfg.weights.historicalEffect * dimScores.historicalEffect
      + cfg.weights.tokenCost * dimScores.tokenCost;

    return {
      hit,
      asset: {
        assetId: hit.assetId,
        assetType: hit.assetType,
        version: hit.version,
        name: hit.name,
        score: hit.score,
        source: sourceOf(hit, ctx),
      },
      bucket,
      dimScores,
      weightedScore,
      rank: 0,
      passed: false,
    };
  });

  ranked.sort(
    (a, b) =>
      b.weightedScore - a.weightedScore
      || b.dimScores.relevance - a.dimScores.relevance
      || (a.hit.name ?? "").localeCompare(b.hit.name ?? ""),
  );
  ranked.forEach((c, i) => {
    c.rank = i + 1;
    // 双条件：加权总分过阈值 AND 名次 ≤ topN（候选集小时纯阈值会全选，topN 兜底）。
    c.passed = c.weightedScore >= cfg.selectedThreshold && c.rank <= cfg.topN;
  });
  return ranked;
}

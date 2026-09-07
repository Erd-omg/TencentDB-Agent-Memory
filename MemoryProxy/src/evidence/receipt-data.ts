/**
 * 回执数据聚合（任务四 深化）—— 命令（mem:receipt）与 HTTP API（/v3/evidence/*）
 * 共享的纯聚合层，消除重复。数据全部来自 asset_event 表，非 LLM 自述。
 *
 * 职责：
 *   - buildReceiptData：把 asset_event 聚合为"回执视图"（资产卡 + 汇总 + 证据链）。
 *   - buildReceiptJson：把视图序列化为结构 JSON（mem:receipt 的 data + HTTP 响应体）。
 */

import { getAssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEvent, AssetEventStage, AssetRef, AssetStageSummary } from "../db/asset-event.js";
import { validateChains, type ChainIssue } from "./chain-validator.js";
import { evaluateEffectiveness, effectivenessCounts, type AssetEffectiveness } from "./effectiveness.js";
import { evaluateRisks, type AssetRisk } from "./risk.js";

/** 一张资产卡（含全部原始事件，供证据展开 / 深潜）。 */
export interface ReceiptAsset {
  asset_id: string;
  asset_type: AssetRef["assetType"];
  name?: string;
  version?: string | number;
  source?: string;
  score?: number;
  stages: AssetEventStage[];
  last_stage_at: Record<AssetEventStage, number>;
  effectiveness: AssetEffectiveness;
  risks: AssetRisk[];
  events: AssetEvent[];
}

/** 会话级回执视图。 */
export interface ReceiptData {
  sessionKey: string;
  events: AssetEvent[];
  summaries: AssetStageSummary[];
  stageCounts: Record<AssetEventStage, number>;
  effectiveness: Record<AssetEffectiveness, number>;
  chainIssues: ChainIssue[];
  assets: ReceiptAsset[];
}

/** 按资产去重：各阶段触及的 distinct 资产数（回执默认口径）。事件计数见 stageCounts。 */
export function distinctStageCounts(assets: ReceiptAsset[]): Record<AssetEventStage, number> {
  const out = {} as Record<AssetEventStage, number>;
  for (const a of assets) {
    for (const s of a.stages) out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/**
 * 聚合某会话的回执数据。DB 不可用 / 无事件 → 返回 null（调用方降级）。
 */
export function buildReceiptData(sessionKey: string): ReceiptData | null {
  const repo = getAssetEventRepo();
  if (!repo) return null;
  const events = repo.bySessionKey(sessionKey);
  if (events.length === 0) return null;
  const summaries = repo.distinctAssets(sessionKey);
  const stageCounts = repo.stageCounts(sessionKey);

  const assets: ReceiptAsset[] = summaries.map((s) => {
    const mine = events.filter((e) => e.asset.assetId === s.asset.assetId);
    return {
      asset_id: s.asset.assetId,
      asset_type: s.asset.assetType,
      name: s.asset.name,
      version: s.asset.version,
      source: s.asset.source,
      score: s.asset.score,
      stages: s.stages,
      last_stage_at: s.lastStageAt,
      effectiveness: evaluateEffectiveness(s, events),
      risks: evaluateRisks(s, events),
      events: mine,
    };
  });

  return {
    sessionKey,
    events,
    summaries,
    stageCounts,
    effectiveness: effectivenessCounts(summaries, events),
    chainIssues: validateChains(summaries),
    assets,
  };
}

/** 事件的安全序列化（供 Panel 证据展开 / HTTP 响应）。 */
function eventJson(e: AssetEvent): Record<string, unknown> {
  return {
    id: e.id,
    stage: e.stage,
    asset_id: e.asset.assetId,
    session_id: e.sessionId,
    task_id: e.taskId,
    turn_seq: e.turnSeq,
    evidence: e.evidence,
    created_at: e.createdAt,
  };
}

/** 序列化回执视图为结构 JSON（mem:receipt data 与 GET /v3/evidence/receipt 共用）。 */
export function buildReceiptJson(data: ReceiptData): Record<string, unknown> {
  return {
    session_key: data.sessionKey,
    asset_count: data.assets.length,
    stage_counts: data.stageCounts,
    // 两口径并存（评审边界「事件计数 vs 按资产去重」）：事件口径 stage_counts 每轮缓存重打
    // 会累加（如 injected 虚高），distinct_stage_counts 按资产去重（= 回执正文「证据链（按资产去重）」行）。
    distinct_stage_counts: distinctStageCounts(data.assets),
    effectiveness: data.effectiveness,
    chain_issues: data.chainIssues.map((i) => ({
      level: i.level,
      asset_id: i.assetId,
      missing: i.missing,
      message: i.message,
    })),
    assets: data.assets.map((a) => ({
      asset_id: a.asset_id,
      asset_type: a.asset_type,
      name: a.name,
      version: a.version,
      source: a.source,
      score: a.score,
      stages: a.stages,
      last_stage_at: a.last_stage_at,
      effectiveness: a.effectiveness,
      risks: a.risks,
      events: a.events.map(eventJson),
    })),
  };
}

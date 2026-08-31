/**
 * AssetEventRepo — asset_event 证据链持久化（任务三落库点）。
 *
 * 写路径语义（对齐 bridge-telemetry 的"埋点绝不阻塞业务"原则）：
 *   - insert() 同步、静默吞异常、绝不 throw —— 证据记录不能反过来拖垮请求。
 *   - 单例访问 `getAssetEventRepo()`，DB 初始化失败（getDb()=null）时返回 null，
 *     调用方必须视作"持久化降级"继续运行。
 *
 * 读路径：回执（mem:receipt）与评测（任务五）都从这里聚合。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "./index.js";
import type {
  AssetEvent,
  AssetEventStage,
  AssetRef,
  AssetStageSummary,
} from "./asset-event.js";

/**
 * 证据库降级可见性（P1 #8）：静默失败改有节流 WARN + 计数。
 * 此前 insert/read 全静默吞错 → DB 故障/表缺失时回执显示"空证据链"且无任何痕迹，
 * 无法区分「真的没证据」与「证据打点坏了」。现在前 3 次失败必打 WARN，之后每 100 次一条。
 */
let evtFailureCount = 0;
const EVT_WARN_EVERY = 100;
function warnEvtSilent(op: string, err: unknown): void {
  evtFailureCount += 1;
  const n = evtFailureCount;
  if (n <= 3 || n % EVT_WARN_EVERY === 0) {
    console.warn(`[asset-event] ${op} failed (#${n}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** asset_event 表行（snake_case，与 schema 对齐）。 */
interface AssetEventRow {
  id: string;
  stage: AssetEventStage;
  asset_id: string;
  asset_type: AssetRef["assetType"];
  asset_version: string | null;
  asset_name: string | null;
  score: number | null;
  source_tag: string | null;
  session_key: string;
  session_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  team_id: string | null;
  user_id: string | null;
  turn_seq: number | null;
  evidence_json: string | null;
  confidence: string | null;
  created_at: number;
}

function rowToEvent(row: AssetEventRow): AssetEvent {
  let evidence: AssetEvent["evidence"];
  if (row.evidence_json) {
    try {
      evidence = JSON.parse(row.evidence_json) as AssetEvent["evidence"];
    } catch {
      evidence = undefined;
    }
  }
  return {
    id: row.id,
    stage: row.stage,
    asset: {
      assetId: row.asset_id,
      assetType: row.asset_type,
      version: row.asset_version ?? undefined,
      name: row.asset_name ?? undefined,
      score: row.score ?? undefined,
      source: row.source_tag ?? undefined,
    },
    sessionKey: row.session_key,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    teamId: row.team_id ?? undefined,
    userId: row.user_id ?? undefined,
    turnSeq: row.turn_seq ?? undefined,
    evidence,
    confidence: row.confidence ?? undefined,
    createdAt: row.created_at,
  };
}

function jsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** 证据链全阶段集合（稳定顺序，供聚合遍历）。 */
export const ASSET_STAGES: readonly AssetEventStage[] = [
  "recalled",
  "selected",
  "injected",
  "used",
  "validated",
  "corrected",
  "contributed",
];

export class AssetEventRepo {
  constructor(private db: Database.Database) {}

  /**
   * 写一条资产事件。同步、静默失败 —— 证据记录失败绝不阻塞业务。
   */
  insert(evt: AssetEvent): void {
    try {
      const a = evt.asset;
      this.db
        .prepare(
          `INSERT INTO asset_event (
            id, stage, asset_id, asset_type, asset_version, asset_name,
            score, source_tag, session_key, session_id, task_id, agent_id,
            team_id, user_id, turn_seq, evidence_json, confidence, created_at
          ) VALUES (
            @id, @stage, @asset_id, @asset_type, @asset_version, @asset_name,
            @score, @source_tag, @session_key, @session_id, @task_id, @agent_id,
            @team_id, @user_id, @turn_seq, @evidence_json, @confidence, @created_at
          )`,
        )
        .run({
          id: evt.id,
          stage: evt.stage,
          asset_id: a.assetId,
          asset_type: a.assetType,
          asset_version: a.version === undefined ? null : String(a.version),
          asset_name: a.name ?? null,
          score: typeof a.score === "number" ? a.score : null,
          source_tag: a.source ?? null,
          session_key: evt.sessionKey,
          session_id: evt.sessionId ?? null,
          task_id: evt.taskId ?? null,
          agent_id: evt.agentId ?? null,
          team_id: evt.teamId ?? null,
          user_id: evt.userId ?? null,
          turn_seq: evt.turnSeq ?? null,
          evidence_json: jsonOrNull(evt.evidence),
          confidence: evt.confidence ?? null,
          created_at: evt.createdAt,
        });
    } catch (err) {
      // 静默：证据落库失败不阻塞请求（与 bridge-telemetry 同一原则）。
      // P1 #8：节流 WARN，避免"证据打点坏了"毫无痕迹。
      warnEvtSilent("insert", err);
    }
  }

  /** 便捷构造：用现有上下文生成一条事件（id 自动生成）。 */
  newEvent(input: {
    stage: AssetEventStage;
    asset: AssetRef;
    sessionKey: string;
    sessionId?: string;
    taskId?: string;
    agentId?: string;
    teamId?: string;
    userId?: string;
    turnSeq?: number;
    evidence?: AssetEvent["evidence"];
    confidence?: string;
    createdAt?: number;
  }): AssetEvent {
    return {
      id: `evt-${randomUUID()}`,
      stage: input.stage,
      asset: input.asset,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      teamId: input.teamId,
      userId: input.userId,
      turnSeq: input.turnSeq,
      evidence: input.evidence,
      confidence: input.confidence,
      createdAt: input.createdAt ?? Date.now(),
    };
  }

  /** 按会话取事件（可选按阶段过滤），按时间升序。 */
  bySessionKey(sessionKey: string, stage?: AssetEventStage): AssetEvent[] {
    try {
      const rows = stage
        ? this.db
            .prepare(
              "SELECT * FROM asset_event WHERE session_key = ? AND stage = ? ORDER BY created_at ASC",
            )
            .all(sessionKey, stage) as unknown as AssetEventRow[]
        : this.db
            .prepare("SELECT * FROM asset_event WHERE session_key = ? ORDER BY created_at ASC")
            .all(sessionKey) as unknown as AssetEventRow[];
      return rows.map(rowToEvent);
    } catch (err) {
      warnEvtSilent("bySessionKey", err);
      return [];
    }
  }

  /** 按任务取事件。 */
  byTaskId(taskId: string): AssetEvent[] {
    try {
      const rows = this.db
        .prepare("SELECT * FROM asset_event WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId) as unknown as AssetEventRow[];
      return rows.map(rowToEvent);
    } catch (err) {
      warnEvtSilent("byTaskId", err);
      return [];
    }
  }

  /** 按资产取事件（跨会话）。 */
  byAssetId(assetId: string): AssetEvent[] {
    try {
      const rows = this.db
        .prepare("SELECT * FROM asset_event WHERE asset_id = ? ORDER BY created_at ASC")
        .all(assetId) as unknown as AssetEventRow[];
      return rows.map(rowToEvent);
    } catch (err) {
      warnEvtSilent("byAssetId", err);
      return [];
    }
  }

  /** 最近 N 条（调试 / 演示用）。 */
  recent(limit = 50): AssetEvent[] {
    try {
      const rows = this.db
        .prepare("SELECT * FROM asset_event ORDER BY created_at DESC LIMIT ?")
        .all(limit) as unknown as AssetEventRow[];
      return rows.map(rowToEvent);
    } catch (err) {
      warnEvtSilent("recent", err);
      return [];
    }
  }

  /**
   * 最近有证据的会话列表（回执 HTTP API / Panel 会话选择用），按最近活动倒序。
   * 每会话补最近一条非空 session_id 与各阶段计数。静默降级为 []。
   */
  recentSessions(limit = 20): Array<{
    sessionKey: string;
    sessionId: string | null;
    eventCount: number;
    lastActivity: number;
    stageCounts: Record<AssetEventStage, number>;
  }> {
    try {
      const rows = this.db
        .prepare(
          "SELECT session_key, COUNT(*) AS n, MAX(created_at) AS last "
          + "FROM asset_event GROUP BY session_key ORDER BY last DESC LIMIT ?",
        )
        .all(limit) as unknown as Array<{ session_key: string; n: number; last: number }>;
      return rows.map((r) => {
        let sessionId: string | null = null;
        try {
          const idRow = this.db
            .prepare(
              "SELECT session_id FROM asset_event WHERE session_key = ? "
              + "AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
            )
            .get(r.session_key) as { session_id: string } | undefined;
          sessionId = idRow?.session_id ?? null;
        } catch {
          /* ignore */
        }
        return {
          sessionKey: r.session_key,
          sessionId,
          eventCount: r.n,
          lastActivity: r.last,
          stageCounts: this.stageCounts(r.session_key),
        };
      });
    } catch (err) {
      warnEvtSilent("recentSessions", err);
      return [];
    }
  }

  /** 某会话各阶段事件计数（回执状态行用）。 */
  stageCounts(sessionKey: string): Record<AssetEventStage, number> {
    const counts: Record<AssetEventStage, number> = {
      recalled: 0, selected: 0, injected: 0, used: 0,
      validated: 0, corrected: 0, contributed: 0,
    };
    try {
      const rows = this.db
        .prepare(
          "SELECT stage, COUNT(*) AS n FROM asset_event "
          + "WHERE session_key = ? GROUP BY stage",
        )
        .all(sessionKey) as unknown as Array<{ stage: AssetEventStage; n: number }>;
      for (const r of rows) counts[r.stage] = r.n;
    } catch (err) {
      warnEvtSilent("stageCounts", err);
      /* 降级为全 0 */
    }
    return counts;
  }

  /**
   * 某会话去重后的资产 + 各自走到的阶段（回执展开卡用）。
   * 同一资产多版本视为同一条（按 asset_id 聚合，记录最新版本）。
   */
  distinctAssets(sessionKey: string): AssetStageSummary[] {
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM asset_event WHERE session_key = ? ORDER BY created_at ASC",
        )
        .all(sessionKey) as unknown as AssetEventRow[];
      const byAsset = new Map<string, AssetStageSummary>();
      for (const r of rows) {
        const key = r.asset_id;
        const existing = byAsset.get(key);
        if (!existing) {
          byAsset.set(key, {
            asset: {
              assetId: r.asset_id,
              assetType: r.asset_type,
              version: r.asset_version ?? undefined,
              name: r.asset_name ?? undefined,
              score: r.score ?? undefined,
              source: r.source_tag ?? undefined,
            },
            stages: [],
            lastStageAt: {} as AssetStageSummary["lastStageAt"],
          });
        }
        const entry = byAsset.get(key)!;
        if (!entry.stages.includes(r.stage)) entry.stages.push(r.stage);
        entry.lastStageAt[r.stage] = r.created_at;
        // 后写的行带更新的版本/名称 → 覆盖。
        if (r.asset_version) entry.asset.version = r.asset_version;
        if (r.asset_name) entry.asset.name = r.asset_name;
      }
      return [...byAsset.values()];
    } catch (err) {
      warnEvtSilent("distinctAssets", err);
      return [];
    }
  }

  /** 清空某会话的全部事件（测试用）。 */
  clearSession(sessionKey: string): void {
    try {
      this.db.prepare("DELETE FROM asset_event WHERE session_key = ?").run(sessionKey);
    } catch {
      /* ignore */
    }
  }
}

// ── 单例访问 ─────────────────────────────────────────────────────────────────

let _repo: AssetEventRepo | null | undefined;

/**
 * 获取全局单例 AssetEventRepo。
 * 返回 null 表示 DB 不可用（持久化降级）——调用方必须容忍。
 */
export function getAssetEventRepo(): AssetEventRepo | null {
  if (_repo !== undefined) return _repo;
  const db = getDb();
  _repo = db ? new AssetEventRepo(db) : null;
  return _repo;
}

/** 重置单例（测试用）。 */
export function __resetAssetEventRepoForTests(): void {
  _repo = undefined;
}

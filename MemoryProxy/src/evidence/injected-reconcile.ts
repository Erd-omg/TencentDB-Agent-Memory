/**
 * injected 事件与真实请求的对账（P1-1 补强：自报 → 有对证）。
 *
 * 背景：injected asset_event 由 proxy 进程自己 repo.insert() 落库，属「自报」。
 * 哈希链（integrity.ts）只防落库后篡改，不防"写库那一刻就造假"。本模块引入
 * **第二数据源**做交叉核验：ClickHouse `usage_logs`（或在 ClickHouse 未启用时的
 * 本地 JSONL `logs/YYYY-MM-DD.jsonl`），它由主 handler 在 LLM 响应后独立写入
 * （不经过 EvidenceTracingObserver），带 `(session_key, turn_seq, timestamp)`。
 *
 * 对账逻辑（单向求证）：
 *   一次注入请求发生 ⇒ 该 turn 最终会有一条 usage 行（`(session_key, turn_seq)`）。
 *   因此：**每条 injected 事件都应能找到一个同 `(session_key, turn_seq)` 的 usage 行**。
 *   - 匹配 → 该注入有独立请求佐证（记为 `matched`）；
 *   - 无匹配 → 孤儿注入（`orphan`）：注入事件自报，但没有对应的真实 LLM 请求/响应，
 *     需要人工复核（可能被 abort / 403 / 或在无 usage 的路径上注入）。
 *
 * ⚠️ 边界（诚实）：
 *   1. 粒度是 (session, turn) 窗口，非 1:1 行匹配（一次请求可写多条 injected 事件）。
 *   2. usage_logs 只在**上游响应成功拿到 usage** 后写；纯工具循环轮、或上游失败轮可能无 usage，
 *      故孤儿不必然是造假，需结合时间窗口/请求日志二次判断。
 *   3. 该机制依赖 ClickHouse/JSONL 可用；不可用时对账退化（报告如实标注覆盖率）。
 */

/** 一条 injected 事件的最小对账投影。 */
export interface InjectedEventRef {
  assetId: string;
  sessionKey: string;
  turnSeq?: number;
  createdAt: number;
}

/** 一条 usage 行（真实请求佐证）的最小投影。 */
export interface UsageRowRef {
  sessionKey: string;
  turnSeq?: number;
  timestamp: number;
}

export interface ReconcileResult {
  /** 事件总数。 */
  total: number;
  /** 找到同 (session_key, turn_seq) usage 行的事件数。 */
  matched: number;
  /** 无匹配的孤儿注入事件（自报无对证，需复核）。 */
  orphans: Array<{ assetId: string; sessionKey: string; turnSeq?: number; createdAt: number }>;
  /** 匹配覆盖率 = matched / total（0~1）。 */
  matchRate: number;
  /** 对账是否可用（第二数据源为空时为 false，报告需如实标注退化）。 */
  available: boolean;
}

function key(sessionKey: string, turnSeq: number | undefined): string {
  return `${sessionKey}\u0000${turnSeq ?? ""}`;
}

/**
 * 对 injected 事件与 usage 行做 (session_key, turn_seq) 对账（纯函数，无 IO）。
 *
 * @param events  injected 事件投影（同一批/同一 session 皆可）
 * @param usage   真实请求的 usage 行投影（第二数据源）
 * @param windowMs 可选：turnSeq 缺失时的兜底时间窗口（|event.createdAt - usage.timestamp| ≤ windowMs）
 */
export function reconcileInjected(
  events: InjectedEventRef[],
  usage: UsageRowRef[],
  windowMs = 0,
): ReconcileResult {
  const available = usage.length > 0;
  const usageKeys = new Set(usage.map((u) => key(u.sessionKey, u.turnSeq)));
  // 时间窗口兜底索引：sessionKey → 该 session 的 usage 时间戳列表
  const bySessionTimes = new Map<string, number[]>();
  for (const u of usage) {
    if (!bySessionTimes.has(u.sessionKey)) bySessionTimes.set(u.sessionKey, []);
    bySessionTimes.get(u.sessionKey)!.push(u.timestamp);
  }

  const orphans: ReconcileResult["orphans"] = [];
  let matched = 0;
  for (const e of events) {
    let ok = usageKeys.has(key(e.sessionKey, e.turnSeq));
    if (!ok && windowMs > 0) {
      const times = bySessionTimes.get(e.sessionKey) ?? [];
      ok = times.some((t) => Math.abs(t - e.createdAt) <= windowMs);
    }
    if (ok) matched++;
    else orphans.push({ assetId: e.assetId, sessionKey: e.sessionKey, turnSeq: e.turnSeq, createdAt: e.createdAt });
  }
  return {
    total: events.length,
    matched,
    orphans,
    matchRate: events.length ? matched / events.length : 0,
    available,
  };
}

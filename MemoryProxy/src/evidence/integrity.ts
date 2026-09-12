/**
 * injected 证据完整性哈希链（P1-1）—— 把"自报证据"提升为"可验证的连续事实流"。
 *
 * 问题：injected 事件由 proxy 进程自己 `repo.insert()` 落库，Panel 读同一 sqlite，
 * 无第二方独立核验、无请求日志对账、无 session 重放校验。
 *
 * 本模块提供的最小可落地核验：对 injected 事件生成可验证哈希链。
 *   - `computeEventHash`：对事件不可变字段（assetId + stage + sessionKey + turnSeq + createdAt）
 *     做稳定序列化后取 sha256，得到该事件的内容哈希。
 *   - `chainEvents`：按序把每条事件链接起来（prev = 前一条 hash，首条 prev="genesis"），
 *     得到带 integrity 字段的事件列表（与落库 evidence.integrity 对齐）。
 *   - `verifyChain`：读取侧（Panel / 审计脚本）复算哈希链，校验链连续、无插入/删改/重排。
 *
 * 边界（诚实）：哈希链只防"落库后篡改/插删"，**不防**"proxy 自身在写库那一刻就造假"——
 * 那需要请求日志对账或按 session 重放校验（独立于 proxy 的第三方证据源），仍留后续。
 * 因此本机制把 injected 从"不可审计的自报"提升为"可审计的自报"，而非"独立核验"。
 */

import { createHash } from "node:crypto";

/** 参与哈希的不可变字段清单（审计复算用）。 */
export const INTEGRITY_FIELDS = ["assetId", "stage", "sessionKey", "turnSeq", "createdAt"] as const;

/** 一条待链接的最小事件（与 AssetEvent 的不可变字段子集对齐）。 */
export interface IntegrityEventInput {
  assetId: string;
  stage: string;
  sessionKey: string;
  turnSeq?: number;
  createdAt: number;
}

/** 稳定的字段序列化（避免对象属性顺序差异导致哈希漂移）。 */
function serializeField(e: IntegrityEventInput, field: string): string {
  switch (field) {
    case "assetId": return e.assetId;
    case "stage": return e.stage;
    case "sessionKey": return e.sessionKey;
    case "turnSeq": return String(e.turnSeq ?? "");
    case "createdAt": return String(e.createdAt);
    default: return "";
  }
}

/** 计算单条事件的字段内容哈希（sha256 hex）。 */
export function computeEventHash(e: IntegrityEventInput, fields: readonly string[] = INTEGRITY_FIELDS): string {
  const canonical = fields.map((f) => `${f}=${serializeField(e, f)}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** 带 integrity 的链接结果。 */
export interface ChainedIntegrityEvent extends IntegrityEventInput {
  integrity: { hash: string; prev: string; fields: string[] };
}

/**
 * 把按时间升序排列的事件串成哈希链（首条 prev="genesis"）。
 * 纯函数：不落库、不 IO；与 evidence-observer 写 injected 时复用。
 */
export function chainEvents(events: IntegrityEventInput[]): ChainedIntegrityEvent[] {
  let prev = "genesis";
  return events.map((e) => {
    const hash = computeEventHash(e);
    const out: ChainedIntegrityEvent = {
      ...e,
      integrity: { hash, prev, fields: [...INTEGRITY_FIELDS] },
    };
    prev = hash;
    return out;
  });
}

export interface IntegrityVerification {
  /** 链是否连续且无篡改。 */
  ok: boolean;
  /** 首条不一致 / 断链的下标（ok 时为 -1）。 */
  brokenAt: number;
  /** 人类可读原因（ok 时为空）。 */
  reason: string;
  /** 校验的条目数。 */
  count: number;
}

/**
 * 读取侧校验：复算每条事件的字段哈希 + 链指针，判断链是否连续、无篡改。
 * 输入应为「同 sessionKey 按时间升序」的 injected 事件（含 evidence.integrity）。
 */
export function verifyChain(
  events: Array<{ assetId: string; stage: string; sessionKey: string; turnSeq?: number; createdAt: number; integrity?: { hash: string; prev: string } }>,
): IntegrityVerification {
  let prev = "genesis";
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.integrity) {
      return { ok: false, brokenAt: i, reason: `第 ${i} 条事件缺 integrity（未走哈希链写入）`, count: events.length };
    }
    const expectedHash = computeEventHash(e);
    if (e.integrity.hash !== expectedHash) {
      return { ok: false, brokenAt: i, reason: `第 ${i} 条事件字段哈希不匹配（疑似篡改）`, count: events.length };
    }
    if (e.integrity.prev !== prev) {
      return { ok: false, brokenAt: i, reason: `第 ${i} 条事件链指针断裂（prev=${e.integrity.prev}，期望=${prev}）`, count: events.length };
    }
    prev = expectedHash;
  }
  return { ok: true, brokenAt: -1, reason: "", count: events.length };
}

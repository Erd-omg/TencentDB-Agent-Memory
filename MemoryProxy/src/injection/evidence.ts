/**
 * 注入侧证据打点共享 helper —— 任务三「injected 证据」。
 *
 * 链路：
 *   注入器在产出 ContextBlock 时把「该块实际放入 prompt 的资产列表」写进
 *   block.metadata.assets（AssetRef[]）；EvidenceTracingObserver 在
 *   onHookDone 时读这个标记，逐资产落一条 `injected` asset_event。
 *
 * 原则：
 *   - 只在真正把内容放进 prompt 的块上打标（session_init 缓存块也会带标记，
 *     所以缓存命中路径的注入同样被记录——每轮注入都会留下证据）。
 *   - 打标是纯数据附加，绝不改变块内容/缓存 key。
 */

import type { AgentContextMetadata, ContextBlock } from "./types.js";
import type { AssetRef } from "../db/asset-event.js";

/** block.metadata 上携带资产列表的键名。 */
export const ASSETS_META_KEY = "assets";

/** 给一个块附加资产列表（不改变块内容与既有 metadata）。 */
export function withBlockAssets(block: ContextBlock, assets: AssetRef[]): ContextBlock {
  if (!assets || assets.length === 0) return block;
  return {
    ...block,
    metadata: {
      ...(block.metadata ?? {}),
      [ASSETS_META_KEY]: assets,
    },
  };
}

/** 读取块上附加的资产列表（无标记返回空数组）。 */
export function getBlockAssets(block: ContextBlock): AssetRef[] {
  const raw = block.metadata?.[ASSETS_META_KEY];
  if (!Array.isArray(raw)) return [];
  return raw as AssetRef[];
}

/**
 * 一条 injected 事件需要的会话上下文，从 AgentContextMetadata 提取。
 * 身份字段在 metadata.custom.session（session-init 写入）；sessionKey /
 * turnSeq / userId 在 metadata 顶层。
 *
 * 返回 null 表示没有可归因的 sessionKey —— 无法落 injected 事件（调用方静默跳过）。
 */
export interface EvidenceContext {
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  teamId?: string;
  userId?: string;
  turnSeq?: number;
}

export function evidenceContextFromMeta(meta: AgentContextMetadata): EvidenceContext | null {
  const sessionKey = typeof meta.sessionKey === "string" && meta.sessionKey.length > 0
    ? meta.sessionKey
    : null;
  if (!sessionKey) return null;

  const session = meta.custom?.session as Record<string, unknown> | undefined;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  return {
    sessionKey,
    sessionId: pick(session?.session_id),
    taskId: pick(session?.task_id),
    agentId: pick(session?.agent_id),
    teamId: pick(session?.team_id),
    userId: meta.userId ?? pick(session?.user_id),
    turnSeq: typeof meta.turnSeq === "number" ? meta.turnSeq : undefined,
  };
}

/**
 * chat-memory 候选源 —— 把绑定代理的 L1 原子纳入任务二候选池。
 *
 * memory 数据面严格 per-(team,user,agent)，无 team-wide search。因此像 memory-bridge
 * 一样：解析 self + 借调(≤2) ctx（复用 resolveFixedAssetCtxs，ACL/绑定语义不变），
 * 对每个 ctx 打一次 `/v3/atomic/search`，按 score 汇总；内容隔离 = 只取本代理经
 * memory 工具本就能看到的 self/借调片段（指针级别，非跨团队拉取他人隐私）。
 *
 * 语义：chat-memory 命中是「历史经验/记忆」候选（L1），assetType=chat-memory，
 * assetId=原子 id（m_*，与 memory-bridge 证据同 id → 历史效果/可信度可聚合）。
 */

import type { RetrievalHit } from "../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "../../injection/injectors/tdai-fixed-asset.js";
import type { AgentContext } from "../../injection/types.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import type { CoreSkillConfig, TdaiConfig } from "../../types.js";

export interface ChatMemorySourceEnv {
  core: CoreSkillConfig;
  tdai?: TdaiConfig;
  teamId: string;
  userId: string;
  agentId: string;
  userKey?: string;
  spaceId?: string;
  taskId?: string;
  sessionKey: string;
  query: string;
  perAgentLimit?: number;
  fetcher?: typeof fetch;
}

/** 借调 ctx 解析（self + ≤2；无 user_key 时只 self）。 */
async function resolveMemoryCtxs(env: ChatMemorySourceEnv): Promise<FixedAssetCtx[]> {
  const selfCtx: FixedAssetCtx = {
    teamId: env.teamId,
    userId: env.userId,
    agentId: env.agentId,
    agentName: env.agentId,
    isSelf: true,
  };
  if (!env.userKey) return [selfCtx];
  try {
    const serviceId = env.spaceId || env.tdai?.serviceId || env.core.serviceId;
    const metadataClient = getMetadataClient(env.core, serviceId, env.userKey);
    const identity: TdaiIdentity = {
      teamId: env.teamId,
      userId: env.userId,
      agentId: env.agentId,
      sessionId: "",
      taskId: env.taskId,
      userKey: env.userKey,
    };
    const fakeCtx: AgentContext = {
      messages: [],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: `task2-chatmem:${env.sessionKey}`,
        keyId: env.sessionKey,
        modelId: "task2-chatmem",
        stream: false,
        agentSource: "task2",
        custom: { userKey: env.userKey },
      },
    };
    return await resolveFixedAssetCtxs(fakeCtx, identity, metadataClient);
  } catch {
    return [selfCtx];
  }
}

/** 单条原子 → RetrievalHit（name=正文前缀，与 used-evidence 命名一致）。 */
export function atomToRetrievalHit(
  item: Record<string, unknown>,
  ctx: FixedAssetCtx,
): RetrievalHit | null {
  if (typeof item.id !== "string" || typeof item.content !== "string") return null;
  const content = (item.content as string).replace(/\s+/g, " ").trim();
  if (!content) return null;
  const updatedRaw = item.updated_at;
  let updatedAtMs: number | undefined;
  if (typeof updatedRaw === "number") updatedAtMs = updatedRaw;
  else if (typeof updatedRaw === "string" && updatedRaw) {
    const t = Date.parse(updatedRaw);
    if (!Number.isNaN(t)) updatedAtMs = t;
  }
  return {
    assetId: item.id as string,
    assetType: "chat-memory",
    name: content.slice(0, 60),
    description: undefined,
    snippet: content.slice(0, 220),
    score: typeof item.score === "number" ? item.score : undefined,
    ownerAgentId: ctx.agentId,
    ownerName: ctx.agentName,
    teamId: ctx.teamId,
    updatedAtMs,
    sourceRole: ctx.isSelf ? "self" : "imported_from",
    sourceId: "chat-memory",
  };
}

/** 收集 chat-memory 候选（self + 借调逐 ctx 扇出）。任一 ctx 失败降级跳过。 */
export async function collectChatMemoryHits(env: ChatMemorySourceEnv): Promise<RetrievalHit[]> {
  if (!env.query.trim()) return [];
  const fetcher = env.fetcher ?? globalThis.fetch.bind(globalThis);
  const ctxs = await resolveMemoryCtxs(env);
  const limit = env.perAgentLimit ?? 5;
  const base = env.core.endpoint.replace(/\/+$/, "");
  const token = env.tdai?.apiKey || env.core.serviceToken || "local-proxy";
  const svc = env.spaceId || env.tdai?.serviceId || env.core.serviceId;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-tdai-service-id": svc,
    "Content-Type": "application/json",
  };

  const out: RetrievalHit[] = [];
  for (const ctx of ctxs) {
    try {
      const body = {
        team_id: ctx.teamId,
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        ...(env.taskId ? { task_id: env.taskId } : {}),
        query: env.query.slice(0, 2048),
        limit,
      };
      const resp = await fetcher(`${base}/v3/atomic/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(5000, env.core.timeoutMs * 4 || 10_000)),
      });
      if (!resp.ok) continue;
      const parsed = (await resp.json().catch(() => null)) as { data?: { items?: unknown[] } } | null;
      const items = parsed?.data?.items;
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const hit = atomToRetrievalHit(it as Record<string, unknown>, ctx);
        if (hit) out.push(hit);
      }
    } catch {
      // 单 ctx 失败降级（core/借调不可达不阻断）
    }
  }
  return out;
}

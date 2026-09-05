/**
 * wiki 候选源 —— 把注册到团队的 wiki 知识库（产品知识/文档）纳入任务二候选池。
 *
 * 数据通路：core `/v3/knowledge/list`（元数据：knowledge_id/name/summary/service_url，
 * 仅 type=wiki）→ 对每个 wiki 用其 `service_url`（KS base，含 /v3）打
 * `/wiki/search`（正文 FTS5/BM25，纯关键词）→ 取该 wiki 最佳页映射为一条候选。
 *
 * 候选身份：assetId = knowledge_id（== llm_wiki 的 asset_id，稳定、与知识工具一致），
 * assetType=wiki；snippet/why 取命中页内容。
 *
 * 诚实边界：wiki 正文读取是 agent 直连 KS（proxy 无正文回看），故 wiki 候选可达
 * recalled/selected/injected，used 依赖 agent 行为（不保证每 wiki 候选到 used→validated）。
 */

import type { RetrievalHit } from "../types.js";
import { getCoreKnowledgeClient, type KnowledgeItem } from "../../knowledge/core-client.js";
import type { CoreSkillConfig } from "../../types.js";

export interface WikiSourceEnv {
  coreSkill: CoreSkillConfig;
  teamId: string;
  userId?: string;
  spaceId?: string;
  query: string;
  perWikiLimit?: number;
  fetcher?: typeof fetch;
}

interface WikiSearchHit {
  page_id?: unknown;
  title?: unknown;
  name?: unknown;
  snippet?: unknown;
  content?: unknown;
  score?: unknown;
}

/** 每 wiki 只取最佳页 → 一条候选（资产身份=wiki knowledge_id）。 */
export function wikiPageToRetrievalHit(
  wiki: KnowledgeItem,
  page: WikiSearchHit,
): RetrievalHit {
  const title = typeof page.title === "string" && page.title ? page.title : wiki.name;
  const snippetRaw = typeof page.snippet === "string"
    ? page.snippet
    : typeof page.content === "string"
      ? page.content
      : "";
  return {
    assetId: wiki.knowledge_id,
    assetType: "wiki",
    name: title,
    description: wiki.summary ?? undefined,
    snippet: snippetRaw.replace(/\s+/g, " ").trim().slice(0, 220),
    score: typeof page.score === "number" ? page.score : undefined,
    teamId: wiki.team_id || undefined,
    sourceId: "wiki",
  };
}

/** 收集 wiki 候选。任一 wiki 检索失败降级跳过；无 wiki/KS 不可达 → []（不抛）。 */
export async function collectWikiHits(env: WikiSourceEnv): Promise<RetrievalHit[]> {
  if (!env.query.trim()) return [];
  const fetcher = env.fetcher ?? globalThis.fetch.bind(globalThis);
  let wikis: KnowledgeItem[] = [];
  try {
    const client = getCoreKnowledgeClient(env.coreSkill);
    wikis = await client.listKnowledge(env.teamId, { serviceId: env.spaceId });
  } catch {
    return [];
  }
  const wikiItems = wikis.filter((w) => w.type === "wiki");
  if (wikiItems.length === 0) return [];

  const out: RetrievalHit[] = [];
  for (const wiki of wikiItems) {
    try {
      const base = wiki.service_url.replace(/\/+$/, "");
      const resp = await fetcher(`${base}/wiki/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // KS x-tdai-service-id 自报（内网信任，仅校验路径安全）。
          "x-tdai-service-id": env.spaceId || env.coreSkill.serviceId,
        },
        body: JSON.stringify({
          wiki_id: wiki.knowledge_id,
          query: env.query.slice(0, 512),
          limit: Math.min(env.perWikiLimit ?? 3, 10),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const parsed = (await resp.json().catch(() => null)) as
        | { data?: { results?: unknown[] } } | null;
      const results = parsed?.data?.results;
      if (!Array.isArray(results) || results.length === 0) continue;
      const best = results.find((r) => r && typeof r === "object") as WikiSearchHit | undefined;
      if (!best) continue;
      out.push(wikiPageToRetrievalHit(wiki, best));
    } catch {
      // 单 wiki 失败降级
    }
  }
  return out;
}

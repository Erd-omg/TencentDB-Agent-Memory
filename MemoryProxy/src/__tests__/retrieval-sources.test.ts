/**
 * 多源候选（chat-memory / wiki）归一化 —— 单测。
 */

import { describe, it, expect } from "vitest";
import { atomToRetrievalHit } from "../retrieval/sources/chat-memory.js";
import { wikiPageToRetrievalHit } from "../retrieval/sources/wiki.js";
import type { KnowledgeItem } from "../knowledge/core-client.js";

const SELF_CTX = { teamId: "team-a", userId: "usr-a", agentId: "agt-a", agentName: "agt-a", isSelf: true };
const IMPORTED_CTX = { teamId: "team-a", userId: "usr-b", agentId: "agt-b", agentName: "迁移专家", isSelf: false };

describe("atomToRetrievalHit（chat-memory 源）", () => {
  it("L1 原子 → RetrievalHit：assetId=原子 id、assetType=chat-memory、name/snippet=正文前缀", () => {
    const hit = atomToRetrievalHit(
      { id: "m_abc", content: "  批量迁移 Windows 主机要在 VSS 快照之后改 ACL   ", score: 0.7, updated_at: 1700000000000 },
      SELF_CTX,
    );
    expect(hit?.assetId).toBe("m_abc");
    expect(hit?.assetType).toBe("chat-memory");
    expect(hit?.name).toContain("批量迁移");
    expect(hit?.snippet).toContain("VSS");
    expect(hit?.score).toBe(0.7);
    expect(hit?.ownerAgentId).toBe("agt-a");
    expect(hit?.sourceRole).toBe("self");
    expect(hit?.sourceId).toBe("chat-memory");
  });

  it("借调 ctx → sourceRole=imported_from（来源 agent 可追溯）", () => {
    const hit = atomToRetrievalHit({ id: "m_1", content: "迁移停机窗口评估", score: 0.3 }, IMPORTED_CTX);
    expect(hit?.sourceRole).toBe("imported_from");
    expect(hit?.ownerAgentId).toBe("agt-b");
    expect(hit?.ownerName).toBe("迁移专家");
  });

  it("无 id/content 或空正文 → null（不造伪候选）", () => {
    expect(atomToRetrievalHit({ content: "x" }, SELF_CTX)).toBeNull();
    expect(atomToRetrievalHit({ id: "m_1" }, SELF_CTX)).toBeNull();
    expect(atomToRetrievalHit({ id: "m_1", content: "   " }, SELF_CTX)).toBeNull();
  });
});

describe("wikiPageToRetrievalHit（wiki 源）", () => {
  const wiki: KnowledgeItem = {
    knowledge_id: "wiki-1",
    type: "wiki",
    service_url: "http://127.0.0.1:8421/v3",
    name: "云主机迁移验收标准",
    summary: "停机窗口/验收门",
    team_id: "team-a",
    user_id: "usr-a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("最佳页 → 资产身份=knowledge_id（==llm_wiki asset_id）、snippet=命中页", () => {
    const hit = wikiPageToRetrievalHit(wiki, { title: "验收清单", snippet: "ACL 一致性校验…", score: 0.9 });
    expect(hit.assetId).toBe("wiki-1");
    expect(hit.assetType).toBe("wiki");
    expect(hit.name).toContain("验收清单");
    expect(hit.snippet).toContain("ACL");
    expect(hit.score).toBe(0.9);
    expect(hit.teamId).toBe("team-a");
  });
});

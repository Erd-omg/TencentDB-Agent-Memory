/**
 * mem:review apply 落地 skill 域（幂等 + agent 兜底）—— 单测。
 *
 * 覆盖本次设计审查的核心改动（P0-1）：
 *   - ensureSkillFrontmatter：纯正文补 frontmatter / 已有 frontmatter 不重复补 / name 清洗
 *   - resolveLandingAgentId：team 首个 active agent 兜底 / 无 agent 或抛错回退 "default"
 *
 * 语义钉死（与 Panel 审核页 reviewApi.approve 对齐，design-156.md §8.6 M5）：
 *   candidate 不绑定 agent，落地 skill 域的 owner_agent 统一为 team 首个 active agent，
 *   保证双通道（CLI / Panel）落到同一唯一索引 (team_id, owner_agent_id, name)，幂等去重成立。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ensureSkillFrontmatter,
  resolveLandingAgentId,
  executeReview,
} from "../mem-command/commands/review.js";
import { setMetadataClient } from "../meta/client.js";
import type { MetadataClient } from "../meta/client.js";
import type { MemCommandContext } from "../mem-command/types.js";

afterEach(() => {
  setMetadataClient(null);
  vi.restoreAllMocks();
});

/** 构造最小 MemCommandContext（supersede 分支只用 sessionInfo + args）。 */
function makeCtx(args: string): MemCommandContext {
  return {
    args,
    protocol: "openai",
    stream: false,
    thinking: false,
    spaceId: "default",
    apiKey: "k",
    sessionInfo: { team_id: "team-1", user_id: "usr-1", agent_id: "agt-1" },
    config: { coreSkill: { endpoint: "http://x", serviceToken: "t", timeoutMs: 1000 } },
  } as unknown as MemCommandContext;
}

describe("ensureSkillFrontmatter", () => {
  it("纯正文 → 补 frontmatter（name 转 kebab-case，description 透传）", () => {
    const out = ensureSkillFrontmatter("# 正文", "My Skill Name", "desc here");
    expect(out).toContain("---\nname: my-skill-name\n");
    expect(out).toContain("description: desc here");
    expect(out).toContain("# 正文");
  });

  it("已有 frontmatter → 原样保留，不重复补", () => {
    const src = "---\nname: existing\ndescription: d\n---\n\nbody";
    expect(ensureSkillFrontmatter(src, "other", "x")).toBe(src);
  });

  it("name 含特殊字符 → 清洗为 kebab-case；空 name → 兜底 skill", () => {
    expect(ensureSkillFrontmatter("x", "Hello_World!", "")).toContain("name: hello-world");
    expect(ensureSkillFrontmatter("x", "!!!", "")).toContain("name: skill");
  });

  it("描述含换行 → 转单行", () => {
    const out = ensureSkillFrontmatter("x", "n", "line1\nline2");
    expect(out).toContain("description: line1 line2");
  });
});

describe("resolveLandingAgentId", () => {
  it("team 有 active agent → 返回首个 agent_id", async () => {
    const meta = {
      listAgents: async () => [{ agent_id: "agt-first" }, { agent_id: "agt-second" }],
    } as unknown as MetadataClient;
    await expect(resolveLandingAgentId(meta, "team-1")).resolves.toBe("agt-first");
  });

  it("team 无 agent → 回退 default", async () => {
    const meta = { listAgents: async () => [] } as unknown as MetadataClient;
    await expect(resolveLandingAgentId(meta, "team-1")).resolves.toBe("default");
  });

  it("listAgents 抛错 → 回退 default（不阻断 apply）", async () => {
    const meta = {
      listAgents: async () => { throw new Error("boom"); },
    } as unknown as MetadataClient;
    await expect(resolveLandingAgentId(meta, "team-1")).resolves.toBe("default");
  });
});

describe("mem:review supersede", () => {
  it("approved 资产 → deprecated + metadata_json 追加 superseded_by（保留原字段）", async () => {
    let updated: { assetId: string; patch: Record<string, unknown> } | undefined;
    const meta = {
      listAssets: async () => [
        {
          asset_id: "old-1",
          name: "old",
          status: "approved",
          metadata_json: JSON.stringify({ content: "# old", bucket: "Skill" }),
        },
      ],
      updateAsset: async (assetId: string, patch: Record<string, unknown>) => {
        updated = { assetId, patch };
        return { asset_id: assetId, ...patch, version: 2 };
      },
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeReview(makeCtx("supersede old-1 new-1"));
    expect(r.success).toBe(true);
    expect(updated?.assetId).toBe("old-1");
    expect(updated?.patch.status).toBe("deprecated");
    const m = JSON.parse(updated?.patch.metadata_json as string) as Record<string, unknown>;
    expect(m.superseded_by).toBe("new-1");
    expect(m.superseded_by_user).toBe("usr-1");
    // 原字段保留（审计）
    expect(m.content).toBe("# old");
    expect(m.bucket).toBe("Skill");
  });

  it("缺参数 → 报用法错误", async () => {
    const meta = { listAssets: async () => [] } as unknown as MetadataClient;
    setMetadataClient(meta);
    const r = await executeReview(makeCtx("supersede old-1"));
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("用法");
  });

  it("旧资产不存在 → 拒绝", async () => {
    const meta = { listAssets: async () => [] } as unknown as MetadataClient;
    setMetadataClient(meta);
    const r = await executeReview(makeCtx("supersede ghost new-1"));
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("不存在");
  });

  it("旧资产非 approved → 拒绝", async () => {
    const meta = {
      listAssets: async () => [{ asset_id: "old-1", name: "old", status: "candidate" }],
    } as unknown as MetadataClient;
    setMetadataClient(meta);
    const r = await executeReview(makeCtx("supersede old-1 new-1"));
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("approved");
  });
});

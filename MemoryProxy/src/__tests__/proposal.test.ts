/**
 * mem:proposal 提案机制（§8.5）—— 单测。
 *
 * 覆盖：
 *   - parseProposalMeta：识别 is_proposal 标记 / 非提案返回 undefined / 容错
 *   - executeProposal create：生成提案候选（status=candidate，metadata_json 带 is_proposal）
 *   - executeProposal create 幂等：同 target+kind 已存在则复用
 *   - mem:review apply 提案联动：deprecate/conflict → 目标 deprecated；downgrade → 降 risk
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseProposalMeta, executeProposal } from "../mem-command/commands/proposal.js";
import { executeReview } from "../mem-command/commands/review.js";
import { setMetadataClient } from "../meta/client.js";
import type { MetadataClient } from "../meta/client.js";
import type { MemCommandContext } from "../mem-command/types.js";

afterEach(() => {
  setMetadataClient(null);
  vi.restoreAllMocks();
});

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

describe("parseProposalMeta", () => {
  it("is_proposal=true + proposal 结构 → 返回 proposal", () => {
    const m = JSON.stringify({
      is_proposal: true,
      proposal: { kind: "deprecate", target_asset_id: "skl-old", reasons: ["过时"], evidence_refs: [] },
    });
    expect(parseProposalMeta(m)?.kind).toBe("deprecate");
    expect(parseProposalMeta(m)?.target_asset_id).toBe("skl-old");
  });

  it("非提案（无 is_proposal）→ undefined", () => {
    expect(parseProposalMeta(JSON.stringify({ content: "# x", bucket: "Skill" }))).toBeUndefined();
  });

  it("is_proposal 但缺 proposal 结构 → undefined", () => {
    expect(parseProposalMeta(JSON.stringify({ is_proposal: true }))).toBeUndefined();
  });

  it("非法 JSON / null → undefined", () => {
    expect(parseProposalMeta("not-json")).toBeUndefined();
    expect(parseProposalMeta(null)).toBeUndefined();
  });
});

describe("mem:proposal create", () => {
  it("create deprecate 提案 → candidate + metadata_json 带 is_proposal", async () => {
    let created: Record<string, unknown> | undefined;
    const meta = {
      listAssets: async () => [{ asset_id: "skl-old", name: "old-skill", status: "approved" }],
      createAsset: async (input: Record<string, unknown>) => {
        created = input;
        return { asset_id: input.asset_id, status: "candidate" };
      },
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeProposal(makeCtx("create skl-old --kind=deprecate --reason=过时"));
    expect(r.success).toBe(true);
    expect(created?.status).toBe("candidate");
    expect(created?.asset_type).toBe("skill");
    const m = JSON.parse(created?.metadata_json as string) as Record<string, unknown>;
    expect(m.is_proposal).toBe(true);
    expect((m.proposal as { kind: string; target_asset_id: string }).kind).toBe("deprecate");
    expect((m.proposal as { target_asset_id: string }).target_asset_id).toBe("skl-old");
  });

  it("同 target+kind 已存在 → 幂等复用，不重复 create", async () => {
    let createCalled = 0;
    const id = `prop-skl-old-deprecate`;
    const meta = {
      listAssets: async () => [
        { asset_id: "skl-old", name: "old-skill", status: "approved" },
        { asset_id: id, name: "deprecate-skl-old", status: "candidate", metadata_json: JSON.stringify({ is_proposal: true, proposal: { kind: "deprecate", target_asset_id: "skl-old" } }) },
      ],
      createAsset: async () => { createCalled++; return {}; },
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeProposal(makeCtx("create skl-old --kind=deprecate"));
    expect(r.success).toBe(true);
    expect(createCalled).toBe(0);
    expect(r.data?.reused).toBe(true);
  });

  it("目标资产不存在 → 拒绝", async () => {
    const meta = { listAssets: async () => [] } as unknown as MetadataClient;
    setMetadataClient(meta);
    const r = await executeProposal(makeCtx("create ghost --kind=deprecate"));
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("不存在");
  });

  it("缺 --kind 或非法 kind → 报用法错误", async () => {
    const meta = { listAssets: async () => [{ asset_id: "skl-old", status: "approved" }] } as unknown as MetadataClient;
    setMetadataClient(meta);
    const r1 = await executeProposal(makeCtx("create skl-old"));
    expect(r1.success).toBe(false);
    const r2 = await executeProposal(makeCtx("create skl-old --kind=bogus"));
    expect(r2.success).toBe(false);
  });
});

describe("mem:review apply 提案联动", () => {
  it("apply deprecate 提案 → 提案 approved + 目标资产 deprecated（带 deprecated_by_proposal）", async () => {
    const updates: Array<{ assetId: string; patch: Record<string, unknown> }> = [];
    const propId = "prop-skl-old-deprecate";
    const meta = {
      listAssets: async () => [
        { asset_id: "skl-old", name: "old-skill", status: "approved", metadata_json: JSON.stringify({ risk: "medium" }) },
        {
          asset_id: propId, name: "deprecate-skl-old", status: "candidate",
          metadata_json: JSON.stringify({ is_proposal: true, proposal: { kind: "deprecate", target_asset_id: "skl-old", reasons: ["过时"], evidence_refs: [] } }),
        },
      ],
      updateAsset: async (assetId: string, patch: Record<string, unknown>) => {
        updates.push({ assetId, patch });
        return { asset_id: assetId, ...patch };
      },
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeReview(makeCtx(`apply ${propId}`));
    expect(r.success).toBe(true);

    // 提案本身 approved
    const propUpd = updates.find((u) => u.assetId === propId);
    expect(propUpd?.patch.status).toBe("approved");
    // 目标资产 deprecated + 保留原 risk 字段 + 追加提案来源
    const targetUpd = updates.find((u) => u.assetId === "skl-old");
    expect(targetUpd?.patch.status).toBe("deprecated");
    const tm = JSON.parse(targetUpd?.patch.metadata_json as string) as Record<string, unknown>;
    expect(tm.deprecated_by_proposal).toBe(propId);
    expect(tm.risk).toBe("medium");
  });

  it("apply downgrade 提案 → 目标资产 risk 降为 low（status 不变）", async () => {
    const updates: Array<{ assetId: string; patch: Record<string, unknown> }> = [];
    const propId = "prop-skl-old-downgrade";
    const meta = {
      listAssets: async () => [
        { asset_id: "skl-old", name: "old-skill", status: "approved", metadata_json: JSON.stringify({ risk: "high" }) },
        {
          asset_id: propId, name: "downgrade-skl-old", status: "candidate",
          metadata_json: JSON.stringify({ is_proposal: true, proposal: { kind: "downgrade", target_asset_id: "skl-old", reasons: [], evidence_refs: [] } }),
        },
      ],
      updateAsset: async (assetId: string, patch: Record<string, unknown>) => {
        updates.push({ assetId, patch });
        return { asset_id: assetId, ...patch };
      },
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeReview(makeCtx(`apply ${propId}`));
    expect(r.success).toBe(true);
    const targetUpd = updates.find((u) => u.assetId === "skl-old");
    expect(targetUpd?.patch.status).toBeUndefined();
    const tm = JSON.parse(targetUpd?.patch.metadata_json as string) as Record<string, unknown>;
    expect(tm.risk).toBe("low");
    expect(tm.downgraded_by_proposal).toBe(propId);
  });

  it("apply 提案但目标资产不存在 → 拒绝", async () => {
    const propId = "prop-ghost-deprecate";
    const meta = {
      listAssets: async () => [
        {
          asset_id: propId, name: "deprecate-ghost", status: "candidate",
          metadata_json: JSON.stringify({ is_proposal: true, proposal: { kind: "deprecate", target_asset_id: "ghost", reasons: [], evidence_refs: [] } }),
        },
      ],
      updateAsset: async () => ({}),
    } as unknown as MetadataClient;
    setMetadataClient(meta);

    const r = await executeReview(makeCtx(`apply ${propId}`));
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("不存在");
  });
});

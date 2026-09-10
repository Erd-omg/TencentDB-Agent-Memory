/**
 * MetadataClient 审核资产接口（createAsset / updateAsset / listAssets）—— 单测。
 *
 * 用注入的 fake fetcher 捕获请求体，钉死：
 *   - listAssets：status 缺省时不传 status 字段 → 内核返回全部状态（含 candidate），
 *     这是 mem:review list/show 读到候选的关键（P0-2 门控闭环）。
 *   - createAsset：status 缺省时不传 status 字段（内核默认 candidate 由调用方显式传）。
 *   - updateAsset：status 流转 candidate→approved/failed 透传。
 */

import { describe, it, expect, vi } from "vitest";
import { MetadataClient } from "../meta/client.js";

function mkClient(captured: Array<{ path: string; body: Record<string, unknown> }>) {
  const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
    const url = String(_url);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const path = url.slice(url.lastIndexOf("/v3/meta"));
    captured.push({ path, body });
    // list 接口返回分页结构；create/update 返回单实体
    if (path.includes("/list")) {
      return new Response(
        JSON.stringify({ code: 0, data: { items: [], total: 0, limit: 100, offset: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ code: 0, data: { asset_id: body.asset_id, status: body.status ?? "candidate" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = new MetadataClient(
    { endpoint: "http://core", serviceToken: "tok", timeoutMs: 1000 },
    "space-1",
    "user-key-1",
    fetcher,
  );
  return { client, fetcher, captured };
}

describe("MetadataClient asset 审核接口", () => {
  it("listAssets status 缺省 → 不传 status 字段（内核返回全部，含 candidate）", async () => {
    const { client, captured } = mkClient([]);
    await client.listAssets({ team_id: "team-1" });
    expect(captured[0].path).toBe("/v3/meta/asset/list");
    expect(captured[0].body.status).toBeUndefined();
    expect(captured[0].body.team_id).toBe("team-1");
  });

  it("listAssets status=candidate → 透传 status（审核 list 过滤候选）", async () => {
    const { client, captured } = mkClient([]);
    await client.listAssets({ team_id: "team-1", status: "candidate" });
    expect(captured[0].body.status).toBe("candidate");
  });

  it("createAsset 显式 status=candidate → 透传", async () => {
    const { client, captured } = mkClient([]);
    await client.createAsset({
      asset_id: "cand-1",
      team_id: "team-1",
      asset_type: "skill",
      name: "x",
      owner_user_id: "user-1",
      source_type: "task",
      status: "candidate",
      metadata_json: "{}",
    });
    expect(captured[0].path).toBe("/v3/meta/asset/create");
    expect(captured[0].body.status).toBe("candidate");
  });

  it("updateAsset status 流转透传", async () => {
    const { client, captured } = mkClient([]);
    await client.updateAsset("cand-1", { status: "approved" });
    expect(captured[0].path).toBe("/v3/meta/asset/update");
    expect(captured[0].body.asset_id).toBe("cand-1");
    expect(captured[0].body.status).toBe("approved");
  });
});

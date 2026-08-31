/**
 * F1 测试 —— recalled / selected 事件打点。
 *
 * 覆盖赛题 F1：search 命中 → recalled；定向读取（get/get-by-name/files/read）
 * → selected；且 search 不再落 used（F2 的过度归因修复在此一并验证）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  skillAssetsFromResponse,
  emitRecalledEvents,
  emitSelectedEvents,
} from "../evidence/used-evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-select-test-"));
  process.env.PROXY_DB_PATH = join(tmpDir, "proxy.db");
  __resetAssetEventRepoForTests();
  __resetDbForTests();
});

afterEach(() => {
  __resetAssetEventRepoForTests();
  __resetDbForTests();
  delete process.env.PROXY_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SK_SOURCE = {
  sessionKey: "codebuddy:conv-r",
  sessionId: "conv-r",
  agentId: "agt-r",
  teamId: "team-r",
  userId: "usr-r",
  bridge: "skill-bridge" as const,
  httpStatus: 200,
};

describe("emitRecalledEvents", () => {
  it("search 命中逐资产落 recalled，evidence 带 tool_call+query", () => {
    const repo = getAssetEventRepo()!;
    emitRecalledEvents({ ...SK_SOURCE, endpoint: "search", query: "迁移" }, [
      { assetId: "skl-1", assetType: "skill", version: 2, score: 0.8 },
      { assetId: "skl-2", assetType: "skill" },
    ]);

    const recalled = repo.bySessionKey("codebuddy:conv-r", "recalled");
    expect(recalled).toHaveLength(2);
    expect(recalled[0].asset.assetId).toBe("skl-1");
    expect(recalled[0].asset.score).toBe(0.8);
    expect(recalled[0].evidence?.tool_call).toMatchObject({
      bridge: "skill-bridge",
      endpoint: "search",
      query: "迁移",
      httpStatus: 200,
    });
  });

  it("空资产不落 recalled 事件", () => {
    const repo = getAssetEventRepo()!;
    emitRecalledEvents({ ...SK_SOURCE, endpoint: "search" }, []);
    expect(repo.recent(10)).toHaveLength(0);
  });
});

describe("emitSelectedEvents", () => {
  it("get 定向读取落 selected 事件", () => {
    const repo = getAssetEventRepo()!;
    emitSelectedEvents({ ...SK_SOURCE, endpoint: "get" }, [
      { assetId: "skl-9", assetType: "skill", version: 3 },
    ]);

    const selected = repo.bySessionKey("codebuddy:conv-r", "selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].asset.assetId).toBe("skl-9");
    expect(selected[0].evidence?.tool_call?.endpoint).toBe("get");
  });

  it("search 响应解析为 assets 后可喂给 recalled 而非 used", () => {
    const resp = JSON.stringify({
      code: 0,
      data: { items: [{ skill_id: "skl-1", version: 2, name: "guide", score: 0.8 }] },
    });
    const assets = skillAssetsFromResponse("search", resp);
    expect(assets).toHaveLength(1);

    const repo = getAssetEventRepo()!;
    emitRecalledEvents({ ...SK_SOURCE, endpoint: "search" }, assets);
    // 只应出现 recalled，绝无 used（F2 修复：search 不再宣称使用）。
    expect(repo.bySessionKey("codebuddy:conv-r", "recalled")).toHaveLength(1);
    expect(repo.bySessionKey("codebuddy:conv-r", "used")).toHaveLength(0);
    expect(repo.bySessionKey("codebuddy:conv-r", "selected")).toHaveLength(0);
  });
});

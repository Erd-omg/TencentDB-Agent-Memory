/**
 * used-evidence 打点测试 —— 验证 skill/memory bridge 成功响应 → used 事件。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  skillAssetsFromResponse,
  memoryAssetsFromItems,
  emitUsedEvents,
} from "../evidence/used-evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "used-evidence-test-"));
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

describe("skillAssetsFromResponse", () => {
  it("search 响应 → 逐条 skill 资产", () => {
    const resp = JSON.stringify({
      code: 0,
      data: { items: [
        { skill_id: "skl-1", version: 2, name: "guide", score: 0.8 },
        { skill_id: "skl-2", version: 1, name: "std" },
      ] },
    });
    const assets = skillAssetsFromResponse("search", resp);
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ assetId: "skl-1", assetType: "skill", version: 2, score: 0.8 });
    expect(assets[1].name).toBe("std");
  });

  it("get-by-name 响应 → 单条 skill", () => {
    const resp = JSON.stringify({ code: 0, data: { skill_id: "skl-9", version: 3, name: "postmortem" } });
    const assets = skillAssetsFromResponse("get-by-name", resp);
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe("skl-9");
    expect(assets[0].version).toBe(3);
  });

  it("files/read 响应无 skill_id → 用 inbound skill_id", () => {
    const resp = JSON.stringify({ code: 0, data: { path: "SKILL.md", version: 4 } });
    const assets = skillAssetsFromResponse("files/read", resp, "skl-inbound");
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe("skl-inbound");
    expect(assets[0].version).toBe(4);
  });

  it("非 0 code / 无 skill_id → 空", () => {
    expect(skillAssetsFromResponse("search", JSON.stringify({ code: 50001 }))).toEqual([]);
    expect(skillAssetsFromResponse("get", JSON.stringify({ code: 0, data: {} }))).toEqual([]);
  });
});

describe("memoryAssetsFromItems", () => {
  it("atomic/search 命中 → chat-memory 资产 + 来源 agent", () => {
    const items = [
      { id: "atc-1", content: "  用户偏好 NTFS ACL 逐项校验  ", score: 0.9, source_agent_name: "迁移专家" },
      { id: "atc-2", content: "VSS 快照方案", score: 0.7 },
    ];
    const assets = memoryAssetsFromItems(items);
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      assetId: "atc-1",
      assetType: "chat-memory",
      score: 0.9,
      source: "迁移专家",
    });
    expect(assets[0].name).toBe("用户偏好 NTFS ACL 逐项校验");
  });
});

describe("emitUsedEvents", () => {
  it("逐资产落 used 事件，evidence 带 tool_call", () => {
    const repo = getAssetEventRepo()!;
    emitUsedEvents({
      sessionKey: "codebuddy:conv-x",
      taskId: "task-x",
      agentId: "agt-x",
      teamId: "team-x",
      userId: "usr-x",
      bridge: "skill-bridge",
      endpoint: "search",
      query: "迁移",
      httpStatus: 200,
    }, [
      { assetId: "skl-1", assetType: "skill", version: 2 },
      { assetId: "skl-2", assetType: "skill" },
    ]);

    const used = repo.bySessionKey("codebuddy:conv-x", "used");
    expect(used).toHaveLength(2);
    expect(used[0].evidence?.tool_call).toMatchObject({
      bridge: "skill-bridge",
      endpoint: "search",
      query: "迁移",
      httpStatus: 200,
    });
    expect(used[1].taskId).toBe("task-x");
  });

  it("空资产 → 不落事件", () => {
    const repo = getAssetEventRepo()!;
    emitUsedEvents({
      sessionKey: "codebuddy:conv-x",
      bridge: "skill-bridge",
      endpoint: "search",
      httpStatus: 200,
    }, []);
    expect(repo.recent(10)).toHaveLength(0);
  });
});

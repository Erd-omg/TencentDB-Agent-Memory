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
  emitOpenedEvents,
  extractCitationAnchors,
  extractCitationAnchorsDetailed,
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

  it("used 事件可携带 citation（引用锚点：opened 升级为 used）", () => {
    const repo = getAssetEventRepo()!;
    emitUsedEvents({
      sessionKey: "codebuddy:conv-cite",
      bridge: "skill-bridge",
      endpoint: "get",
      httpStatus: 200,
      citation: { origin: "diff", anchors: ["cloud-migration-postmortems"] },
    }, [{ assetId: "skl-1", assetType: "skill" }]);

    const used = repo.bySessionKey("codebuddy:conv-cite", "used");
    expect(used).toHaveLength(1);
    expect(used[0].evidence?.citation).toEqual({ origin: "diff", anchors: ["cloud-migration-postmortems"] });
  });
});

describe("emitOpenedEvents（P0-1：打开 ≠ 采纳）", () => {
  it("定向读取落 opened 事件，不落 used", () => {
    const repo = getAssetEventRepo()!;
    emitOpenedEvents({
      sessionKey: "codebuddy:conv-open",
      bridge: "skill-bridge",
      endpoint: "get",
      httpStatus: 200,
    }, [{ assetId: "skl-1", assetType: "skill" }]);

    expect(repo.bySessionKey("codebuddy:conv-open", "opened")).toHaveLength(1);
    expect(repo.bySessionKey("codebuddy:conv-open", "used")).toHaveLength(0);
  });
});

describe("extractCitationAnchors（引用锚点纯函数）", () => {
  it("资产名 token 出现在出处文本 → 返回锚点", () => {
    const anchors = extractCitationAnchors(
      "cloud-migration-postmortems",
      "diff --git a/src/windows-migration.js ... cloud-migration-postmortems 时序修复",
    );
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors).toContain("migration");
  });

  it("资产名与出处无共现 → 空数组（不升级 used）", () => {
    expect(extractCitationAnchors("cloud-migration-postmortems", "unrelated diff text only")).toEqual([]);
  });

  it("空名或空出处 → 空数组", () => {
    expect(extractCitationAnchors(undefined, "text")).toEqual([]);
    expect(extractCitationAnchors("name", "")).toEqual([]);
  });
});

describe("extractCitationAnchorsDetailed（4B 置信度分层）", () => {
  it("命中专有名词锚点（连字符复合词）→ high", () => {
    const d = extractCitationAnchorsDetailed(
      "cloud-migration-postmortems",
      "参考 cloud-migration-postmortems 的时序经验",
    );
    expect(d.anchors.length).toBeGreaterThan(0);
    expect(d.confidence).toBe("high");
    expect(d.properAnchors.length).toBeGreaterThan(0);
  });

  it("命中 ≥2 个锚点 → high", () => {
    const d = extractCitationAnchorsDetailed(
      "vss acl ordering guide",
      "vss 与 acl 的 ordering 需要调整",
    );
    expect(d.anchors.length).toBeGreaterThanOrEqual(2);
    expect(d.confidence).toBe("high");
  });

  it("仅命中 1 个泛化 token → medium", () => {
    const d = extractCitationAnchorsDetailed(
      "migration guide alpha",
      "这次 migration 很关键",
    );
    expect(d.anchors).toContain("migration");
    expect(d.confidence).toBe("medium");
  });

  it("无命中 → low", () => {
    const d = extractCitationAnchorsDetailed("cloud-migration-postmortems", "无关文本");
    expect(d.anchors).toEqual([]);
    expect(d.confidence).toBe("low");
  });

  it("extractCitationAnchors 与 Detailed 的 anchors 一致（向后兼容）", () => {
    const name = "cloud-migration-postmortems";
    const text = "cloud-migration-postmortems 经验";
    expect(extractCitationAnchors(name, text)).toEqual(extractCitationAnchorsDetailed(name, text).anchors);
  });
});

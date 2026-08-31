/**
 * memory 定向读取证据测试 —— memoryDirectReadAssets 解析（atomic/query /
 * scenario/read）与 selected/used 落库（含 turnSeq 透传）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryDirectReadAssets, emitSelectedEvents, emitUsedEvents, type UsedEventSource } from "../evidence/used-evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-direct-read-test-"));
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

describe("memoryDirectReadAssets", () => {
  it("atomic/query → data.items[] 每条映射 chat-memory", () => {
    const assets = memoryDirectReadAssets("atomic/query", JSON.stringify({
      code: 0,
      data: {
        items: [
          { id: "m1", content: "用户偏好 NTFS ACL", version: 2, score: 0.9 },
          { id: "m2", content: "VSS 快照转向" },
        ],
      },
    }));
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ assetId: "m1", assetType: "chat-memory", version: 2, score: 0.9 });
    expect(assets[1]).toMatchObject({ assetId: "m2", assetType: "chat-memory" });
  });

  it("atomic/query 无 items → []", () => {
    expect(memoryDirectReadAssets("atomic/query", JSON.stringify({ code: 0, data: {} }))).toEqual([]);
  });

  it("scenario/read 有 content → 单资产（path 作 id）", () => {
    const assets = memoryDirectReadAssets("scenario/read", JSON.stringify({
      code: 0,
      data: { path: "迁移方案.md", content: "正文..." },
    }));
    expect(assets).toEqual([{ assetId: "迁移方案.md", assetType: "chat-memory", name: "迁移方案.md" }]);
  });

  it("scenario/read content=null → []（不造伪证据）", () => {
    expect(memoryDirectReadAssets("scenario/read", JSON.stringify({ code: 0, data: { path: "x.md", content: null } }))).toEqual([]);
  });

  it("非 JSON / code!=0 → []", () => {
    expect(memoryDirectReadAssets("atomic/query", "not-json")).toEqual([]);
    expect(memoryDirectReadAssets("atomic/query", JSON.stringify({ code: 1, data: { items: [] } }))).toEqual([]);
  });
});

describe("emit selected/used 落库", () => {
  const src: UsedEventSource = {
    sessionKey: "sess-mem",
    sessionId: "sess-mem",
    taskId: "task-1",
    agentId: "agt-1",
    teamId: "team-1",
    userId: "usr-1",
    bridge: "memory-bridge",
    endpoint: "scenario/read",
    httpStatus: 200,
    turnSeq: 7,
  };

  it("selected + used 双落，且 turnSeq 透传", () => {
    const repo = getAssetEventRepo()!;
    const assets = [{ assetId: "x.md", assetType: "chat-memory" as const, name: "x.md" }];
    emitSelectedEvents(src, assets);
    emitUsedEvents(src, assets);

    const events = repo.bySessionKey("sess-mem");
    const stages = events.map((e) => e.stage).sort();
    expect(stages).toEqual(["selected", "used"]);
    for (const e of events) {
      expect(e.turnSeq).toBe(7);
      expect(e.asset.assetType).toBe("chat-memory");
    }
    expect(events[0].evidence?.tool_call?.endpoint).toBe("scenario/read");
  });

  it("无资产 → 不落事件", () => {
    emitSelectedEvents(src, []);
    expect(getAssetEventRepo()!.bySessionKey("sess-mem")).toHaveLength(0);
  });
});

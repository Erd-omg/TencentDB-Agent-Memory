/**
 * AssetEventRepo 冒烟测试 —— 验证 asset_event 证据链落库/查询/聚合。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { AssetEvent } from "../db/asset-event.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "asset-event-test-"));
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

function baseEvent(overrides: Partial<AssetEvent>): AssetEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    stage: "injected",
    asset: {
      assetId: "skl-demo-1",
      assetType: "skill",
      version: 3,
      name: "demo-skill",
      score: 0.82,
    },
    sessionKey: "codebuddy:conv-demo",
    taskId: "task-demo",
    agentId: "agt-demo",
    teamId: "team-demo",
    userId: "usr-demo",
    turnSeq: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("AssetEventRepo", () => {
  it("插入后可按会话按阶段查询，且保持时间顺序", () => {
    const repo = getAssetEventRepo();
    expect(repo).not.toBeNull();
    repo!.insert(baseEvent({ stage: "injected", createdAt: 100 }));
    repo!.insert(baseEvent({ stage: "used", createdAt: 200 }));
    repo!.insert(baseEvent({ stage: "validated", createdAt: 300 }));

    const all = repo!.bySessionKey("codebuddy:conv-demo");
    expect(all.map((e) => e.stage)).toEqual(["injected", "used", "validated"]);

    const usedOnly = repo!.bySessionKey("codebuddy:conv-demo", "used");
    expect(usedOnly).toHaveLength(1);
    expect(usedOnly[0].evidence).toBeUndefined();
  });

  it("stageCounts 按会话聚合各阶段计数", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(baseEvent({ stage: "injected" }));
    repo.insert(baseEvent({ stage: "injected" }));
    repo.insert(baseEvent({ stage: "used" }));
    repo.insert(baseEvent({ stage: "used" }));
    repo.insert(baseEvent({ stage: "corrected" }));

    const counts = repo.stageCounts("codebuddy:conv-demo");
    expect(counts.injected).toBe(2);
    expect(counts.used).toBe(2);
    expect(counts.corrected).toBe(1);
    expect(counts.recalled).toBe(0);
  });

  it("distinctAssets 按 asset_id 去重，合并版本与阶段", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(baseEvent({
      asset: { assetId: "skl-demo-1", assetType: "skill", version: 1, name: "demo" },
      stage: "injected",
    }));
    repo.insert(baseEvent({
      asset: { assetId: "skl-demo-1", assetType: "skill", version: 3, name: "demo" },
      stage: "used",
    }));
    repo.insert(baseEvent({
      asset: { assetId: "atc-demo-2", assetType: "chat-memory", name: "memo" },
      stage: "injected",
    }));

    const assets = repo.distinctAssets("codebuddy:conv-demo");
    expect(assets).toHaveLength(2);
    const skill = assets.find((a) => a.asset.assetId === "skl-demo-1")!;
    expect(skill.stages).toEqual(["injected", "used"]);
    expect(skill.asset.version).toBe("3"); // 后写版本覆盖（DB 存 TEXT，读回字符串）
  });

  it("evidence 结构化往返（tool_call）", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(baseEvent({
      stage: "used",
      evidence: {
        tool_call: {
          bridge: "skill-bridge",
          endpoint: "skill/search",
          query: "迁移",
          snippet: "批量迁移规划…",
        },
      },
    }));
    const used = repo.bySessionKey("codebuddy:conv-demo", "used");
    expect(used[0].evidence?.tool_call?.query).toBe("迁移");
  });

  it("clearSession 删除指定会话事件", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(baseEvent({}));
    repo.insert(baseEvent({ sessionKey: "other:conv" }));
    repo.clearSession("codebuddy:conv-demo");
    expect(repo.bySessionKey("codebuddy:conv-demo")).toHaveLength(0);
    expect(repo.bySessionKey("other:conv")).toHaveLength(1);
  });
});

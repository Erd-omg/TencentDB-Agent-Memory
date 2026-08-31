/**
 * receipt-data 聚合测试 —— buildReceiptData（命令与 HTTP API 共享）/
 * buildReceiptJson（序列化形状）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReceiptData, buildReceiptJson } from "../evidence/receipt-data.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "receipt-data-test-"));
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

describe("buildReceiptData", () => {
  it("空会话 → null", () => {
    expect(buildReceiptData("sess-none")).toBeNull();
  });

  it("聚合 distinct/stageCounts/effectiveness/risks/events", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "recalled",
      asset: { assetId: "skl-1", assetType: "skill", score: 0.3 },
      sessionKey: "sess-x",
    }));
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "sess-x",
    }));
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "sess-x",
      evidence: { tool_call: { bridge: "skill-bridge", endpoint: "get", httpStatus: 200 } },
    }));

    const data = buildReceiptData("sess-x")!;
    expect(data.assets).toHaveLength(1);
    expect(data.stageCounts.used).toBe(1);
    expect(data.stageCounts.recalled).toBe(1);
    expect(data.effectiveness.adopted).toBe(1); // used 单次 → 已采用待验证
    expect(data.assets[0].events).toHaveLength(3);
    expect(data.assets[0].effectiveness).toBe("adopted");
    expect(data.chainIssues).toEqual([]); // recalled→injected→used 链路完整
  });

  it("validated-无-used → chainIssues 含 error + effectiveness 降级", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "sess-x",
    }));
    repo.insert(repo.newEvent({
      stage: "validated",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "sess-x",
      evidence: { test_result: { runner: "command", command: "x", exitCode: 0, output: "PASS", durationMs: 1 } },
    }));

    const data = buildReceiptData("sess-x")!;
    expect(data.assets[0].effectiveness).toBe("validated_no_use");
    expect(data.chainIssues.length).toBeGreaterThan(0);
    expect(data.chainIssues[0].level).toBe("error");
  });
});

describe("buildReceiptJson", () => {
  it("形状含 asset_count/stage_counts/effectiveness/chain_issues/assets.events", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "sess-x",
    }));

    const json = buildReceiptJson(buildReceiptData("sess-x")!);
    expect(json.asset_count).toBe(1);
    expect(json).toHaveProperty("stage_counts");
    expect(json).toHaveProperty("effectiveness");
    expect(json).toHaveProperty("chain_issues");
    const assets = json.assets as Array<Record<string, unknown>>;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toHaveProperty("last_stage_at");
    expect(assets[0].events).toEqual(expect.any(Array));
  });
});

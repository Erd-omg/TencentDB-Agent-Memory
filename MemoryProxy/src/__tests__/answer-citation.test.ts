/**
 * used answer 侧引用锚点测试（P0-1 补强）。
 *
 * 验证：本会话 opened 的资产，若模型答复中点名（资产名 token 共现），
 * 则补写 used 事件（citation.origin="answer"）；未点名则不升级（打开 ≠ 采纳）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitOpenedEvents, emitUsedEvents } from "../evidence/used-evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import { emitAnswerCitationUsed } from "../handler.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "answer-citation-test-"));
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

describe("emitAnswerCitationUsed（answer 侧引用锚点）", () => {
  it("答复点名 opened 资产 → 补写 used（citation.origin=answer）", () => {
    const repo = getAssetEventRepo()!;
    emitOpenedEvents(
      { sessionKey: "s1", bridge: "skill-bridge", endpoint: "get", httpStatus: 200, turnSeq: 1 },
      [{ assetId: "skl-1", assetType: "skill", name: "cloud-migration-postmortems" }],
    );

    emitAnswerCitationUsed({
      sessionKey: "s1",
      sessionId: "s1",
      turnSeq: 2,
      answerText: "根据 cloud-migration-postmortems 的历史经验，VSS 快照必须先于 ACL 应用。",
    });

    const used = repo.bySessionKey("s1", "used");
    expect(used).toHaveLength(1);
    expect(used[0].asset.assetId).toBe("skl-1");
    expect(used[0].evidence?.citation?.origin).toBe("answer");
    expect(used[0].evidence?.citation?.anchors?.length).toBeGreaterThan(0);
  });

  it("答复未点名 → 不升级（仅 opened）", () => {
    const repo = getAssetEventRepo()!;
    emitOpenedEvents(
      { sessionKey: "s2", bridge: "skill-bridge", endpoint: "get", httpStatus: 200 },
      [{ assetId: "skl-2", assetType: "skill", name: "unrelated-guide-xyz" }],
    );

    emitAnswerCitationUsed({
      sessionKey: "s2",
      turnSeq: 2,
      answerText: "这是一个完全无关的答复，没有提到任何资产名称。",
    });

    expect(repo.bySessionKey("s2", "used")).toHaveLength(0);
    expect(repo.bySessionKey("s2", "opened")).toHaveLength(1);
  });

  it("已 used 资产不重复补写", () => {
    const repo = getAssetEventRepo()!;
    const asset = { assetId: "skl-3", assetType: "skill" as const, name: "cloud-migration-postmortems" };
    emitOpenedEvents({ sessionKey: "s3", bridge: "skill-bridge", endpoint: "get", httpStatus: 200 }, [asset]);
    // 先由写操作产生 used
    emitUsedEvents({ sessionKey: "s3", bridge: "skill-bridge", endpoint: "update", httpStatus: 200 }, [asset]);

    emitAnswerCitationUsed({
      sessionKey: "s3",
      turnSeq: 2,
      answerText: "cloud-migration-postmortems 很重要。",
    });

    // 仍只有 1 条 used（不重复）
    expect(repo.bySessionKey("s3", "used")).toHaveLength(1);
  });

  it("空答复 → 不产生任何 used", () => {
    const repo = getAssetEventRepo()!;
    emitOpenedEvents(
      { sessionKey: "s4", bridge: "skill-bridge", endpoint: "get", httpStatus: 200 },
      [{ assetId: "skl-4", assetType: "skill", name: "cloud-migration-postmortems" }],
    );
    emitAnswerCitationUsed({ sessionKey: "s4", answerText: "" });
    expect(repo.bySessionKey("s4", "used")).toHaveLength(0);
  });
});

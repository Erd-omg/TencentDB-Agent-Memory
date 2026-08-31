/**
 * F2 测试 —— used 定义收紧 + evidence 决策字段。
 *
 * 覆盖赛题 F2：
 *   - search 不再属于"使用"端点（从 SUBPATH_USES_ASSET 移除）。
 *   - used 事件 evidence 可携带 decision / code_diff / outcome，
 *     建立「资产 → 决策/变更 → 结果」的可信归因。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitUsedEvents } from "../evidence/used-evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "used-narrow-test-"));
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

describe("used 定义收紧（F2）", () => {
  it("search 语义保持为 recalled 而非 used —— 防止『仅召回就宣称已采用』", async () => {
    const { skillAssetsFromResponse, emitRecalledEvents } = await import("../evidence/used-evidence.js");
    const resp = JSON.stringify({
      code: 0,
      data: { items: [{ skill_id: "skl-1", version: 2, name: "guide", score: 0.8 }] },
    });
    const assets = skillAssetsFromResponse("search", resp);
    expect(assets).toHaveLength(1);

    const repo = getAssetEventRepo()!;
    // bridge 层对 search 只调 emitRecalledEvents，绝不调 emitUsedEvents。
    emitRecalledEvents({
      sessionKey: "codebuddy:conv-n",
      bridge: "skill-bridge",
      endpoint: "search",
      query: "迁移",
      httpStatus: 200,
    }, assets);

    expect(repo.bySessionKey("codebuddy:conv-n", "recalled")).toHaveLength(1);
    expect(repo.bySessionKey("codebuddy:conv-n", "used")).toHaveLength(0);
  });

  it("used 事件 evidence 可携带 decision / code_diff / outcome（资产→决策→结果归因）", () => {
    const repo = getAssetEventRepo()!;
    emitUsedEvents({
      sessionKey: "codebuddy:conv-n",
      taskId: "task-n",
      agentId: "agt-n",
      teamId: "team-n",
      userId: "usr-n",
      bridge: "skill-bridge",
      endpoint: "get",
      httpStatus: 200,
      decision: "采用该迁移方案，符合 NTFS ACL 逐项校验偏好",
      code_diff: "MigrationRunner: 增加 acl 校验步骤",
      outcome: "迁移通过，无 ACL 遗漏",
    }, [
      { assetId: "skl-1", assetType: "skill", version: 2 },
    ]);

    const used = repo.bySessionKey("codebuddy:conv-n", "used");
    expect(used).toHaveLength(1);
    expect(used[0].evidence?.tool_call?.endpoint).toBe("get");
    expect(used[0].evidence?.decision).toContain("NTFS ACL");
    expect(used[0].evidence?.code_diff).toContain("MigrationRunner");
    expect(used[0].evidence?.outcome).toContain("无 ACL 遗漏");
  });

  it("未提供决策字段时 used evidence 仍至少带 tool_call", () => {
    const repo = getAssetEventRepo()!;
    emitUsedEvents({
      sessionKey: "codebuddy:conv-n",
      bridge: "skill-bridge",
      endpoint: "files/read",
      httpStatus: 200,
    }, [{ assetId: "skl-2", assetType: "skill" }]);

    const used = repo.bySessionKey("codebuddy:conv-n", "used");
    expect(used[0].evidence?.tool_call?.endpoint).toBe("files/read");
    expect(used[0].evidence?.decision).toBeUndefined();
  });
});

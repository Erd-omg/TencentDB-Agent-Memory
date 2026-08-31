/**
 * F3 测试 —— mem:correct 命令（用户主动纠正 → corrected 事件）。
 *
 * 覆盖赛题 F3：
 *   - 对已进入证据链的资产落 corrected 事件，evidence.source = "user"。
 *   - 只允许纠正有前置阶段（recalled/used/validated…）的资产。
 *   - 原因写入 evidence.decision。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeCorrect } from "../mem-command/commands/correct.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { MemCommandContext } from "../mem-command/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "correct-test-"));
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

function makeCtx(overrides: Partial<MemCommandContext> = {}): MemCommandContext {
  return {
    sessionKey: "codebuddy:conv-c",
    agentSource: "codebuddy",
    config: {} as any,
    spaceId: "space-c",
    userId: "usr-c",
    apiKey: "k",
    sessionInfo: {
      team_id: "team-c",
      agent_id: "agt-c",
      session_id: "conv-c",
      task_id: "task-c",
    },
    protocol: "anthropic",
    stream: false,
    args: "",
    ...overrides,
  };
}

describe("executeCorrect（F3）", () => {
  it("对已 used 过的资产落 corrected，evidence.source=user 且带原因", async () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-1", assetType: "skill", version: 2, name: "demo" },
      sessionKey: "codebuddy:conv-c",
    }));

    const res = await executeCorrect(makeCtx({ args: "skl-1 里面的命令过时了，新版 API 已改名" }));
    expect(res.success).toBe(true);

    const corrected = repo.bySessionKey("codebuddy:conv-c", "corrected");
    expect(corrected).toHaveLength(1);
    expect(corrected[0].asset.assetId).toBe("skl-1");
    expect(corrected[0].evidence?.source).toBe("user");
    expect(corrected[0].evidence?.decision).toContain("命令过时");
    expect(res.messageText).toContain("已记录用户纠正");
  });

  it("拒绝纠正从未进入链路的资产", async () => {
    const repo = getAssetEventRepo()!;
    // 会话内无任何 skl-999 记录
    const res = await executeCorrect(makeCtx({ args: "skl-999 有错误" }));
    expect(res.success).toBe(false);
    expect(res.messageText).toContain("未找到资产 skl-999");
    expect(repo.bySessionKey("codebuddy:conv-c", "corrected")).toHaveLength(0);
  });

  it("缺 assetId 参数 → 返回用法提示", async () => {
    const res = await executeCorrect(makeCtx({ args: "" }));
    expect(res.success).toBe(false);
    expect(res.messageText).toContain("用法");
  });
});

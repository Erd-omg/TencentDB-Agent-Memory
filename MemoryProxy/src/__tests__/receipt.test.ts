/**
 * mem:receipt 测试 —— 从 asset_event 聚合生成 Markdown 结构化回执。
 *
 * 覆盖：默认（reference_only 折叠）/ --full / --json / <assetId> 深潜 /
 * 有效性交叉验证 / validated_no_use 汇总 / corrected 状态。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeReceipt } from "../mem-command/commands/receipt.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { MemCommandContext } from "../mem-command/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "receipt-test-"));
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

function ctx(sessionKey = "codebuddy:conv-demo", args = ""): MemCommandContext {
  return {
    sessionKey,
    agentSource: "codebuddy",
    config: {} as never,
    spaceId: "",
    userId: "usr-demo",
    apiKey: "key",
    sessionInfo: { team_id: "team-demo", agent_id: "agt-demo", task_id: "task-demo" },
    protocol: "openai",
    stream: false,
    args,
    thinking: false,
  };
}

/** 造一个 used+validated 的 skill + 一个 injected-only 的 chat-memory。 */
function seedDemoEvents(): void {
  const repo = getAssetEventRepo()!;
  repo.insert(repo.newEvent({
    stage: "injected",
    asset: { assetId: "skl-1", assetType: "skill", version: 3, name: "tool-guide", source: "self" },
    sessionKey: "codebuddy:conv-demo",
  }));
  repo.insert(repo.newEvent({
    stage: "used",
    asset: { assetId: "skl-1", assetType: "skill", version: 3, name: "tool-guide", source: "self" },
    sessionKey: "codebuddy:conv-demo",
    evidence: { tool_call: { bridge: "skill-bridge", endpoint: "get-by-name", httpStatus: 200 } },
  }));
  repo.insert(repo.newEvent({
    stage: "validated",
    asset: { assetId: "skl-1", assetType: "skill", version: 3, name: "tool-guide", source: "self" },
    sessionKey: "codebuddy:conv-demo",
    evidence: {
      test_result: { runner: "command", command: "node validate.mjs", exitCode: 0, output: "PASS", durationMs: 12 },
    },
  }));
  repo.insert(repo.newEvent({
    stage: "injected",
    asset: { assetId: "atc-9", assetType: "chat-memory", name: "用户偏好 NTFS ACL", source: "迁移专家" },
    sessionKey: "codebuddy:conv-demo",
  }));
}

describe("executeReceipt", () => {
  it("空会话 → 提示暂无证据", async () => {
    const r = await executeReceipt(ctx());
    expect(r.success).toBe(false);
    expect(r.messageText).toContain("暂无资产证据");
  });

  it("默认：Markdown 分组 + 资产卡 + 有效性 + reference_only 折叠", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx());
    expect(r.success).toBe(true);
    expect(r.messageText).toContain("## 📋 资产使用回执（本会话）");
    expect(r.messageText).toContain("**应用资产：2 项**（Skill 1 · Chat-Memory 1）");
    expect(r.messageText).toContain("**证据链计数：** 注入 2 · 使用 1 · 已验证 1");
    expect(r.messageText).toContain("**有效性：** ✅已验证 1");
    // 类型分组标题
    expect(r.messageText).toContain("## Skill（1）");
    expect(r.messageText).toContain("## Chat-Memory（1）");
    // 资产卡（阶段路径 / 有效性 / 最新证据）
    expect(r.messageText).toContain("### tool-guide v3 · 来源 self");
    expect(r.messageText).toContain("注入 → 使用 → 已验证");
    expect(r.messageText).toContain("✅ 已通过测试验证");
    expect(r.messageText).toContain("exit=0");
    // 决策证据（used 事件 tool_call）
    expect(r.messageText).toContain("决策证据：工具调用 skill-bridge/get-by-name");
    // reference_only 默认折叠 → 不渲染卡片细节（来源 迁移专家 不应出现）
    expect(r.messageText).toContain("> 💤 仅背景参考（1 项）");
    expect(r.messageText).not.toContain("来源 迁移专家");
    // 脚注（数据来源诚实边界）
    expect(r.messageText).toContain("数据来自 asset_event 事件表");
  });

  it("--full 展开 reference_only 资产卡", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx("codebuddy:conv-demo", "--full"));
    expect(r.messageText).toContain("### 用户偏好 NTFS ACL · 来源 迁移专家");
    expect(r.messageText).not.toContain("> 💤 仅背景参考");
  });

  it("--json 输出结构化数据", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx("codebuddy:conv-demo", "--json"));
    const parsed = JSON.parse(r.messageText) as {
      asset_count: number;
      effectiveness: Record<string, number>;
      assets: Array<{ asset_id: string; stages: string[]; effectiveness: string; events: unknown[] }>;
    };
    expect(parsed.asset_count).toBe(2);
    expect(parsed.effectiveness.validated).toBe(1);
    expect(parsed.assets.find((a) => a.asset_id === "skl-1")?.stages).toContain("used");
    expect(parsed.assets.find((a) => a.asset_id === "skl-1")?.effectiveness).toBe("validated");
    expect(parsed.assets.find((a) => a.asset_id === "skl-1")?.events.length).toBe(3);
  });

  it("<assetId> 深潜：列出该资产全部证据事件", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx("codebuddy:conv-demo", "skl-1"));
    expect(r.messageText).toContain("## 📋 资产回执 · tool-guide");
    expect(r.messageText).toContain("证据事件（3）");
    expect(r.messageText).toContain("[使用]");
    expect(r.messageText).toContain("[已验证]");
  });

  it("<assetId> 不存在 → 提示未找到", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx("codebuddy:conv-demo", "skl-nope"));
    expect(r.messageText).toContain("未找到资产 skl-nope");
  });

  it("corrected 资产 → 状态显示需修正", async () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-bad", assetType: "skill", name: "broken" },
      sessionKey: "codebuddy:conv-demo",
    }));
    repo.insert(repo.newEvent({
      stage: "corrected",
      asset: { assetId: "skl-bad", assetType: "skill", name: "broken" },
      sessionKey: "codebuddy:conv-demo",
      evidence: { test_result: { runner: "command", command: "x", exitCode: 1, output: "FAIL", durationMs: 1 } },
    }));

    const r = await executeReceipt(ctx());
    expect(r.messageText).toContain("❌ 需修正");
    expect(r.messageText).toContain("注入 → 已纠正");
    expect(r.messageText).toContain("❌需修正 1");
  });

  it("validated-无-used → 汇总行暴露 ⚠️已标记验证(缺使用)", async () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-a", assetType: "skill", name: "guide-a" },
      sessionKey: "codebuddy:conv-demo",
    }));
    repo.insert(repo.newEvent({
      stage: "validated",
      asset: { assetId: "skl-a", assetType: "skill", name: "guide-a" },
      sessionKey: "codebuddy:conv-demo",
      evidence: { test_result: { runner: "command", command: "x", exitCode: 0, output: "PASS", durationMs: 1 } },
    }));

    const r = await executeReceipt(ctx());
    expect(r.messageText).toContain("⚠️已标记验证(缺使用) 1");
    expect(r.messageText).toContain("⚠️ 已标记验证（缺使用证据）");
  });
});

/**
 * task-completion + receipt-summary 测试 —— 任务收尾检测与简短回执摘要。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shouldAutoAppendReceipt, resetAutoReceipt, isToolFreeTurn, hasAssetEngagement } from "../evidence/task-completion.js";
import { renderReceiptSummary } from "../evidence/receipt-summary.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-completion-test-"));
  process.env.PROXY_DB_PATH = join(tmpDir, "proxy.db");
  __resetAssetEventRepoForTests();
  __resetDbForTests();
});

afterEach(() => {
  __resetAssetEventRepoForTests();
  __resetDbForTests();
  delete process.env.PROXY_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  resetAutoReceipt("codebuddy:conv-x");
});

describe("shouldAutoAppendReceipt（工具工作后连续 N 轮无工具 + 证据锚定）", () => {
  it("isToolFreeTurn：无 tool_calls → true；有 → false", () => {
    expect(isToolFreeTurn({})).toBe(true);
    expect(isToolFreeTurn({ content: "回答" })).toBe(true);
    expect(isToolFreeTurn({ tool_calls: [] })).toBe(true);
    expect(isToolFreeTurn({ tool_calls: [{ id: "x" }] })).toBe(false);
    expect(isToolFreeTurn(null)).toBe(true);
  });

  it("有证据 + 连续 2 轮无工具调用 → 触发自动追加（默认阈值）", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "第一轮" }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "第二轮" }, true)).toBe(true);
  });

  it("无证据（hasEvidence=false）即使 2 轮也不触发，且不消费 autoShown（修 double-bug）", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "一" }, false)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "二" }, false)).toBe(false);
    // autoShown 未被消费：证据随后出现 → 下一轮无工具（streak=3）→ 触发
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "三" }, true)).toBe(true);
  });

  it("证据粘性：一旦出现 used/selected 证据即保持（后续 hasEvidence=false 不影响）", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "一" }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "二" }, false)).toBe(true);
  });

  it("中间有工具调用则重置 streak", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "一" }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { tool_calls: [{ id: "t" }] }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "二" }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { content: "三" }, true)).toBe(true);
  });

  it("每会话只自动追加一次", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(true);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(false); // 已展示
  });

  it("触发后即使工具轮也不再触发（autoShown 已消费）", () => {
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(true);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", { tool_calls: [{ id: "t" }] }, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(false);
  });

  it("不同会话独立计数", () => {
    resetAutoReceipt("codebuddy:conv-y");
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-y", {}, true)).toBe(false);
    expect(shouldAutoAppendReceipt("codebuddy:conv-x", {}, true)).toBe(true);
    expect(shouldAutoAppendReceipt("codebuddy:conv-y", {}, true)).toBe(true);
  });
});

describe("hasAssetEngagement（证据锚定查询）", () => {
  it("无事件 → false", () => {
    expect(hasAssetEngagement("codebuddy:conv-x")).toBe(false);
  });

  it("仅 recalled/injected → false（只是召回候选，不算实质使用）", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "recalled",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "codebuddy:conv-x",
    }));
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-2", assetType: "skill" },
      sessionKey: "codebuddy:conv-x",
    }));
    expect(hasAssetEngagement("codebuddy:conv-x")).toBe(false);
  });

  it("有 used → true", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-1", assetType: "skill" },
      sessionKey: "codebuddy:conv-x",
    }));
    expect(hasAssetEngagement("codebuddy:conv-x")).toBe(true);
  });

  it("有 selected → true", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "selected",
      asset: { assetId: "atc-1", assetType: "chat-memory" },
      sessionKey: "codebuddy:conv-x",
    }));
    expect(hasAssetEngagement("codebuddy:conv-x")).toBe(true);
  });
});

describe("renderReceiptSummary", () => {
  it("无可回溯证据 → null（不追加）", () => {
    expect(renderReceiptSummary("codebuddy:conv-x")).toBeNull();
  });

  it("有事件 → 简短摘要（应用资产数 + 有效性 + 关键采用）", () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-1", assetType: "skill", name: "tool-guide", source: "self" },
      sessionKey: "codebuddy:conv-x",
      evidence: { tool_call: { bridge: "skill-bridge", endpoint: "get-by-name", httpStatus: 200 } },
    }));
    repo.insert(repo.newEvent({
      stage: "validated",
      asset: { assetId: "skl-1", assetType: "skill", name: "tool-guide", source: "self" },
      sessionKey: "codebuddy:conv-x",
      evidence: { test_result: { runner: "command", command: "x", exitCode: 0, output: "PASS", durationMs: 1 } },
    }));
    repo.insert(repo.newEvent({
      stage: "injected",
      asset: { assetId: "skl-2", assetType: "skill", name: "standards", source: "self" },
      sessionKey: "codebuddy:conv-x",
    }));

    const summary = renderReceiptSummary("codebuddy:conv-x");
    expect(summary).not.toBeNull();
    expect(summary).toContain("应用资产 2 项");
    expect(summary).toContain("已验证 1");
    expect(summary).toContain("tool-guide"); // 关键采用
    expect(summary).toContain("mem:receipt");
  });
});

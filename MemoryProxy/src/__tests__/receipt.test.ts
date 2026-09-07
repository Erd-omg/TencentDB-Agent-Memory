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

  it("默认：对外平实语言（类别分组 + 作用/为什么适用/plain 风险；去工程口径）", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx());
    expect(r.success).toBe(true);
    expect(r.messageText).toContain("## 📋 资产使用回执（本会话）");
    // 平实标题 + 计数（非工程术语）。
    expect(r.messageText).toContain("本次应用 2 项团队资产");
    expect(r.messageText).toMatch(/✅ 1 项已通过验证/);
    // 类别分组（过程资产类别）＋ 每卡「作用/为什么适用/风险」。
    expect(r.messageText).toMatch(/^## 📘 历史方案（1 项）$/m);
    expect(r.messageText).toContain("### tool-guide v3 · ✅ 已通过测试验证");
    expect(r.messageText).toContain("- 作用：");
    expect(r.messageText).toContain("- 为什么适用：");
    expect(r.messageText).toContain("- 风险：");
    // reference_only 折叠（按字符截断名字）。
    expect(r.messageText).toMatch(/仅背景参考（1 项）：用户偏好 NTFS ACL/);
    // 去工程口径：无阶段路径/决策证据/证据详情提示/归因。
    expect(r.messageText).not.toContain("召回 → 选中");
    expect(r.messageText).not.toContain("决策证据：");
    expect(r.messageText).not.toContain("证据详情：");
    expect(r.messageText).not.toContain("归因:");
    // 文末导出入口提示。
    expect(r.messageText).toContain("mem:receipt --json");
    expect(r.messageText).toContain("mem:receipt --full");
    // 数据来源（非模型自述）。
    expect(r.messageText).toContain("asset_event 事件表");
  });

  it("--full 技术明细（阶段/决策证据/证据细节/类型分组/双计数）", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx("codebuddy:conv-demo", "--full"));
    // 技术标题带来源
    expect(r.messageText).toContain("### 用户偏好 NTFS ACL · 来源 迁移专家");
    expect(r.messageText).not.toContain("> 💤 仅背景参考");
    // 工程锚点：阶段路径/决策证据/证据细节。
    expect(r.messageText).toContain("注入 → 使用 → 已验证");
    expect(r.messageText).toContain("决策证据：工具调用 skill-bridge/get-by-name");
    expect(r.messageText).toContain("证据细节：[command] exit=0");
    // 类型分组（## Skill（N））+ 双计数。
    expect(r.messageText).toMatch(/^## Skill（1）$/m);
    expect(r.messageText).toContain("**证据链（事件计数）：**");
  });

  it("推荐资产卡 - 有 rerank 时给出平实「为什么适用」；injected 计数在 --full 按资产去重", async () => {
    const repo = getAssetEventRepo()!;
    // 同一资产多轮 injected（缓存命中重打）→ 回执按资产去看（--full 双口径可见）。
    for (let i = 0; i < 3; i++) {
      repo.insert(repo.newEvent({
        stage: "injected",
        asset: { assetId: "skl-r", assetType: "skill", name: "migration-expert-tips", source: "agt-b" },
        sessionKey: "codebuddy:conv-demo",
      }));
    }
    repo.insert(repo.newEvent({
      stage: "selected",
      asset: { assetId: "skl-r", assetType: "skill", name: "migration-expert-tips", source: "agt-b" },
      sessionKey: "codebuddy:conv-demo",
      evidence: {
        decision: "rerank",
        rerank: {
          weightedScore: 0.59,
          dims: { relevance: 0.5, credibility: 0.5, freshness: 0.5, envCompat: 0.5, historicalEffect: 0.5, tokenCost: 0.5 },
          passed: true,
          trimmedByBudget: false,
          rank: 5,
          threshold: 0.55,
        },
      },
    }));

    const r = await executeReceipt(ctx());
    // 默认平实标题（无来源）＋ 平实「为什么适用」（含综合分）。
    expect(r.messageText).toContain("### migration-expert-tips · ⏳ 已选中待采用");
    expect(r.messageText).toContain("为什么适用：");
    // --full 双计数：按资产去重 注入 1（非 3）；事件计数 注入 3（阶段按 STAGE_ORDER：选中在注入前）。
    const full = await executeReceipt(ctx("codebuddy:conv-demo", "--full"));
    expect(full.messageText).toContain("**证据链（按资产去重）：** 选中 1 · 注入 1");
    expect(full.messageText).toContain("**证据链（事件计数）：** 选中 1 · 注入 3");
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

  it("回执不带 Panel 深链（⑨ 已移除 2026-09-05：CodeBuddy webview 点不开外链，用户决定删除）", async () => {
    seedDemoEvents();
    const r = await executeReceipt(ctx());
    expect(r.messageText).not.toContain("Panel 证据页");
    expect(r.messageText).not.toContain("/#/evidence");
    // --json 同样不带。
    const json = await executeReceipt(ctx("codebuddy:conv-demo", "--json"));
    expect(json.messageText).not.toContain("Panel 证据页");
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
    // 默认平实：标题带「❌ 需修正」＋ 计数「❌ 1 项需修正」。
    expect(r.messageText).toContain("### broken · ❌ 需修正");
    expect(r.messageText).toContain("❌ 1 项需修正");
    // --full 保留阶段路径（注入 → 已纠正）。
    const full = await executeReceipt(ctx("codebuddy:conv-demo", "--full"));
    expect(full.messageText).toContain("注入 → 已纠正");
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
    // 默认平实诚实说明（不再用 validated_no_use 术语计数）。
    expect(r.messageText).toContain("但证据中缺少「实际使用」记录");
    // 状态徽标（EFFECTIVENESS_META 标签）仍在标题。
    expect(r.messageText).toContain("⚠️ 已标记验证（缺使用证据）");
    // --full 保留精确术语 ⇐ already covered; 这里再确认 default 无该术语计数。
    expect(r.messageText).not.toContain("已标记验证(缺使用) 1");
  });
});

/**
 * receipt 渲染（平实 vs 技术明细）测试 —— 只测 `receipt.ts` 的 Markdown 形状，
 * 不涉数据聚合（receipt-data 单测已覆盖）。锚定：
 *   - 默认（plain）：按过程资产类别分组 + 每卡「作用/为什么适用/风险」；无阶段/决策证据/归因；
 *     reference_only 按字符截断列名；文末 --json/--full 提示。
 *   - --full（tech）：阶段路径/决策证据/证据细节（含 归因）/类型分组/双计数/链提醒；reference_only 全铺开。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderMarkdownReceipt } from "../mem-command/commands/receipt.js";
import { buildReceiptData } from "../evidence/receipt-data.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "receipt-render-test-"));
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

describe("renderMarkdownReceipt — 平实 vs 技术明细", () => {
  it("默认（plain）：类别分组 + 作用/为什么适用/风险；无工程口径；reference_only 截断列名", () => {
    const repo = getAssetEventRepo()!;
    // 一项走完 召回→选中→注入→使用→已验证 的资产（带 test_result + correlation）。
    for (const stage of ["recalled", "selected", "injected", "used"] as const) {
      repo.insert(repo.newEvent({
        stage,
        asset: { assetId: "skl-guide", assetType: "skill", name: "cloud-migration-tool-guide", version: 3, source: "self" },
        sessionKey: "sess-x",
      }));
    }
    repo.insert(repo.newEvent({
      stage: "validated",
      asset: { assetId: "skl-guide", assetType: "skill", name: "cloud-migration-tool-guide", version: 3, source: "self" },
      sessionKey: "sess-x",
      evidence: {
        test_result: { runner: "node --test", command: "node --test", exitCode: 0, output: "pass 6", durationMs: 10 },
        code_diff: "diff --git a/src/w.js b/src/w.js",
        outcome: "目标仓库真实测试通过（exit 0）· pass 6 · fail 0",
        correlation: { type: "token-overlap", heuristic: true, hits: ["cloud", "migration"], sharedHits: ["cloud"], pathHits: ["migration"] },
      },
    }));
    // 一项仅背景参考（超长名，验证截断）。
    repo.insert(repo.newEvent({
      stage: "recalled",
      asset: { assetId: "skl-bg", assetType: "skill", name: "windows-vss-acl-sequence-acceptance-".repeat(4), version: 1, source: "self" },
      sessionKey: "sess-x",
    }));

    const data = buildReceiptData("sess-x")!;
    const md = renderMarkdownReceipt(data, "plain");

    // 平实：给「作用/为什么适用/风险」，去工程口径。
    expect(md).toContain("- 作用：");
    expect(md).toContain("- 为什么适用：");
    expect(md).toContain("- 风险：");
    expect(md).not.toContain("归因:");
    expect(md).not.toContain("token-overlap");
    expect(md).not.toContain("召回 → 选中");
    expect(md).not.toContain("决策证据：");
    expect(md).not.toContain("证据详情：");
    // 类别分组标题（过程资产类别）＋ 平实卡标题（无来源）。
    expect(md).toMatch(/历史方案/);
    expect(md).toMatch(/### cloud-migration-tool-guide v3 · ✅ 已通过测试验证/);
    // reference_only 列名——超长名被字符截断（不出现完整 repeat）。
    expect(md).toMatch(/仅背景参考（1 项）：windows-vss-acl-sequence-acceptance-/);
    expect(md).not.toContain("windows-vss-acl-sequence-acceptance-".repeat(4));
    // 文末入口提示。
    expect(md).toContain("mem:receipt --json");
    expect(md).toContain("mem:receipt --full");
  });

  it("--full（tech）：阶段/决策证据/证据细节（含归因）/类型分组/双计数；reference_only 全铺开", () => {
    const repo = getAssetEventRepo()!;
    for (const stage of ["recalled", "selected", "injected", "used"] as const) {
      repo.insert(repo.newEvent({
        stage,
        asset: { assetId: "skl-guide", assetType: "skill", name: "cloud-migration-tool-guide", version: 3, source: "self" },
        sessionKey: "sess-y",
      }));
    }
    repo.insert(repo.newEvent({
      stage: "validated",
      asset: { assetId: "skl-guide", assetType: "skill", name: "cloud-migration-tool-guide", version: 3, source: "self" },
      sessionKey: "sess-y",
      evidence: {
        test_result: { runner: "node --test", command: "node --test", exitCode: 0, output: "pass 6", durationMs: 10 },
        correlation: { type: "token-overlap", heuristic: true, hits: ["cloud", "migration"], sharedHits: ["cloud"], pathHits: ["migration"] },
      },
    }));
    repo.insert(repo.newEvent({
      stage: "recalled",
      asset: { assetId: "skl-bg", assetType: "skill", name: "windows-vss-acl-sequence-acceptance", version: 1, source: "self" },
      sessionKey: "sess-y",
    }));

    const data = buildReceiptData("sess-y")!;
    const md = renderMarkdownReceipt(data, "tech");

    // 工程锚点。
    expect(md).toContain("召回 → 选中 → 注入 → 使用 → 已验证");
    expect(md).toContain("归因:");
    expect(md).toContain("token-overlap");
    expect(md).toMatch(/^## Skill（\d+）$/m);
    expect(md).toContain("**证据链（事件计数）：**");
    // reference_only 铺开成卡（技术标题带来源），不再有折叠提示（名字被自然截断）。
    expect(md).toMatch(/^### .*💤 仅背景参考$/m);
    expect(md).not.toMatch(/仅背景参考（\d+ 项）/);
  });
});

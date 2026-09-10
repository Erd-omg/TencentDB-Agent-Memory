/**
 * 候选资产生成器（evidence/propose.ts）—— 单测。
 *
 * 覆盖 generateCandidates 的确定性规则：
 *   - used→validated/contributed 资产 → 经验确认候选（去重）
 *   - diffSummary + exit 0 → 修复经验候选
 *   - corrections → 纠错经验候选（风险 high）
 *   - 无信号 → 空
 *   - 语义桶由 categorizeSkill 归类（不硬编码二值）
 *   - risk 对齐 §6.4 缺省推导（失败经验→high，约定→low）
 *   - source/evidence 结构化字段对齐 §6.4
 */

import { describe, it, expect } from "vitest";
import { generateCandidates, proposeFromSession } from "../evidence/propose.js";
import type { AssetEvent } from "../db/asset-event.js";

function mkEvent(stage: AssetEvent["stage"], assetId: string, name: string): AssetEvent {
  return {
    id: `evt-${stage}-${assetId}`,
    stage,
    asset: { assetId, assetType: "skill", name },
    sessionKey: "sess-propose",
    createdAt: Date.now(),
  };
}

describe("generateCandidates", () => {
  const baseInput = {
    sessionKey: "sess-propose",
    sessionInfo: { team_id: "team-1", user_id: "user-1", task_id: "task-1" },
    usedEvents: [] as AssetEvent[],
  };

  it("无信号时返回空（诚实：不生成空候选）", () => {
    const drafts = generateCandidates(baseInput);
    expect(drafts).toEqual([]);
  });

  it("validated/contributed 资产 → 经验确认候选（同资产去重）", () => {
    const drafts = generateCandidates({
      ...baseInput,
      usedEvents: [
        mkEvent("used", "skl-1", "vss-acl-order"),
        mkEvent("validated", "skl-1", "vss-acl-order"),
        mkEvent("contributed", "skl-1", "vss-acl-order"),
      ],
    });
    // 同一 asset 的 validated+contributed 只生成一条
    const reuse = drafts.filter((d) => d.assetId.startsWith("cand-reuse-"));
    expect(reuse.length).toBe(1);
    expect(reuse[0].evidence.validated).toBe(true);
  });

  it("diffSummary + exit 0 → 修复经验候选", () => {
    const drafts = generateCandidates({
      ...baseInput,
      diffSummary: "src/windows-migration.js: 交换 ACL/VSS 顺序",
      testResult: { exitCode: 0, testCmd: "node --test" },
    });
    const fix = drafts.find((d) => d.assetId.startsWith("cand-task-"))!;
    expect(fix).toBeDefined();
    expect(fix.evidence.validated).toBe(true);
    expect(fix.evidence.resultRef).toContain("task-1");
  });

  it("corrections → 纠错经验候选（风险 high，evidence.validated=false）", () => {
    const drafts = generateCandidates({
      ...baseInput,
      corrections: [{ assetId: "skl-old", note: "命令过时，新版 API 已改名" }],
    });
    const corr = drafts.find((d) => d.assetId.startsWith("cand-corr-"))!;
    expect(corr).toBeDefined();
    expect(corr.risk).toBe("high");
    expect(corr.evidence.validated).toBe(false);
    expect(corr.content).toContain("skl-old");
  });

  it("语义桶由 categorizeSkill 归类（含 postmortem → 失败经验，不硬编码）", () => {
    const drafts = generateCandidates({
      ...baseInput,
      usedEvents: [mkEvent("contributed", "skl-x", "cloud-migration-postmortems")],
    });
    const d = drafts.find((x) => x.name.includes("postmortem"))!;
    expect(d.bucket).toBe("失败经验");
  });

  it("risk 对齐 §6.4：正文含 rollback 关键词 → high（bucket 与 risk 正交）", () => {
    const drafts = generateCandidates({
      ...baseInput,
      usedEvents: [mkEvent("contributed", "skl-x", "rollback-incomplete")],
    });
    const d = drafts.find((x) => x.name.includes("rollback"))!;
    // bucket 由 categorizeSkill 决定（rollback 不在失败经验关键词表 → 兜底 Skill）
    // risk 由 deriveRisk 独立推导（content 含 rollback → high）
    expect(d.risk).toBe("high");
  });

  it("source 结构化字段：有 task_id → kind=task", () => {
    const drafts = generateCandidates({
      ...baseInput,
      diffSummary: "x",
      testResult: { exitCode: 0 },
    });
    const d = drafts[0];
    expect(d.source).toEqual({ kind: "task", ref: "task-1" });
  });

  it("source 结构化字段：无 task_id → kind=session", () => {
    const drafts = generateCandidates({
      sessionKey: "sess-abc",
      sessionInfo: { team_id: "t", user_id: "u" },
      usedEvents: [mkEvent("contributed", "skl-1", "name-1")],
    });
    const d = drafts[0];
    expect(d.source).toEqual({ kind: "session", ref: "sess-abc" });
  });

  it("proposeFromSession 异常兜底返回 []", () => {
    const result = proposeFromSession({
      sessionKey: "s",
      sessionInfo: {},
      usedEvents: null as unknown as AssetEvent[],
    });
    expect(result).toEqual([]);
  });
});

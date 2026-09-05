/**
 * 任务二 六维重排 —— 单测。
 *
 * 覆盖：min-max 归一化 / 排序 / passed 双条件（阈值 AND topN）、envCompat 矩阵、
 * freshness 半衰期、credibility（跨会话 validated/used/corrected）、historicalEffect、
 * taskType 桶微调、tokenCost、空候选、来源标注。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rerankCandidates } from "../retrieval/rerank.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { AssetEventStage } from "../db/asset-event.js";
import type { RerankConfigShape, RetrievalHit } from "../retrieval/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rerank-test-"));
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

const CFG: RerankConfigShape = {
  weights: {
    relevance: 0.4, credibility: 0.15, freshness: 0.1,
    envCompat: 0.1, historicalEffect: 0.15, tokenCost: 0.1,
  },
  selectedThreshold: 0.55,
  topN: 3,
  freshnessHalfLifeDays: 30,
  // 默认 sameTeamOnly + 极宽时间窗 → 既有历史信号全部计入（新过滤测试单独用窄窗/他 team）。
  effect: { sameTeamOnly: true, windowDays: 999_999 },
};

const CTX = { teamId: "team-a", agentId: "agt-a", sessionKey: "sess-1", query: "修复" };
const NOW = 1_800_000_000_000;

/** 构造规范化候选 RetrievalHit（接受旧 skill 风格字段作兼容）。 */
type HitSeed = Partial<RetrievalHit> & {
  skill_id?: string;
  owner_agent_id?: string;
  team_id?: string;
  updated_at_ms?: number;
  created_at_ms?: number;
};

function hit(o: HitSeed): RetrievalHit {
  const id = o.assetId ?? o.skill_id ?? "skl-x";
  return {
    assetId: id,
    assetType: o.assetType ?? "skill",
    name: o.name ?? id,
    description: o.description ?? "",
    snippet: o.snippet,
    version: o.version ?? 1,
    score: o.score ?? 0,
    ownerAgentId: o.ownerAgentId ?? o.owner_agent_id,
    teamId: o.teamId ?? o.team_id,
    updatedAtMs: o.updatedAtMs ?? o.updated_at_ms,
    createdAtMs: o.createdAtMs ?? o.created_at_ms,
    sourceRole: o.sourceRole,
    sourceId: o.sourceId ?? "team-skill",
  };
}

/** 向临时 repo 插入一条事件。 */
function addEvt(stage: AssetEventStage, assetId: string): void {
  const repo = getAssetEventRepo()!;
  repo.insert(repo.newEvent({
    stage,
    asset: { assetId, assetType: "skill", name: assetId },
    sessionKey: "hist-session",
  }));
}

describe("rerankCandidates — 排序与 passed 双条件", () => {
  it("min-max 归一化后按加权总分降序；threshold AND topN 双条件", () => {
    const hits = [
      hit({ skill_id: "skl-a", owner_agent_id: "agt-a", score: 0.8 }),
      hit({ skill_id: "skl-b", owner_agent_id: "agt-a", score: 0.6 }),
      hit({ skill_id: "skl-c", owner_agent_id: "agt-a", score: 0.4 }),
      hit({ skill_id: "skl-d", owner_agent_id: "agt-a", score: 0.0 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });

    expect(out.map((c) => c.hit.assetId)).toEqual(["skl-a", "skl-b", "skl-c", "skl-d"]);
    // 尾部贡献（cred/fresh/env/hist/cost）≈0.4；weighted = 0.4·rel + ≈0.4（cost 受 name 字符影响 ~0.0001）
    expect(out[0].weightedScore).toBeCloseTo(0.74, 2);
    expect(out[1].weightedScore).toBeCloseTo(0.67, 2);
    expect(out[2].weightedScore).toBeCloseTo(0.60, 2);
    expect(out[3].weightedScore).toBeCloseTo(0.46, 2);
    expect(out.map((c) => c.passed)).toEqual([true, true, true, false]);
    // rank 1-based
    expect(out[0].rank).toBe(1);
    // 同 agent → source self
    expect(out[0].asset.source).toBe("self");
  });

  it("空候选 → []", () => {
    expect(rerankCandidates({ hits: [], ctx: CTX, cfg: CFG })).toEqual([]);
  });
});

describe("rerankCandidates — envCompat 矩阵", () => {
  it("同 agent > 同 team > 缺 owner(中性) > 跨 team", () => {
    const hits = [
      hit({ skill_id: "self", owner_agent_id: "agt-a", team_id: "team-a", score: 0.7 }),
      hit({ skill_id: "same-team", owner_agent_id: "agt-b", team_id: "team-a", score: 0.7 }),
      hit({ skill_id: "cross-team", owner_agent_id: "agt-c", team_id: "team-z", score: 0.7 }),
      hit({ skill_id: "no-owner", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));
    expect(byId["self"].dimScores.envCompat).toBe(1.0);
    expect(byId["same-team"].dimScores.envCompat).toBe(0.7);
    expect(byId["cross-team"].dimScores.envCompat).toBe(0.3);
    expect(byId["no-owner"].dimScores.envCompat).toBe(0.5);
    // 排序：self > same-team > no-owner(0.55) > cross-team(0.53)
    expect(out.map((c) => c.hit.assetId)).toEqual(["self", "same-team", "no-owner", "cross-team"]);
    // 跨 team 来源标注非 self
    expect(byId["cross-team"].asset.source).toBe("agt-c");
  });
});

describe("rerankCandidates — freshness 半衰期", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("0.5^(Δ/半衰期)，缺 updated_at → 0.5", () => {
    const hits = [
      hit({ skill_id: "now", updated_at_ms: NOW }),
      hit({ skill_id: "half", updated_at_ms: NOW - 30 * DAY }),
      hit({ skill_id: "quarter", updated_at_ms: NOW - 60 * DAY }),
      hit({ skill_id: "none" }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));
    expect(byId["now"].dimScores.freshness).toBeCloseTo(1.0, 5);
    expect(byId["half"].dimScores.freshness).toBeCloseTo(0.5, 5);
    expect(byId["quarter"].dimScores.freshness).toBeCloseTo(0.25, 5);
    expect(byId["none"].dimScores.freshness).toBe(0.5);
  });
});

describe("rerankCandidates — credibility 跨会话", () => {
  it("validated 强、used 中、corrected 惩罚、无历史中性", () => {
    addEvt("validated", "skl-v");
    addEvt("validated", "skl-v");
    addEvt("validated", "skl-v");
    addEvt("used", "skl-u");
    addEvt("used", "skl-c");
    addEvt("corrected", "skl-c");

    const hits = [
      hit({ skill_id: "skl-v", score: 0.7 }),
      hit({ skill_id: "skl-u", score: 0.7 }),
      hit({ skill_id: "skl-n", score: 0.7 }),
      hit({ skill_id: "skl-c", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));
    expect(byId["skl-v"].dimScores.credibility).toBeCloseTo(1.0, 5);
    expect(byId["skl-u"].dimScores.credibility).toBeCloseTo(1 / 6, 5);
    expect(byId["skl-n"].dimScores.credibility).toBe(0.5);
    expect(byId["skl-c"].dimScores.credibility).toBeCloseTo((1 / 6) * 0.5, 5);
  });
});

describe("rerankCandidates — historicalEffect 跨用户", () => {
  it("有效复用比 (validated+0.5·used)/复用次数，corrected 拉低", () => {
    addEvt("used", "skl-a");
    addEvt("used", "skl-a");
    addEvt("validated", "skl-a");
    addEvt("validated", "skl-a");
    addEvt("used", "skl-b");
    addEvt("used", "skl-d");
    addEvt("corrected", "skl-d");

    const hits = [
      hit({ skill_id: "skl-a", score: 0.7 }),
      hit({ skill_id: "skl-b", score: 0.7 }),
      hit({ skill_id: "skl-c", score: 0.7 }),
      hit({ skill_id: "skl-d", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));
    expect(byId["skl-a"].dimScores.historicalEffect).toBeCloseTo(0.75, 5);
    expect(byId["skl-b"].dimScores.historicalEffect).toBeCloseTo(0.5, 5);
    expect(byId["skl-c"].dimScores.historicalEffect).toBe(0.5);
    expect(byId["skl-d"].dimScores.historicalEffect).toBeCloseTo(0.3, 5);
  });
});

describe("rerankCandidates — effect 历史效果收敛（#3 同 team + 时间窗）", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function addHist(skillId: string, stage: AssetEventStage, createdAt: number, teamId?: string): void {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage,
      asset: { assetId: skillId, assetType: "skill", name: skillId },
      sessionKey: "hist-window",
      ...(teamId ? { teamId } : {}),
      createdAt,
    }));
  }

  it("跨 team 的 validated 不计入本 team 资产可信度（他人'已验证'不抬高分）", () => {
    const now = Date.now();
    addHist("skl-x", "validated", now - 1 * DAY, "team-other");
    addHist("skl-x", "validated", now - 2 * DAY, "team-other");
    addHist("skl-x", "validated", now - 3 * DAY, "team-other");

    const hitX = hit({ skill_id: "skl-x", score: 0.7 });
    // sameTeamOnly=true（默认）→ 其它 team 的信号被排除 → 无本 team 历史 → 中性。
    const outTeam = rerankCandidates({ hits: [hitX], ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => now } });
    expect(outTeam[0].dimScores.credibility).toBe(0.5);
    // sameTeamOnly=false → 全计 → 高可信（对比，说明过滤确实生效）。
    const outAll = rerankCandidates({
      hits: [hitX], ctx: CTX,
      cfg: { ...CFG, effect: { sameTeamOnly: false, windowDays: 90 } },
      deps: { repo: getAssetEventRepo(), now: () => now },
    });
    expect(outAll[0].dimScores.credibility).toBeCloseTo(1.0, 5);
  });

  it("超过时间窗的 validated 不计入（过期信号不抬分）", () => {
    const now = Date.now();
    addHist("skl-y", "validated", now - 30 * DAY); // team 空（同部署按同 team 计），但 30 天前
    addHist("skl-y", "validated", now - 31 * DAY);
    addHist("skl-y", "validated", now - 32 * DAY);
    const hitY = hit({ skill_id: "skl-y", score: 0.7 });
    // 窄窗 10 天 → 30 天前的事件被排除 → 中性。
    const outNarrow = rerankCandidates({
      hits: [hitY], ctx: CTX,
      cfg: { ...CFG, effect: { sameTeamOnly: true, windowDays: 10 } },
      deps: { repo: getAssetEventRepo(), now: () => now },
    });
    expect(outNarrow[0].dimScores.credibility).toBe(0.5);
    // 宽窗 60 天 → 计入 → 高可信。
    const outWide = rerankCandidates({
      hits: [hitY], ctx: CTX,
      cfg: { ...CFG, effect: { sameTeamOnly: true, windowDays: 60 } },
      deps: { repo: getAssetEventRepo(), now: () => now },
    });
    expect(outWide[0].dimScores.credibility).toBeCloseTo(1.0, 5);
  });
});

describe("rerankCandidates — taskType 桶微调", () => {
  it("等分下 Bug Fix 任务：失败经验 排 产品知识 前", () => {
    const hits = [
      hit({ skill_id: "skl-fail", name: "失败经验排查", description: "上次故障复盘与规避", score: 0.7 }),
      hit({ skill_id: "skl-prod", name: "产品知识整理", description: "产品需求说明", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, taskType: "bug_fix", deps: { repo: getAssetEventRepo(), now: () => NOW } });
    expect(out[0].hit.assetId).toBe("skl-fail");
    expect(out[1].hit.assetId).toBe("skl-prod");
    // 失败经验 taskMatch=1.0 → relevance = 0.7·0.5 + 0.3·1.0 = 0.65
    expect(out[0].dimScores.relevance).toBeCloseTo(0.65, 5);
    // 产品知识 taskMatch=0 → relevance = 0.35
    expect(out[1].dimScores.relevance).toBeCloseTo(0.35, 5);
  });
});

describe("rerankCandidates — tokenCost", () => {
  it("内容越长 cost 越低；短内容 → 1.0", () => {
    const longDesc = "x".repeat(6000); // ≈2000 tokens → 超过 1500 上限 → cost 0
    const hits = [
      hit({ skill_id: "long", description: longDesc, score: 0.7 }),
      hit({ skill_id: "short", description: "", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));
    expect(byId["long"].dimScores.tokenCost).toBe(0);
    expect(byId["short"].dimScores.tokenCost).toBeCloseTo(1.0, 2);
  });
});

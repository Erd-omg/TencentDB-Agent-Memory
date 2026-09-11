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

/** 向临时 repo 插入一条事件（无身份——供"事件计数公式"类用例）。 */
function addEvt(stage: AssetEventStage, assetId: string): void {
  const repo = getAssetEventRepo()!;
  repo.insert(repo.newEvent({
    stage,
    asset: { assetId, assetType: "skill", name: assetId },
    sessionKey: "hist-session",
  }));
}

/** 身份感知插入：带 user_id/team_id/sessionKey/createdAt —— 用于跨用户/跨会话聚合用例。 */
function addEvtX(
  stage: AssetEventStage,
  assetId: string,
  o: { userId?: string; sessionKey?: string; teamId?: string; createdAt?: number } = {},
): void {
  const repo = getAssetEventRepo()!;
  repo.insert(repo.newEvent({
    stage,
    asset: { assetId, assetType: "skill", name: assetId },
    sessionKey: o.sessionKey ?? "hist-session",
    ...(o.teamId ? { teamId: o.teamId } : {}),
    ...(o.userId ? { userId: o.userId } : {}),
    ...(typeof o.createdAt === "number" ? { createdAt: o.createdAt } : {}),
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

describe("rerankCandidates — credibility（同 team 跨用户/跨会话聚合）", () => {
  it("他 user 的 validated/used（同 team）计入本会话可信度；无历史中性；corrected 打对折", () => {
    // 事件带真实 user_id（usr-A/B/C 互不相同）+ 不同 sessionKey + team-a。byAssetId 只按
    // (asset, team, 窗口) 聚合、不过滤 user → usr-B/C 的 validated/used 会抬升 ctx 的可信度
    // （ctx 是会话 usr-A 视角，属同 team 跨用户历史信号）。
    addEvtX("validated", "skl-v", { userId: "usr-A", sessionKey: "sess-a1", teamId: "team-a" });
    addEvtX("validated", "skl-v", { userId: "usr-A", sessionKey: "sess-a2", teamId: "team-a" });
    addEvtX("validated", "skl-v", { userId: "usr-B", sessionKey: "sess-b1", teamId: "team-a" }); // B 的验证
    addEvtX("used", "skl-u", { userId: "usr-B", sessionKey: "sess-b1", teamId: "team-a" });
    addEvtX("used", "skl-c", { userId: "usr-C", sessionKey: "sess-c1", teamId: "team-a" });
    addEvtX("corrected", "skl-c", { userId: "usr-C", sessionKey: "sess-c1", teamId: "team-a" });

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

describe("rerankCandidates — historicalEffect（同 team 跨用户：他 user 的 validated 计入）", () => {
  it("有效复用比 (validated+0.5·used)/复用次数，corrected 拉低；事件来自不同 user/会话仍聚合", () => {
    addEvtX("used", "skl-a", { userId: "usr-A", sessionKey: "sess-a1", teamId: "team-a" });
    addEvtX("used", "skl-a", { userId: "usr-A", sessionKey: "sess-a1", teamId: "team-a" });
    addEvtX("validated", "skl-a", { userId: "usr-B", sessionKey: "sess-b1", teamId: "team-a" }); // B 的验证计入
    addEvtX("validated", "skl-a", { userId: "usr-B", sessionKey: "sess-b2", teamId: "team-a" });
    addEvtX("used", "skl-b", { userId: "usr-C", sessionKey: "sess-c1", teamId: "team-a" });
    addEvtX("used", "skl-b", { userId: "usr-C", sessionKey: "sess-c2", teamId: "team-a" });
    addEvtX("used", "skl-d", { userId: "usr-A", sessionKey: "sess-a2", teamId: "team-a" });
    addEvtX("corrected", "skl-d", { userId: "usr-A", sessionKey: "sess-a2", teamId: "team-a" });

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

describe("rerankCandidates — contributed 纳入历史效果/可信度（证据链终点信号）", () => {
  it("contributed 与 validated 同等强度计入 historicalEffect/credibility（不再死数据）", () => {
    // skl-c：contributed×2（无 validated/used）→ 历史效果应与 validated×2 等价（有效复用比 1.0）。
    // 对照 skl-v：validated×2；skl-u：used×2。
    addEvtX("contributed", "skl-c", { userId: "usr-A", sessionKey: "sess-c1", teamId: "team-a" });
    addEvtX("contributed", "skl-c", { userId: "usr-A", sessionKey: "sess-c2", teamId: "team-a" });
    addEvtX("validated", "skl-v", { userId: "usr-B", sessionKey: "sess-v1", teamId: "team-a" });
    addEvtX("validated", "skl-v", { userId: "usr-B", sessionKey: "sess-v2", teamId: "team-a" });
    addEvtX("used", "skl-u", { userId: "usr-C", sessionKey: "sess-u1", teamId: "team-a" });
    addEvtX("used", "skl-u", { userId: "usr-C", sessionKey: "sess-u2", teamId: "team-a" });

    const hits = [
      hit({ skill_id: "skl-c", score: 0.7 }),
      hit({ skill_id: "skl-v", score: 0.7 }),
      hit({ skill_id: "skl-u", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));

    // contributed×2 → (0 + 2 + 0) / (0 + 2) = 1.0，与 validated×2 完全一致。
    expect(byId["skl-c"].dimScores.historicalEffect).toBeCloseTo(1.0, 5);
    expect(byId["skl-v"].dimScores.historicalEffect).toBeCloseTo(1.0, 5);
    // used×2 → (0 + 0.5·2) / 2 = 0.5（弱于 contributed）。
    expect(byId["skl-u"].dimScores.historicalEffect).toBeCloseTo(0.5, 5);

    // credibility：contributed 与 validated 同为 ×2 强信号 → (2·2)/6 = 4/6。
    expect(byId["skl-c"].dimScores.credibility).toBeCloseTo(4 / 6, 5);
    expect(byId["skl-v"].dimScores.credibility).toBeCloseTo(4 / 6, 5);
    expect(byId["skl-u"].dimScores.credibility).toBeCloseTo(2 / 6, 5); // used×2 → 2/6
  });

  it("validated+contributed 同批写入去重（方案 A：一次贡献只算一次强信号，不双算）", () => {
    // 真实场景：finalize 里 validated 写成功后立即追加 contributed（同资产、同任务）。
    // 方案 A 语义：contributed 覆盖 validated，strong = max(validated, contributed)。
    // 若简单相加 (validated+contributed)*2 会双算 → 本测试锁定「去重」。
    addEvtX("validated", "skl-same", { userId: "usr-A", sessionKey: "sess-f1", teamId: "team-a" });
    addEvtX("contributed", "skl-same", { userId: "usr-A", sessionKey: "sess-f1", teamId: "team-a" });
    // 对照：仅 validated×1（无 contributed），二者应等价。
    addEvtX("validated", "skl-only", { userId: "usr-B", sessionKey: "sess-g1", teamId: "team-a" });

    const hits = [
      hit({ skill_id: "skl-same", score: 0.7 }),
      hit({ skill_id: "skl-only", score: 0.7 }),
    ];
    const out = rerankCandidates({ hits, ctx: CTX, cfg: CFG, deps: { repo: getAssetEventRepo(), now: () => NOW } });
    const byId = Object.fromEntries(out.map((c) => [c.hit.assetId, c]));

    // historicalEffect：skl-same 应 = (max(1,1) + 0) / (0 + 1) = 1.0，而非 (1+1)/2 = 1.0 的巧合——
    // 用「同批 1 次」对比「仅 validated 1 次」：二者应完全一致（去重生效，不双算）。
    expect(byId["skl-same"].dimScores.historicalEffect).toBeCloseTo(1.0, 5);
    expect(byId["skl-only"].dimScores.historicalEffect).toBeCloseTo(1.0, 5);

    // credibility：skl-same = (max(1,1)*2)/6 = 2/6，skl-only 同样 2/6 —— 同批双写不抬分。
    expect(byId["skl-same"].dimScores.credibility).toBeCloseTo(2 / 6, 5);
    expect(byId["skl-only"].dimScores.credibility).toBeCloseTo(2 / 6, 5);
  });

  it("contributed 受同 team + 时间窗收敛（他 team 的 contributed 不计入）", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const repo = getAssetEventRepo()!;
    // 他 team 的 contributed → sameTeamOnly 排除。
    repo.insert(repo.newEvent({
      stage: "contributed",
      asset: { assetId: "skl-x", assetType: "skill", name: "skl-x" },
      sessionKey: "sess-z",
      teamId: "team-z",
      userId: "usr-A",
      createdAt: NOW - DAY,
    }));
    const hitX = hit({ skill_id: "skl-x", name: "skl-x", owner_agent_id: "agt-a", team_id: "team-a", score: 0.5 });
    const out = rerankCandidates({
      hits: [hitX], ctx: CTX,
      cfg: { ...CFG, selectedThreshold: 0.65, topN: 1, effect: { sameTeamOnly: true, windowDays: 90 } },
      deps: { repo, now: () => NOW },
    });
    // 他 team contributed 被排除 → 历史效果中性。
    expect(out[0].dimScores.historicalEffect).toBe(0.5);
  });
});

describe("rerankCandidates — cross-user gain flip（A 的 validated 抬升 B → 翻转入选）", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("usr-A 对共享 skill S 的 used/validated → usr-B(ctx) 检索 S 的 credibility/historicalEffect 抬升并翻转入选", () => {
    const ctxB = { ...CTX, userId: "usr-B" }; // 跨用户：S 的历史由 usr-A 沉淀，ctx 是 usr-B
    const repo = getAssetEventRepo()!;
    const hits = [
      hit({ skill_id: "skl-gain", name: "skl-gain", owner_agent_id: "agt-a", team_id: "team-a", score: 0.5 }),
      hit({ skill_id: "skl-neu", name: "skl-neu", owner_agent_id: "agt-a", team_id: "team-a", score: 0.5 }),
    ];
    const mk = (windowDays: number, threshold: number, topN: number) => ({
      ...CFG, selectedThreshold: threshold, topN,
      effect: { sameTeamOnly: true, windowDays },
    });
    const deps = { repo, now: (): number => NOW };

    // baseline：windowDays≈0 → usr-A 的历史在窗外 → S 与 N 同为中性、不入选。
    const base = rerankCandidates({ hits, ctx: ctxB, cfg: mk(0.001, 0.65, 1), deps });
    const gainBase = base.find((c) => c.hit.assetId === "skl-gain")!;
    expect(gainBase.dimScores.credibility).toBe(0.5);
    expect(gainBase.dimScores.historicalEffect).toBe(0.5);
    expect(gainBase.passed).toBe(false);

    // seed usr-A 的 used×2 + validated×2（两条不同 session、team-a、NOW-1d）→ 90 天窗内计入。
    const seedAt = NOW - DAY;
    const seed: Array<[AssetEventStage, string]> = [
      ["used", "sess-A-0"], ["used", "sess-A-1"], ["validated", "sess-A-0"], ["validated", "sess-A-1"],
    ];
    seed.forEach(([stage, sess], i) => {
      repo.insert(repo.newEvent({
        stage,
        asset: { assetId: "skl-gain", assetType: "skill", name: "skl-gain" },
        sessionKey: sess,
        teamId: "team-a",
        userId: "usr-A",
        createdAt: seedAt + i, // 微错开，保证 created_at 严格单调
      }));
    });

    // boost：90 天窗计入 usr-A 的 validated → S 加权抬升、翻转入选；对照 N 仍不入选。
    const boost = rerankCandidates({ hits, ctx: ctxB, cfg: mk(90, 0.65, 1), deps });
    const g = boost.find((c) => c.hit.assetId === "skl-gain")!;
    const n = boost.find((c) => c.hit.assetId === "skl-neu")!;
    expect(g.dimScores.credibility).toBeCloseTo(1.0, 5);      // (2·validated+used)/6 = (4+2)/6
    expect(g.dimScores.historicalEffect).toBeCloseTo(0.75, 5); // (2+0.5·2)/4
    expect(g.dimScores.credibility).toBeGreaterThan(0.5);
    expect(g.dimScores.historicalEffect).toBeGreaterThan(0.5);
    expect(g.weightedScore).toBeGreaterThan(gainBase.weightedScore + 1e-6);
    expect(g.passed).toBe(true);   // 中性 ~0.60 < 阈值 0.65；抬升后 ≥0.65 → 翻转入选
    expect(n.passed).toBe(false);  // 对照：无历史的 N 未抬升，仍不入选
  });

  it("负向：同批 validated 若属他 team(team-z) → 不抬升 ctx(team-a)（对照）", () => {
    const repo = getAssetEventRepo()!;
    const deps = { repo, now: (): number => NOW };
    const seedAt = NOW - DAY;
    for (let i = 0; i < 2; i++) {
      repo.insert(repo.newEvent({
        stage: "validated",
        asset: { assetId: "skl-x", assetType: "skill", name: "skl-x" },
        sessionKey: `sess-z-${i}`,
        teamId: "team-z",
        userId: "usr-A",
        createdAt: seedAt + i,
      }));
    }
    const hitX = hit({ skill_id: "skl-x", name: "skl-x", owner_agent_id: "agt-a", team_id: "team-a", score: 0.5 });
    const out = rerankCandidates({
      hits: [hitX], ctx: CTX,
      cfg: { ...CFG, selectedThreshold: 0.65, topN: 1, effect: { sameTeamOnly: true, windowDays: 90 } },
      deps,
    });
    // 他 team 的 validated 被 sameTeamOnly 排除 → credibility 中性 → 不抬升、不入选。
    expect(out[0].dimScores.credibility).toBe(0.5);
    expect(out[0].passed).toBe(false);
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

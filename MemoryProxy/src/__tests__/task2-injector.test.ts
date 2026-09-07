/**
 * 任务二 入选资产注入器 —— 单测。
 *
 * 用 fake CoreSkillClient + fake 白名单 resolver + 临时 DB repo 驱动
 * `Task2SelectedAssetsInjector.prewarm`：
 *   - 产出 <task2_selected_assets> 块 + kept 资产打标（metadata.assets）
 *   - selected(decision="rerank") 事件落库（dims 六维齐 / weightedScore / rank）
 *   - 预算裁剪：trimmed 落 selected 但不打标 injected
 *   - caps.skill=false / core 抛错 / 弱检索词 → []（never-throw）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Task2SelectedAssetsInjector } from "../injection/injectors/task2-selected-assets-injector.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { CoreSkillClient, SearchHit } from "../skill/core-client.js";
import type { VisibleSkillIdsResolver } from "../skill/skill-bridge.js";
import type { RetrievalConfig } from "../types.js";
import type { PrewarmInput, AgentContext, ContextBlock } from "../injection/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task2-injector-test-"));
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

const RETRIEVAL: RetrievalConfig = {
  enabled: true,
  rerank: {
    weights: { relevance: 0.4, credibility: 0.15, freshness: 0.1, envCompat: 0.1, historicalEffect: 0.15, tokenCost: 0.1 },
    selectedThreshold: 0.4,
    topN: 5,
    candidateTopK: 10,
    budgetTokens: 100000,
    freshnessHalfLifeDays: 30,
  },
  router: { rules: { bug_fix: "修复,bug,失败" } },
};

function hit(o: Partial<SearchHit>): SearchHit {
  const id = o.skill_id ?? "skl-x";
  return {
    skill_id: id,
    name: o.name ?? id,
    description: o.description ?? "",
    version: 1,
    score: o.score ?? 0,
    ...o,
  };
}

function makeInput(overrides: Partial<PrewarmInput> = {}): PrewarmInput {
  return {
    keyId: "sess-1",
    userId: "usr-1",
    agentSource: "codebuddy",
    sessionInfo: {
      session_id: "sess-1",
      team_id: "team-a",
      agent_id: "agt-a",
      user_id: "usr-1",
      user_key: "uk-1",
      space_id: "sp-1",
      task_id: "task-1",
    },
    agentDetail: { id: "agt-a", name: "agn", description: "agent desc", prompt: "prompt" },
    taskDetail: { id: "task-1", name: "修复 NTFS ACL 校验失败 bug", description: "修复校验", goal: "修复" },
    ...overrides,
  } as unknown as PrewarmInput;
}

const HITS: SearchHit[] = [
  hit({ skill_id: "skl-1", owner_agent_id: "agt-a", team_id: "team-a", name: "云主机迁移一键迁移 SOP", description: "迁移方案指南与步骤", score: 0.8 }),
  hit({ skill_id: "skl-2", owner_agent_id: "agt-b", team_id: "team-a", name: "migration-expert-tips", description: "迁移专家技巧与踩坑", score: 0.6 }),
  hit({ skill_id: "skl-3", owner_agent_id: "agt-c", team_id: "team-z", name: "产品知识整理", description: "产品需求说明", score: 0.4 }),
];

function makeClient(items: SearchHit[] = HITS): CoreSkillClient {
  return {
    searchSkills: async () => ({ items }),
  } as unknown as CoreSkillClient;
}

const resolverAll: VisibleSkillIdsResolver = async () => ({
  ids: HITS.map((h) => h.skill_id),
});

function makeInjector(opts: {
  client?: CoreSkillClient;
  resolver?: VisibleSkillIdsResolver;
  retrieval?: RetrievalConfig;
} = {}): Task2SelectedAssetsInjector {
  return new Task2SelectedAssetsInjector(
    {
      coreSkill: { endpoint: "http://x", serviceToken: "", serviceId: "s", timeoutMs: 1000 },
      retrieval: opts.retrieval ?? RETRIEVAL,
    },
    opts.client ?? makeClient(),
    getAssetEventRepo(),
    opts.resolver ?? resolverAll,
  );
}

describe("Task2SelectedAssetsInjector.prewarm", () => {
  it("产出 <task2_selected_assets> 块，kept 资产打标 metadata.assets；低相关候选被筛除", async () => {
    const inj = makeInjector();
    const blocks = await inj.prewarm(makeInput());

    expect(blocks.length).toBe(1);
    const content = blocks[0].content;
    expect(content).toContain("<task2_selected_assets>");
    expect(content).toContain("✓ 入选");
    // 任务分类路由显示在块头
    expect(content).toContain("任务分类：bug_fix");
    // 预算充足 → 过阈值的 2 条打进 metadata.assets；skl-3（低相关+产品知识桶）被筛除
    const assets = blocks[0].metadata?.assets as Array<{ assetId: string }>;
    expect(assets.map((a) => a.assetId)).toEqual(["skl-1", "skl-2"]);
    expect(content).not.toContain("skl-3");
  });

  it("落 selected(decision=rerank) 事件：dims 六维齐 + weightedScore + rank + 来源标注", async () => {
    const inj = makeInjector();
    await inj.prewarm(makeInput());

    const selected = getAssetEventRepo()!.bySessionKey("sess-1", "selected");
    expect(selected.length).toBe(2); // 只有过阈值的入选；skl-3 停留在 recalled 侧
    const first = selected.find((e) => e.asset.assetId === "skl-1")!;
    expect(first.evidence?.decision).toBe("rerank");
    expect(first.evidence?.rerank).toBeDefined();
    expect(first.evidence!.rerank!.dims).toMatchObject({
      relevance: expect.any(Number),
      credibility: expect.any(Number),
      freshness: expect.any(Number),
      envCompat: expect.any(Number),
      historicalEffect: expect.any(Number),
      tokenCost: expect.any(Number),
    });
    expect(first.evidence!.rerank!.weightedScore).toBeTypeOf("number");
    expect(first.evidence!.rerank!.rank).toBeGreaterThanOrEqual(1);
    // 跨 agent 来源标注（skl-2 owner=agt-b ≠ 会话 agent agt-a）
    const skl2 = selected.find((e) => e.asset.assetId === "skl-2")!;
    expect(skl2.asset.source).toBe("agt-b");
    expect(skl2.evidence!.rerank!.trimmedByBudget).toBe(false);
  });

  it("跨用户历史信号：他 user(usr-9) 对他人(agt-b) 团队共享 skill 的 validated → 本会话(usr-1) 检索时 effect/credibility 抬升", async () => {
    const repo = getAssetEventRepo()!;
    // skl-2 owner=agt-b、team-visible（白名单 resolverAll 放行）；validated 事件 user=usr-9 ≠ 会话 usr-1。
    // byAssetId 只按 (team, 窗口) 聚合、不过滤 user → usr-9 的 validated 计入 usr-1 的 rerank。
    for (let i = 0; i < 2; i++) {
      repo.insert(repo.newEvent({
        stage: "validated",
        asset: { assetId: "skl-2", assetType: "skill", name: "migration-expert-tips" },
        sessionKey: `sess-u9-${i}`,
        teamId: "team-a",
        userId: "usr-9",
      }));
    }
    const inj = makeInjector();
    await inj.prewarm(makeInput());

    const skl2 = getAssetEventRepo()!.bySessionKey("sess-1", "selected").find((e) => e.asset.assetId === "skl-2")!;
    expect(skl2).toBeDefined();
    expect(skl2.evidence?.decision).toBe("rerank");
    expect(skl2.asset.source).toBe("agt-b");                                    // 跨 agent 来源（≠ self）
    expect(skl2.evidence!.rerank!.dims.historicalEffect).toBeGreaterThan(0.5);  // usr-9 的 validated 抬升历史效果
    expect(skl2.evidence!.rerank!.dims.credibility).toBeGreaterThan(0.5);       // validated×2 → cred>0.5
  });

  it("预算过小 → kept 为空、降级骨架块；trimmed 落 selected 不打标 injected", async () => {
    const inj = makeInjector({
      retrieval: { ...RETRIEVAL, rerank: { ...RETRIEVAL.rerank, budgetTokens: 1 } },
    });
    const blocks = await inj.prewarm(makeInput());

    const content = blocks[0].content;
    expect(content).toContain("超出 token 预算"); // 降级骨架提示
    // 无 kept → 不打标 assets
    expect(blocks[0].metadata?.assets).toBeUndefined();

    const selected = getAssetEventRepo()!.bySessionKey("sess-1", "selected");
    expect(selected.length).toBe(2); // 只有过阈值的入选者进 selected
    expect(selected.every((e) => e.evidence?.rerank?.trimmedByBudget === true)).toBe(true);
  });

  it("once-per-session 去重：同 session 二次渲染不再重复落 selected", async () => {
    const inj = makeInjector();
    await inj.prewarm(makeInput());
    await inj.prewarm(makeInput()); // 缓存 miss 自 heal 场景模拟

    const selected = getAssetEventRepo()!.bySessionKey("sess-1", "selected");
    expect(selected.length).toBe(2); // 仍 2 条，不翻倍
  });

  it("检索命中的白名单候选落 recalled，闭合 recalled ⊇ selected ⊇ injected", async () => {
    const inj = makeInjector();
    await inj.prewarm(makeInput());

    const repo = getAssetEventRepo()!;
    const recalled = repo.bySessionKey("sess-1", "recalled");
    const selected = repo.bySessionKey("sess-1", "selected");
    const injected = repo.bySessionKey("sess-1", "injected");

    // 3 个白名单候选全落 recalled（含未入选的 skl-3）。
    expect(recalled.length).toBe(3);
    const recalledIds = new Set(recalled.map((e) => e.asset.assetId));
    // 子集闭包：selected ⊆ recalled，injected ⊆ recalled。
    expect(selected.every((e) => recalledIds.has(e.asset.assetId))).toBe(true);
    expect(injected.every((e) => recalledIds.has(e.asset.assetId))).toBe(true);
    // 跨 agent 来源标注（skl-2 owner=agt-b）。
    const skl2 = recalled.find((e) => e.asset.assetId === "skl-2")!;
    expect(skl2.asset.source).toBe("agt-b");
    expect(skl2.evidence?.decision).toBe("task2-rerank");
    // once-per-session：二次 prewarm 不重复落 recalled。
    await inj.prewarm(makeInput());
    expect(repo.bySessionKey("sess-1", "recalled").length).toBe(3);
  });

  it("assetCapabilities.skill=false → []", async () => {
    const inj = makeInjector();
    const blocks = await inj.prewarm(makeInput({ assetCapabilities: { skill: false, llm_wiki: true, code_graph: true, chat_memory: true } }));
    expect(blocks).toEqual([]);
  });

  it("弱检索词 → []（不造弱注入）", async () => {
    const inj = makeInjector();
    const blocks = await inj.prewarm(makeInput({
      taskDetail: { id: "t", name: "testagent1", description: "testagent1" },
      agentDetail: { id: "agt-a", name: "testagent1", description: "testagent1", prompt: "testagent1" },
    }));
    expect(blocks).toEqual([]);
  });

  it("core 抛错 → []（never-throw）", async () => {
    const throwing = {
      searchSkills: async () => { throw new Error("core down"); },
    } as unknown as CoreSkillClient;
    const inj = makeInjector({ client: throwing });
    const blocks = await inj.prewarm(makeInput());
    expect(blocks).toEqual([]);
  });

  it("白名单 resolver 抛错 → []（fail-closed）", async () => {
    const failing: VisibleSkillIdsResolver = async () => { throw new Error("meta down"); };
    const inj = makeInjector({ resolver: failing });
    const blocks = await inj.prewarm(makeInput());
    expect(blocks).toEqual([]);
  });
});

// ── ⑦ mid-session refresh：shouldRefreshCache ─────────────────────────────────

/** 构造带最后一条用户消息的 AgentContext（skill=true，可调 turn）。 */
function userCtx(lastMsg: string, turn = 1, capsSkill = true): AgentContext {
  return {
    messages: [{ role: "user", blocks: [{ type: "text", content: lastMsg }] }],
    requestParams: {},
    metadata: {
      sessionKey: "sess-1",
      turnSeq: turn,
      custom: { assetCapabilities: { skill: capsSkill } },
    },
  } as unknown as AgentContext;
}

/** 模拟缓存里的 task2 块（metadata 带 source/taskType/refreshTurn）。 */
function cachedTask2Block(taskType: string, refreshTurn = 0): ContextBlock[] {
  return [{
    type: "text",
    content: "<task2_selected_assets>mock</task2_selected_assets>",
    metadata: { source: "task2-selected-assets-injector", taskType, refreshTurn },
  }];
}

describe("Task2SelectedAssetsInjector.shouldRefreshCache", () => {
  it("任务分类漂移（feature→bug_fix）且超过 minTurnsBetween → refresh", async () => {
    const inj = makeInjector();
    // turn=3，block 上次 refresh 于 turn=0 → since=3 ≥ minTurnsBetween(2)。
    const r = await inj.shouldRefreshCache!(
      userCtx("请修复迁移 ACL 校验失败的问题", 3),
      cachedTask2Block("feature"),
    );
    expect(r).toBe(true);
  });

  it("同任务类型 → 不 refresh（未超 refreshEveryTurns）", async () => {
    const inj = makeInjector();
    const r = await inj.shouldRefreshCache!(
      userCtx("请修复 ACL 校验失败的问题", 3),
      cachedTask2Block("bug_fix"),
    );
    expect(r).toBe(false);
  });

  it("漂移但在 minTurnsBetween 内（turn 1）→ 不 refresh（防首轮误刷）", async () => {
    const inj = makeInjector();
    const r = await inj.shouldRefreshCache!(
      userCtx("请修复迁移 ACL 校验失败的问题", 1),
      cachedTask2Block("feature"),
    );
    expect(r).toBe(false);
  });

  it("闲聊 / 弱话题（classify→general）→ 不 refresh，保留现块", async () => {
    const inj = makeInjector();
    const r = await inj.shouldRefreshCache!(
      userCtx("今天天气不错", 5),
      cachedTask2Block("devops"),
    );
    expect(r).toBe(false);
  });

  it("超 refreshEveryTurns 兜底：同类型但到轮数 → refresh", async () => {
    const inj = makeInjector({
      retrieval: { ...RETRIEVAL, refresh: { minTurnsBetween: 1, refreshEveryTurns: 4 } },
    });
    // turn=9，block refresh 于 turn=0 → since=9 ≥ 4。
    const r = await inj.shouldRefreshCache!(
      userCtx("请修复 ACL 校验失败的问题", 9),
      cachedTask2Block("bug_fix"),
    );
    expect(r).toBe(true);
  });

  it("assetCapabilities.skill=false → 不 refresh", async () => {
    const inj = makeInjector();
    const r = await inj.shouldRefreshCache!(
      userCtx("请修复 ACL 校验失败的问题", 3, false),
      cachedTask2Block("feature"),
    );
    expect(r).toBe(false);
  });

  it("无用户消息 / 缓存非本注入器块 → 不 refresh", async () => {
    const inj = makeInjector();
    const noMsg = {
      messages: [],
      requestParams: {},
      metadata: { sessionKey: "sess-1", turnSeq: 3 },
    } as unknown as AgentContext;
    expect(await inj.shouldRefreshCache!(noMsg, cachedTask2Block("feature"))).toBe(false);
    const otherBlock = [{ type: "text", content: "x", metadata: { source: "skill-injector" } }] as ContextBlock[];
    expect(await inj.shouldRefreshCache!(userCtx("请修复 ACL 校验失败的问题", 3), otherBlock)).toBe(false);
  });
});

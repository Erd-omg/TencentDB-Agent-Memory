/**
 * 任务二「面向新任务的检索与最小上下文」入选资产注入器。
 *
 * session_init 预热时：任务分类路由 → 主动检索团队资产（scope=team，过白名单）→
 * 六维重排 → 预算裁剪 → 注入 `<task2_selected_assets>` 最小充分上下文（指针），
 * 并把重排决策落 `selected(decision="rerank")` + `injected` 事件。
 *
 * 核心价值（团队内跨 agent 复用推荐；跨用户已双用户 e2e 验证，见 docs §18）：
 *   - 检索用 `scope:"team"` 拿到跨 agent 候选，且必须过 A∪B 可见性白名单
 *     （A=meta list-accessible(visibility=team)，B=agent 自有全量；A 失败 fail-closed）。
 *   - 历史效果维度按 asset_id 跨会话聚合（byAssetId 只按 team+时间窗、**不过滤 user**：
 *     同团队另一 agent/用户对共享资产的 used/validated 会抬升本会话的排序加权）。
 *     这只影响**排序分**，绝不把他人 validated 展示为本会话已验证
 *     （validated 只写本会话 used 资产；回执仅聚合本会话事件）。
 *   - 每条候选标注来源（self / owner agent id / team），复用可追溯。
 *   - 范围边界：chat-memory/profile 是个人记忆（per-team/agent/user 借调 ctx），
 *     不参与跨用户复用；跨用户复用 = 团队共享 skill 资产 + 上述历史效果信号。
 *
 * 语义与任务三 selected 共存（选项1）：
 *   - 重排入选 = `selected` + evidence.decision="rerank" + evidence.rerank 六维分；
 *   - 定向读取（get-by-name 等）= `selected` + decision="direct-read"（F1 已有，不动）；
 *   - 预算裁剪掉的入选者（passed 但超预算）落 selected（trimmedByBudget=true）但不落
 *     injected —— 保留"为何排除"的证据，保持 recalled ⊇ selected ⊇ injected。
 *
 * 降级（never-throw）：
 *   - 缺身份 / assetCapabilities.skill=false / 弱检索词 → []；
 *   - 白名单 A 失败 → fail-closed 空候选；core 抛错 → []。
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { CoreSkillClient, getCoreSkillClient } from "../../skill/core-client.js";
import { defaultVisibleSkillIdsResolver, type VisibleSkillIdsResolver } from "../../skill/skill-bridge.js";
import type { CoreSkillConfig, RetrievalConfig } from "../../types.js";
import { withBlockAssets } from "../evidence.js";
import { getAssetEventRepo, type AssetEventRepo } from "../../db/assetEventRepo.js";
import type { AssetRef } from "../../db/asset-event.js";
import { buildTask2Query, signalsFromPrewarm } from "../../retrieval/query.js";
import { assetPriorityForTask, classifyTask, type TaskSignals } from "../../retrieval/task-router.js";
import { rerankCandidates } from "../../retrieval/rerank.js";
import { trimByBudget } from "../../retrieval/budget.js";
import type { AssetBucket, RerankedCandidate, RetrievalHit } from "../../retrieval/types.js";
import { skillHitToRetrieval } from "../../retrieval/types.js";
import { collectChatMemoryHits } from "../../retrieval/sources/chat-memory.js";
import { collectWikiHits } from "../../retrieval/sources/wiki.js";

const TAG = "[task2-selected-assets]";

export interface Task2InjectorConfig {
  coreSkill: CoreSkillConfig;
  retrieval: RetrievalConfig;
}

interface RenderArgs {
  teamId: string;
  agentId: string;
  userId: string;
  userKey?: string;
  spaceId?: string;
  taskId?: string;
  /** 原始 x-conversation-id（asset_event.session_key 必须用它，不能用 composite_key）。 */
  sessionKey: string;
  /** 任务展示名（块头部，prewarm 用 taskDetail.name）。 */
  taskLabel: string;
  /** 检索词（prewarm=task/agent 描述；execute=last user msg）。 */
  query: string | undefined;
  /** 任务分类信号。 */
  classifySignals: TaskSignals;
  /** 渲染来源：prewarm / execute。 */
  trigger: "prewarm" | "execute";
  /** 当前人类轮次（execute 有值；prewarm 无 → 块里 refreshTurn=0）。 */
  turnSeq?: number;
}

/**
 * 任务二入选资产注入器。session_init 缓存；prewarm/execute 共用 renderSelectedBlocks。
 */
export class Task2SelectedAssetsInjector implements InjectionHook {
  id = "task2-selected-assets-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.SKILL + 5;
  description =
    "Inject task-relevant team assets (six-dim rerank, budget-trimmed) at system suffix";
  cacheStrategy: CacheStrategy = "session_init";

  /** `${sessionKey}:${assetId}` 去重 —— 同一会话的 selected(rerank) 只落一次。 */
  private emittedSelected = new Set<string>();

  /** `${sessionKey}:${assetId}` 去重 —— 同一会话的 recalled(检索命中) 只落一次。 */
  private emittedRecalled = new Set<string>();

  constructor(
    private config: Task2InjectorConfig,
    private clientOverride?: CoreSkillClient,
    private repoOverride?: AssetEventRepo | null,
    private resolverOverride?: VisibleSkillIdsResolver,
  ) {}

  /** session_init 预热：用 task/agent 描述作检索词，走完整链路。 */
  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    const si = input.sessionInfo;
    if (!si?.team_id || !si?.agent_id) return [];
    if (input.assetCapabilities?.skill === false) return [];

    const signals = signalsFromPrewarm(input);
    const query = buildTask2Query(signals);
    return this.renderSelectedBlocks({
      teamId: si.team_id,
      agentId: si.agent_id,
      userId: si.user_id,
      userKey: input.callerUserKey ?? si.user_key,
      spaceId: si.space_id,
      taskId: si.task_id,
      sessionKey: si.session_id,
      taskLabel: input.taskDetail?.name ?? input.agentDetail?.name ?? "",
      query,
      classifySignals: {
        name: input.taskDetail?.name,
        description: input.taskDetail?.description,
        goal: input.taskDetail?.goal,
      },
      trigger: "prewarm",
    });
  }

  /** 自 heal（缓存 miss）：用最后一条用户消息作检索词。 */
  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const caps = custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];

    const identity = getTdaiIdentity(custom);
    if (!identity) return [];
    const session = custom?.session as { space_id?: string } | undefined;
    const sessionKey = typeof ctx.metadata.sessionKey === "string" && ctx.metadata.sessionKey
      ? ctx.metadata.sessionKey
      : identity.sessionId;

    const lastUser = getLastUserMessage(ctx);
    const query = lastUser
      ? extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048)
      : "";
    if (!query) return [];

    return this.renderSelectedBlocks({
      teamId: identity.teamId,
      agentId: identity.agentId,
      userId: identity.userId,
      userKey: identity.userKey,
      spaceId: session?.space_id,
      taskId: identity.taskId,
      sessionKey,
      taskLabel: "",
      query,
      classifySignals: { query },
      trigger: "execute",
      turnSeq: typeof ctx.metadata.turnSeq === "number" ? ctx.metadata.turnSeq : undefined,
    });
  }

  /**
   * ⑦ mid-session refresh —— session_init 缓存命中时由 pipeline 咨询：
   * 是否该按最新用户消息重跑 execute()（话题漂移或超过轮数）。
   *
   * 信号（纯规则，无 IO）：
   *   - 最新用户消息 classifyTask 为 general（闲聊/弱话题）→ 保留现块，不刷。
   *   - 任务分类相对块 metadata.taskType 变化 → 真话题切换 → refresh。
   *   - 距上次 refresh 超 refreshEveryTurns 轮 → 兜底 refresh（捕获同类型漂移）。
   *   - minTurnsBetween 防首轮误刷（让 prewarm 任务块先发言）。
   * never-throw：任何异常降级为不 refresh。
   */
  async shouldRefreshCache(ctx: AgentContext, cached: ContextBlock[]): Promise<boolean> {
    try {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const caps = custom?.assetCapabilities as { skill?: boolean } | undefined;
      if (caps?.skill === false) return false;
      // FORK / sidequery（readOnly）不刷新：只复用主会话缓存命中，避免每次侧查询重跑检索。
      if (ctx.metadata.readOnly === true) return false;

      const lastUser = getLastUserMessage(ctx);
      if (!lastUser) return false;
      const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
      if (!query) return false;

      const cfg = this.config.retrieval;
      const taskType = classifyTask({ query }, cfg.router.rules);
      // 闲聊 / 弱话题（无路由关键词命中）→ 不动已生效的任务推荐块。
      if (taskType === "general") return false;

      const ourBlock = cached.find((b) => b.metadata?.source === this.id);
      const oldType = ourBlock?.metadata?.taskType as string | undefined;
      if (!ourBlock || !oldType) return false;

      const refresh = cfg.refresh ?? { minTurnsBetween: 2, refreshEveryTurns: 8 };
      const turn = typeof ctx.metadata.turnSeq === "number" ? ctx.metadata.turnSeq : 0;
      const lastRefreshTurn =
        typeof ourBlock.metadata?.refreshTurn === "number" ? ourBlock.metadata.refreshTurn : 0;
      const since = turn - lastRefreshTurn;
      if (since < refresh.minTurnsBetween) return false;

      const drift = taskType !== oldType;
      const overdue = since >= refresh.refreshEveryTurns;
      if (drift || overdue) {
        console.log(
          `${TAG} shouldRefreshCache ${drift ? `drift ${oldType}→${taskType}` : `overdue turn=${turn} (${since}≥${refresh.refreshEveryTurns})`}`
          + ` query="${query.slice(0, 60)}"`,
        );
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`${TAG} shouldRefreshCache degraded to no-refresh: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 共享链路：分类 → 检索 → 白名单过滤 → 六维重排 → 预算裁剪 → 落事件 → 渲染块。
   * never-throw：任何异常降级为 []（对齐 skill-injector 的降级契约）。
   */
  private async renderSelectedBlocks(args: RenderArgs): Promise<ContextBlock[]> {
    try {
      const { teamId, agentId, userId, userKey, spaceId, taskId, sessionKey, query, classifySignals, trigger, turnSeq } = args;
      const cfg = this.config.retrieval;
      if (!teamId || !agentId) return [];

      const taskType = classifyTask(classifySignals, cfg.router.rules);
      const priority = assetPriorityForTask(taskType);
      if (!query) {
        console.log(`${TAG} ${trigger}: weak/no query — empty selected block`);
        return [];
      }

      const repo = this.repoOverride !== undefined ? this.repoOverride : getAssetEventRepo();
      const client = this.clientOverride ?? getCoreSkillClient(this.config.coreSkill);

      // 白名单 A∪B（A 失败 fail-closed → 空候选，绝不让 LLM 看到未过滤结果）。
      let visibleIds: string[];
      try {
        if (!userKey) {
          console.error(`${TAG} ${trigger}: no user_key — fail-closed empty (session-init should store it)`);
          return [];
        }
        const resolver = this.resolverOverride
          ?? defaultVisibleSkillIdsResolver({ coreSkill: this.config.coreSkill });
        const resolved = await resolver({
          user_id: userId,
          team_id: teamId,
          user_key: userKey,
          space_id: spaceId,
        });
        visibleIds = resolved.ids;
      } catch (err) {
        console.warn(`${TAG} ${trigger}: whitelist A failed, fail-closed empty: ${(err as Error).message}`);
        return [];
      }
      if (visibleIds.length === 0) return [];
      const visibleSet = new Set(visibleIds);
      // B = agent 自有全量（含 private）并入白名单 → A∪B（对齐 skill-bridge team-search；
      // B 失败不阻断保留 A；A 失败已 fail-closed 返回空）。
      try {
        const own = await client.listSkills({
          team_id: teamId,
          agent_id: agentId,
          pagination: { limit: 1000 },
        });
        for (const s of own.items) visibleSet.add(s.skill_id);
      } catch {
        // B 不可用不阻断
      }

      // 团队 skill 检索（scope=team 剥 agent owner 过滤 → 跨 agent 候选）→ 归一成 RetrievalHit。
      const result = await client.searchSkills(
        {
          query,
          team_id: teamId,
          agent_id: agentId,
          user_id: userId,
          task_id: taskId,
          scope: "team",
          top_k: cfg.rerank.candidateTopK,
          mode: "hybrid",
        },
        { serviceId: spaceId },
      );
      const pool: RetrievalHit[] = result.items
        .filter((h) => visibleSet.has(h.skill_id))
        .map(skillHitToRetrieval);
      if (pool.length === 0) return [];

      // 多源候选池（任务二 #1/#3 第一步）：chat-memory / wiki 源命中并入（assetId 去重）。
      const srcs = cfg.sources ?? {};
      if (srcs.chatMemory?.enabled) {
        const mem = await collectChatMemoryHits({
          core: this.config.coreSkill,
          teamId,
          userId,
          agentId,
          userKey,
          spaceId,
          taskId,
          sessionKey,
          query: query ?? "",
          perAgentLimit: srcs.chatMemory.perAgentLimit,
        });
        for (const m of mem) if (!pool.some((p) => p.assetId === m.assetId)) pool.push(m);
      }
      if (srcs.wiki?.enabled) {
        const wk = await collectWikiHits({
          coreSkill: this.config.coreSkill,
          teamId,
          userId,
          spaceId,
          query: query ?? "",
          perWikiLimit: srcs.wiki.perWikiLimit,
        });
        for (const w of wk) if (!pool.some((p) => p.assetId === w.assetId)) pool.push(w);
      }
      if (pool.length === 0) return [];

      // 候选落 recalled（once-per-session）—— recalled ⊇ selected ⊇ injected 对混合类型成立。
      for (const h of pool) this.emitRecalled(h, args);

      // 六维重排 + 预算裁剪。effect（历史效果 team/时间窗收敛）随 rerank 配置一并传入。
      const ranked = rerankCandidates({
        hits: pool,
        ctx: { teamId, agentId, taskId, userId, sessionKey, query },
        cfg: { ...cfg.rerank, ...(cfg.effect ? { effect: cfg.effect } : {}) },
        taskType,
        deps: { repo },
      });
      const { kept, trimmed } = trimByBudget(ranked, cfg.rerank.budgetTokens);
      const trimmedIds = new Set(trimmed.map((c) => c.asset.assetId));

      // 落 selected(decision="rerank")：kept + trimmed（once-per-session 去重）。
      for (const c of [...kept, ...trimmed]) {
        this.emitSelected(c, {
          ...args,
          trimmedByBudget: trimmedIds.has(c.asset.assetId),
        });
      }

      const block = this.renderBlock(args, taskType, priority, kept, trimmed);
      if (!block) return [];

      // 只对真正注入的 kept 打资产标记（observer 落 injected）。
      const keptAssets: AssetRef[] = kept.map((c) => c.asset);
      const finalBlock = withBlockAssets(block, keptAssets);

      console.log(
        `${TAG} ${trigger} task=${taskType} query=${JSON.stringify(query.slice(0, 60))} `
        + `pool=${pool.length} kept=${kept.length} trimmed=${trimmed.length} budget=${cfg.rerank.budgetTokens}t`,
      );
      return [finalBlock];
    } catch (err) {
      // never-throw：日志 + 降级空块。
      console.warn(`${TAG} ${args.trigger} failed, degraded to empty: ${(err as Error).message}`);
      return [];
    }
  }

  /** 落一条 selected(decision="rerank") 事件（fire-and-forget，once-per-session 去重）。 */
  private emitSelected(
    c: RerankedCandidate,
    args: RenderArgs & { trimmedByBudget: boolean },
  ): void {
    const repo = this.repoOverride !== undefined ? this.repoOverride : getAssetEventRepo();
    if (!repo) return;
    const dedupKey = `${args.sessionKey}:${c.asset.assetId}`;
    if (this.emittedSelected.has(dedupKey)) return;
    this.emittedSelected.add(dedupKey);

    try {
      repo.insert(repo.newEvent({
        stage: "selected",
        asset: c.asset,
        sessionKey: args.sessionKey,
        taskId: args.taskId,
        agentId: args.agentId,
        teamId: args.teamId,
        userId: args.userId,
        evidence: {
          decision: "rerank",
          rerank: {
            weightedScore: c.weightedScore,
            dims: c.dimScores,
            passed: c.passed,
            trimmedByBudget: args.trimmedByBudget,
            rank: c.rank,
            threshold: this.config.retrieval.rerank.selectedThreshold,
          },
        },
      }));
    } catch (err) {
      // 静默降级：DB 不可用时不阻断注入。
      console.warn(`${TAG} selected event insert failed (asset=${c.asset.assetId}): ${(err as Error).message}`);
    }
  }

  /** 落一条 recalled(decision="task2-rerank") 事件（fire-and-forget，once-per-session 去重）。 */
  private emitRecalled(hit: RetrievalHit, args: RenderArgs): void {
    const repo = this.repoOverride !== undefined ? this.repoOverride : getAssetEventRepo();
    if (!repo) return;
    const dedupKey = `${args.sessionKey}:${hit.assetId}`;
    if (this.emittedRecalled.has(dedupKey)) return;
    this.emittedRecalled.add(dedupKey);

    const source = hit.sourceRole === "imported_from"
      ? (hit.ownerAgentId ?? "team")
      : hit.ownerAgentId === args.agentId ? "self" : (hit.ownerAgentId ?? "team");

    try {
      repo.insert(repo.newEvent({
        stage: "recalled",
        asset: {
          assetId: hit.assetId,
          assetType: hit.assetType,
          version: hit.version,
          name: hit.name,
          score: hit.score,
          source,
        },
        sessionKey: args.sessionKey,
        taskId: args.taskId,
        agentId: args.agentId,
        teamId: args.teamId,
        userId: args.userId,
        evidence: { decision: "task2-rerank", source: this.id },
      }));
    } catch (err) {
      console.warn(`${TAG} recalled event insert failed (asset=${hit.assetId}): ${(err as Error).message}`);
    }
  }

  /** 渲染 `<task2_selected_assets>` 块。kept 为空 → 降级摘要/骨架。 */
  private renderBlock(
    args: RenderArgs,
    taskType: string,
    priority: AssetBucket[],
    kept: RerankedCandidate[],
    trimmed: RerankedCandidate[],
  ): ContextBlock | null {
    const lines: string[] = ["<task2_selected_assets>"];
    const head = args.taskLabel
      ? `以下是与当前任务「${args.taskLabel}」最相关的团队资产`
      : `以下是与当前任务最相关的团队资产`;
    lines.push(`${head}（六维重排入选，按适用度排序；需要全文时用 skill_view / skill-bridge 定向读取）：`);
    lines.push(`任务分类：${taskType} → 需要资产类型（按相关度）：${priority.join(" > ")}`);
    const hasNonSkill = [...kept, ...trimmed].some((c) => c.hit.assetType !== "skill");
    if (hasNonSkill) {
      lines.push("（Chat-Memory 片段用 memory atomic/query 按关键词检索其正文；Wiki 页用知识工具读取。指针仅作提示，不注全文。）");
    }

    if (kept.length === 0) {
      // 预算过小 → 降级骨架（demo：最小上下文退化为空应降级，而非硬塞）。
      lines.push("（六维重排有入选候选，但均超出 token 预算未注入正文；可 mem:sync 调大预算。）");
      for (const c of trimmed.slice(0, 5)) {
        lines.push(`- [${c.bucket}] ${c.hit.name}${this.typeTag(c.hit.assetType)} — ${this.whyOf(c)}（加权${c.weightedScore.toFixed(2)} · 预算裁）`);
      }
    } else {
      kept.forEach((c, i) => {
        lines.push(`${i + 1}. [${c.bucket}] ${c.hit.name}${this.typeTag(c.hit.assetType)}`);
        lines.push(`   为什么适用：${this.whyOf(c)}`);
        const d = c.dimScores;
        lines.push(
          `   ✓ 入选 · 相关${d.relevance.toFixed(2)} 可信${d.credibility.toFixed(2)} `
          + `新鲜${d.freshness.toFixed(2)} 环境${d.envCompat.toFixed(2)} `
          + `效果${d.historicalEffect.toFixed(2)} 成本${d.tokenCost.toFixed(2)} `
          + `· 加权${c.weightedScore.toFixed(2)} · 来源：${c.asset.source ?? "team"}`,
        );
      });
      if (trimmed.length > 0) {
        lines.push(`另：${trimmed.length} 项入选但超出 token 预算未注入：${trimmed.map((c) => `${c.hit.name}${this.typeTag(c.hit.assetType)}`).join("、")}。`);
      }
    }
    lines.push("</task2_selected_assets>");

    return {
      type: "text",
      content: lines.join("\n"),
      metadata: {
        source: this.id,
        taskType,
        keptCount: kept.length,
        trimmedCount: trimmed.length,
        budgetTokens: this.config.retrieval.rerank.budgetTokens,
        // ⑦ mid-session refresh 用：本块最后刷新的人类轮次（prewarm=0）。
        refreshTurn: args.turnSeq ?? 0,
      },
    };
  }

  /** 非 skill 候选的名字后缀类型标记（chat-memory/wiki），skill 无后缀保持原样。 */
  private typeTag(assetType: string): string {
    if (assetType === "chat-memory") return " · (Chat-Memory)";
    if (assetType === "wiki") return " · (Wiki)";
    return "";
  }

  /** 单条候选的"为什么适用"：优先 FTS snippet，否则 description 摘要。 */
  private whyOf(c: RerankedCandidate): string {
    const snippet = c.hit.snippet?.trim();
    if (snippet) return snippet.slice(0, 120);
    const desc = c.hit.description?.trim();
    if (desc) return desc.slice(0, 120);
    return `加权${c.weightedScore.toFixed(2)}（${c.bucket}）`;
  }
}

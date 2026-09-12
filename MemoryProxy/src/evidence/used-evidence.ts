/**
 * used 证据打点 —— 任务三。在 bridge **成功响应后**，把"实际返回/打开/修改过的资产"
 * 逐资产落一条 asset_event，evidence.tool_call 记录工具调用事实。
 *
 * 独立于 LLM 自述：只要模型真的调用了 skill/memory bridge 且拿到了资产，就有据可查
 * （与 tool_call_logs 互补：前者是请求侧"调用了工具"，这里是响应侧"命中了哪些资产"）。
 *
 * **语义收紧（P0-1：打开 ≠ 采纳）**：
 *   - `opened`（新增阶段）：定向读取（get / get-by-name / files/read / atomic/query /
 *     scenario/read）只证明"模型把资产内容读进了上下文"，**不证明内容影响了决策**。
 *     因此读操作落 `opened`，不再落 `used`。
 *   - `used`（严格阶段）：仅当模型做出**独立于"打开"的采纳动作**才落 ——
 *     ① 写操作（update/patch/files/write/files/remove，模型主动改了资产），或
 *     ② `opened` 之后模型在最终答复/代码变更中点名该资产（引用锚点，见
 *        `extractCitationAnchors` / finalize 的 opened→used 升级）。
 *   - 这样 `used` 从"读了"收紧为"引用了"，`validated`（前置必须是 used）才有独立支点。
 *
 * 原则：
 *   - 只对 2xx 成功响应打点 —— 被拒/失败不是"使用"。
 *   - 静默降级：DB 不可用（getAssetEventRepo()=null）或无资产时直接返回。
 */

import { getAssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEventEvidence, AssetRef } from "../db/asset-event.js";

/** 一次 used 打点需要的会话 + 工具调用上下文。 */
export interface UsedEventSource {
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  teamId?: string;
  userId?: string;
  bridge: "skill-bridge" | "memory-bridge";
  /** 工具端点（sub path，如 skill/search、atomic/search）。 */
  endpoint: string;
  /** 检索词（search 类才有）。 */
  query?: string;
  httpStatus: number;
  /** 会话级轮次（桥接事件在轮次间发生，由 turn-tracker 补记；可缺省）。 */
  turnSeq?: number;
  /** 决策证据（赛题 F2：为什么用/不用这条资产）。 */
  decision?: string;
  /** 代码/内容变更证据（赛题 F2：实际基于资产做出的改动）。 */
  code_diff?: string;
  /** 结果证据（赛题 F2：改动后的可观测结果）。 */
  outcome?: string;
  /**
   * 引用锚点证据（P0-1）：读操作（opened）后，若模型在答复/变更中点名该资产，
   * 由调用方传入命中的锚点，把 opened 升级为 used。缺省（无引用锚点）→ 只落 opened。
   */
  citation?: { origin: "answer" | "diff"; anchors: string[] };
}

/** opened 事件使用的会话上下文（读操作不声明采纳，故不含 decision/code_diff 强制）。 */
export type OpenedEventSource = Omit<UsedEventSource, "decision" | "code_diff" | "outcome" | "citation">;

/** 逐资产落 used 事件。 */
export function emitUsedEvents(source: UsedEventSource, assets: AssetRef[]): void {
  if (!assets || assets.length === 0) return;
  const repo = getAssetEventRepo();
  if (!repo) return;
  const tool_call: AssetEventEvidence["tool_call"] = {
    bridge: source.bridge,
    endpoint: source.endpoint,
    ...(source.query ? { query: source.query } : {}),
    ...(source.httpStatus ? { httpStatus: source.httpStatus } : {}),
  };
  const evidence: AssetEventEvidence = { tool_call };
  if (source.decision) evidence.decision = source.decision;
  if (source.code_diff) evidence.code_diff = source.code_diff;
  if (source.outcome) evidence.outcome = source.outcome;
  if (source.citation) evidence.citation = source.citation;
  for (const asset of assets) {
    repo.insert(repo.newEvent({
      stage: "used",
      asset,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      taskId: source.taskId,
      agentId: source.agentId,
      teamId: source.teamId,
      userId: source.userId,
      turnSeq: source.turnSeq,
      evidence,
    }));
  }
}

/**
 * 逐资产落 opened 事件 —— P0-1 新增：定向读取只证明"内容进入上下文"，不证明"影响决策"。
 * used 语义收紧后，读操作（get/get-by-name/files/read/atomic/query/scenario/read）落 opened，
 * 由后续「引用锚点升级」或「写操作」才产生 used。避免"打开 ≠ 采纳"的过度归因。
 */
export function emitOpenedEvents(source: OpenedEventSource, assets: AssetRef[]): void {
  if (!assets || assets.length === 0) return;
  const repo = getAssetEventRepo();
  if (!repo) return;
  const tool_call: AssetEventEvidence["tool_call"] = {
    bridge: source.bridge,
    endpoint: source.endpoint,
    ...(source.query ? { query: source.query } : {}),
    ...(source.httpStatus ? { httpStatus: source.httpStatus } : {}),
  };
  for (const asset of assets) {
    repo.insert(repo.newEvent({
      stage: "opened",
      asset,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      taskId: source.taskId,
      agentId: source.agentId,
      teamId: source.teamId,
      userId: source.userId,
      turnSeq: source.turnSeq,
      evidence: { tool_call },
    }));
  }
}

/**
 * 引用锚点提取（纯函数，无 LLM）—— P0-1 核心：把「打开」与「引用」分离。
 *
 * 给定资产名与一段出处文本（模型最终答复，或 finalize 抓取的代码变更 diff），
 * 返回资产名 token 与出处文本的共现 token（引用锚点）。命中即认为模型「点名/采用了」该资产，
 * 是独立于"打开"动作的 used 信号。
 *
 * 边界（诚实）：这是 token 共现启发式，不是因果证明；但相比"打开即 used"，
 * 它要求模型在**自己的产出**中留下资产痕迹，可审计、可复算。锚点阈值默认 ≥1。
 */
export function extractCitationAnchors(
  assetName: string | undefined,
  originText: string,
  minAnchors = 1,
): string[] {
  if (!assetName || !originText) return [];
  const nameTokens = tokenizeCitation(assetName);
  const originTokens = new Set(tokenizeCitation(originText));
  const anchors = nameTokens.filter((t) => originTokens.has(t));
  return anchors.length >= minAnchors ? anchors : [];
}

/**
 * 引用锚点专用 token 化：拉丁词按非字母数字拆，≥3 字符才保留（降低噪声），
 * 中文连续串整体作一个 token。与 finalize 的 tokenizeText 保持同一拆词口径。
 */
function tokenizeCitation(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const latin = lower.match(/[a-z0-9][a-z0-9_./-]*/g) ?? [];
  const cjk = lower.match(/[一-鿿]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const t of latin) {
    for (const sub of t.split(/[^a-z0-9]+/)) {
      if (sub.length >= 3) tokens.add(sub);
    }
  }
  for (const c of cjk) tokens.add(c);
  return [...tokens];
}

/**
 * 逐资产落 recalled（召回）事件 —— 资产被检索命中、进入候选，但尚未决定是否使用。
 *
 * 与 used 的区别（赛题 F1/F2）：search 命中只是"召回候选"，不代表"被使用"。
 * 这里记录的是"模型通过检索工具真正看到了这条资产"，是 used 的**前置**证据，
 * 而不是 used 本身 —— 避免"仅被召回就宣称已采用"的过度归因。
 */
export function emitRecalledEvents(source: UsedEventSource, assets: AssetRef[]): void {
  if (!assets || assets.length === 0) return;
  const repo = getAssetEventRepo();
  if (!repo) return;
  const tool_call: AssetEventEvidence["tool_call"] = {
    bridge: source.bridge,
    endpoint: source.endpoint,
    ...(source.query ? { query: source.query } : {}),
    ...(source.httpStatus ? { httpStatus: source.httpStatus } : {}),
  };
  for (const asset of assets) {
    repo.insert(repo.newEvent({
      stage: "recalled",
      asset,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      taskId: source.taskId,
      agentId: source.agentId,
      teamId: source.teamId,
      userId: source.userId,
      turnSeq: source.turnSeq,
      evidence: { tool_call },
    }));
  }
}

/**
 * 逐资产落 selected（选中）事件 —— 模型通过定向读取（get / get-by-name / read）
 * 从召回候选中明确"选中"了某条资产以展开内容。
 *
 * selected 是 recalled 与 used 之间的桥梁：它证明"这条资产被主动打开读过内容"，
 * 是内容实际进入决策的证据。命中检索（search）不落 selected，只有定向读取才落。
 */
export function emitSelectedEvents(source: UsedEventSource, assets: AssetRef[]): void {
  if (!assets || assets.length === 0) return;
  const repo = getAssetEventRepo();
  if (!repo) return;
  const tool_call: AssetEventEvidence["tool_call"] = {
    bridge: source.bridge,
    endpoint: source.endpoint,
    ...(source.query ? { query: source.query } : {}),
    ...(source.httpStatus ? { httpStatus: source.httpStatus } : {}),
  };
  for (const asset of assets) {
    repo.insert(repo.newEvent({
      stage: "selected",
      asset,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      taskId: source.taskId,
      agentId: source.agentId,
      teamId: source.teamId,
      userId: source.userId,
      turnSeq: source.turnSeq,
      evidence: { tool_call },
    }));
  }
}

/** 从 subpath 中反解 sessionId（composite_key 形如 `${agentSource}:${sessionId}`）。 */
export function sessionIdFromCompositeKey(compositeKey: string): string | undefined {
  const idx = compositeKey.indexOf(":");
  return idx > 0 ? compositeKey.slice(idx + 1) : undefined;
}

/**
 * 从 skill-bridge 成功响应文本解析"本次命中的 skill 资产"。
 * 按 sub 分派响应结构：
 *   - search            → data.items[]（每条 skill_id/version/name/score）
 *   - get/get-by-name/update/patch/files/write/files/remove → data.skill_id(+version/name)
 *   - files/read        → 响应无 skill_id，用 inbound skill_id（+ data.version）
 */
export function skillAssetsFromResponse(
  sub: string,
  respText: string,
  inboundSkillId?: string,
): AssetRef[] {
  let env: {
    code?: number;
    data?: Record<string, unknown> & {
      items?: Array<Record<string, unknown>>;
      skill_id?: string;
      version?: number;
      name?: string;
      score?: number;
    };
  };
  try {
    env = JSON.parse(respText) as typeof env;
  } catch {
    return [];
  }
  if (env.code !== 0 || !env.data) return [];

  if (sub === "search" && Array.isArray(env.data.items)) {
    return env.data.items
      .filter((it) => it && typeof it.skill_id === "string")
      .map((it) => ({
        assetId: it.skill_id as string,
        assetType: "skill" as const,
        version: typeof it.version === "number" ? it.version : undefined,
        name: typeof it.name === "string" ? it.name : undefined,
        score: typeof it.score === "number" ? it.score : undefined,
        source: "team", // search 是 team 级检索
      }));
  }

  if (typeof env.data.skill_id === "string") {
    return [{
      assetId: env.data.skill_id,
      assetType: "skill" as const,
      version: typeof env.data.version === "number" ? env.data.version : undefined,
      name: typeof env.data.name === "string" ? env.data.name : undefined,
    }];
  }

  // files/read 等：响应无 skill_id，用 inbound 补上
  if (inboundSkillId) {
    return [{
      assetId: inboundSkillId,
      assetType: "skill" as const,
      version: typeof env.data.version === "number" ? env.data.version : undefined,
    }];
  }

  return [];
}

/**
 * 从 memory-bridge 收集到的 items 解析记忆资产（atomic/search 的 L1 命中）。
 * collected 里的条目已被 bridge 附加 source_agent_id/name/role。
 */
export function memoryAssetsFromItems(items: Array<Record<string, unknown>>): AssetRef[] {
  return items
    .filter((it) => it && typeof it.id === "string" && typeof it.content === "string")
    .map((it) => ({
      assetId: it.id as string,
      assetType: "chat-memory" as const,
      name: (it.content as string).replace(/\s+/g, " ").trim().slice(0, 60),
      score: typeof it.score === "number" ? it.score : undefined,
      source: typeof it.source_agent_name === "string"
        ? it.source_agent_name
        : undefined,
    }));
}

/**
 * 从 memory-bridge **定向读取**成功响应解析命中的记忆资产（任务四 ② 证据补充）。
 *
 * 语义（对齐 skill 侧 get-by-name）：`atomic/query` 是 L1 定向读取（分页列出
 * 原子记忆正文）、`scenario/read` 是 L2 场景全文读取 —— 两者都"把内容带进决策"，
 * 因此落 selected + used（不是 search 的 recalled 级）。
 *
 * 容错：响应非 JSON / 无 items / content 为 null → 返回 []（不造伪证据）。
 * 响应形态见 MemoryCore/v3-api-memorycore-doc.md：
 *   - atomic/query → data.items[]（每条 id/version/type/content）
 *   - scenario/read → data:{path, content, created_at, updated_at}（content=null 表示不存在）
 */
export function memoryDirectReadAssets(
  sub: string,
  respText: string,
  inboundPath?: string,
): AssetRef[] {
  let env: {
    code?: number;
    data?: Record<string, unknown> & {
      items?: Array<Record<string, unknown>>;
      path?: string;
      content?: unknown;
    };
  };
  try {
    env = JSON.parse(respText) as typeof env;
  } catch {
    return [];
  }
  if (env.code !== 0 || !env.data) return [];

  if (sub === "atomic/query" && Array.isArray(env.data.items)) {
    return env.data.items
      .filter((it) => it && typeof it.id === "string" && typeof it.content === "string")
      .map((it) => ({
        assetId: it.id as string,
        assetType: "chat-memory" as const,
        version: typeof it.version === "number" ? it.version : undefined,
        name: (it.content as string).replace(/\s+/g, " ").trim().slice(0, 60),
        score: typeof it.score === "number" ? it.score : undefined,
      }));
  }

  // scenario/read：content 为空（不存在 / 无正文）→ 不当作使用，返回 []。
  if (sub === "scenario/read") {
    const path = typeof env.data.path === "string" && env.data.path.trim()
      ? env.data.path.trim()
      : inboundPath;
    const hasContent = typeof env.data.content === "string" && env.data.content.trim().length > 0;
    if (path && hasContent) {
      return [{
        assetId: path,
        assetType: "chat-memory" as const,
        name: path,
      }];
    }
  }

  return [];
}

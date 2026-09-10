/**
 * 候选资产生成器（任务六「任务经验回流与候选资产生成」骨架）。
 *
 * 从一次任务结束的执行轨迹 / 代码变更 / 测试结果 / 用户反馈中，用**确定性规则**
 * （零 LLM 依赖）提取可复用经验，生成候选资产草案（status=candidate）。
 *
 * 设计边界（design-156.md §8）：
 *   - 本模块只产出**草案**（纯数据，可单测），不直接落库；落库由命令层
 *     （mem:propose / finalize 回流钩子）经 MetadataClient.createAsset 完成。
 *   - 自动生成内容一律 candidate，不直接成为权威资产（§4.1）。
 *   - 语义桶（六桶）由正文 name/description 关键词经 categorizeSkill 归类（§8.3
 *     沿用任务二六桶），本模块不硬编码桶。
 *
 * 触发方式（design-156.md §8.1，二者都做）：
 *   - 自动：mem:finalize 成功后由回流钩子调用（受 config 开关控制）。
 *   - 手动：mem:propose [task_id] 显式触发（可对指定任务重放）。
 */

import type { AssetEvent } from "../db/asset-event.js";
import { categorizeSkill } from "../retrieval/categorize.js";
import type { AssetBucket } from "../retrieval/types.js";

/** 生成器输入：一次任务的回流素材（来自 finalize outcome + 会话事件）。 */
export interface ProposeInput {
  sessionKey: string;
  sessionInfo: Record<string, unknown>;
  /** 本会话/任务走到 used/validated/contributed 的资产事件（用于提炼经验锚点）。 */
  usedEvents: AssetEvent[];
  /** 本次变更的 diff 摘要（finalize 的 code_diff / diffStat，可选）。 */
  diffSummary?: string;
  /** 真实测试结果（exitCode 等，可选）。 */
  testResult?: { exitCode: number; testCmd?: string };
  /** 用户反馈（mem:correct 记录，可选）。 */
  corrections?: Array<{ assetId: string; note: string }>;
}

/**
 * 候选资产草案（未落库，命令层据此 createAsset）。
 *
 * metadata_json 契约对齐 design-156.md §6.4 / §4.4：
 *   - `source`：结构化来源 { kind, ref }（§4.4 七项契约之「来源」）
 *   - `evidence`：结构化证据 { validated, resultRef, at }（§6.4；证据方法不设
 *     独立枚举，统一由 asset_event.stage 表达）
 *   - `bucket`：六桶语义分类，由 categorizeSkill 归类（§8.3）
 *   - `risk`：low/medium/high（§6.4 缺省推导）
 *
 *   applicability（taskTypes/buckets 枚举）与 version（内容哈希）在 M3 范围外，
 *   留待任务一学习管线落地时补齐（见 design-156.md §15.6）。
 */
export interface CandidateDraft {
  /** 候选资产 id（cand- 前缀，落库时作 asset_id）。 */
  assetId: string;
  /** 资产名（skill 名，sanitize 成 kebab-case）。 */
  name: string;
  /** 描述（一句话说明适用场景）。 */
  description: string;
  /** 正文（经验条目 / 反模式清单，Markdown）。 */
  content: string;
  /** 来源引用（task/session 定位，同时落在 meta source_ref）。 */
  sourceRef: string;
  /** 结构化来源（§4.4 / §6.4 source 契约）。 */
  source: { kind: "task" | "session"; ref: string };
  /** 结构化证据（§6.4 evidence 契约）。 */
  evidence: { validated: boolean; resultRef?: string; at?: string };
  /** 六桶语义分类（categorizeSkill 归类结果）。 */
  bucket: AssetBucket;
  /** 风险等级（§6.4 缺省推导）。 */
  risk: "low" | "medium" | "high";
}

const pick = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** kebab-case 化资产名（skill name 约束）。 */
function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "reusable-experience";
}

/**
 * 风险缺省推导（design-156.md §6.4）：
 *   - 含「失败/回滚/撤销/生产环境/安全」等语境 → high；
 *   - 失败经验类 → high；
 *   - 约定类 → low。
 * 中英文关键词都覆盖。
 */
const HIGH_RISK_KEYWORDS =
  /(失败|回滚|撤销|回退|风险|冲突|残留|不一致|丢失|超时|暴增|卡住|异常退出|损坏|生产环境|安全|fail|rollback|revert|timeout|conflict|inconsistent|corrupt|lost|stuck|overflow|security|production)/i;

/**
 * 从候选正文 + 语义桶推导 risk（§6.4 缺省推导）。
 * 失败经验桶 → high；项目约定桶 → low；其余按正文关键词判 high，否则 low。
 */
function deriveRisk(text: string, bucket: AssetBucket): "low" | "medium" | "high" {
  if (bucket === "失败经验") return "high";
  if (bucket === "项目约定") return "low";
  if (HIGH_RISK_KEYWORDS.test(text)) return "high";
  return "low";
}

/**
 * 核心规则：从一次任务的回流素材提炼候选资产草案。
 *
 * 规则（确定性，零 LLM）：
 *   1. 每个走到 used 且（validated 或 contributed）的资产 → 一条「经验确认」候选
 *      （本次已证明该资产可复用，沉淀为经验条目）。
 *   2. 存在 diffSummary 且 exit 0 → 一条「修复经验」候选（本次修复了什么 + 怎么验证）。
 *   3. 存在 corrections → 一条「纠错经验」候选（用户纠正了哪些资产）。
 *   4. 无任何信号 → 返回空（诚实：无可复用经验不生成空候选）。
 */
export function generateCandidates(input: ProposeInput): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  const taskId = pick(input.sessionInfo.task_id);
  const hasTask = Boolean(taskId);
  const sourceRef = hasTask ? `task:${taskId}` : `session:${input.sessionKey}`;
  const source: CandidateDraft["source"] = hasTask
    ? { kind: "task", ref: taskId! }
    : { kind: "session", ref: input.sessionKey };

  // 规则 1：used 且（validated|contributed）的资产 → 经验确认候选
  const proven = input.usedEvents.filter(
    (e) =>
      (e.stage === "validated" || e.stage === "contributed") &&
      e.asset.name,
  );
  // 按 assetId 去重（同一资产可能同时有 validated + contributed 事件）
  const seen = new Set<string>();
  for (const evt of proven) {
    if (seen.has(evt.asset.assetId)) continue;
    seen.add(evt.asset.assetId);

    const assetName = evt.asset.name!;
    const name = slugify(`reuse-${assetName}`);
    const content = [
      `# 经验确认：${assetName}`,
      "",
      `本任务（${sourceRef}）实际采用并验证了资产「${assetName}」：`,
      `- 走到阶段：${evt.stage === "contributed" ? "contributed（证据链终点，测试通过 + 保守归因通过）" : "validated（真测试通过）"}`,
      `- 来源资产 id：\`${evt.asset.assetId}\``,
      input.diffSummary ? `- 本次变更：${input.diffSummary}` : "",
      "",
      "## 结论",
      "该资产对同类任务可复用，建议保留并提升其历史效果权重。",
    ].filter(Boolean).join("\n");
    const bucket = categorizeSkill({ name, description: `已验证可复用的经验：${assetName}` });
    drafts.push({
      assetId: `cand-reuse-${evt.asset.assetId}`.slice(0, 80),
      name,
      description: `已验证可复用的经验：${assetName}`,
      content,
      sourceRef,
      source,
      evidence: {
        validated: true,
        resultRef: `asset_event:${evt.id}`,
        at: evt.createdAt ? new Date(evt.createdAt).toISOString() : undefined,
      },
      bucket,
      risk: deriveRisk(content, bucket),
    });
  }

  // 规则 2：diffSummary + exit 0 → 修复经验候选
  if (input.diffSummary && input.testResult?.exitCode === 0) {
    const name = slugify(`task-${taskId || "fix"}-experience`);
    const description = `任务 ${taskId ?? "(未知)"} 的成功修复经验`;
    const content = [
      `# 修复经验：${sourceRef}`,
      "",
      "## 本次变更",
      input.diffSummary,
      "",
      "## 验证",
      `测试命令 \`${input.testResult.testCmd ?? "(未记录)"}\` → exit 0`,
      "",
      "## 可复用点",
      "- 本任务的成功修复模式可作为同类任务的参考方案。",
    ].join("\n");
    const bucket = categorizeSkill({ name, description });
    drafts.push({
      assetId: `cand-task-${taskId || "unknown"}`.slice(0, 80),
      name,
      description,
      content,
      sourceRef,
      source,
      evidence: {
        validated: true,
        resultRef: `task:${taskId ?? input.sessionKey}`,
        at: new Date().toISOString(),
      },
      bucket,
      risk: deriveRisk(content, bucket),
    });
  }

  // 规则 3：corrections → 纠错经验候选
  for (const corr of input.corrections ?? []) {
    const name = slugify(`correction-${corr.assetId}`);
    const description = `资产 ${corr.assetId} 的纠错记录`;
    const content = [
      `# 纠错经验：${corr.assetId}`,
      "",
      `用户在本任务纠正了资产 \`${corr.assetId}\`：`,
      `> ${corr.note}`,
      "",
      "## 建议",
      "该资产存在过期/不适用风险，建议审核时降权或修订。",
    ].join("\n");
    const bucket = categorizeSkill({ name, description });
    drafts.push({
      assetId: `cand-corr-${corr.assetId}`.slice(0, 80),
      name,
      description,
      content,
      sourceRef,
      source,
      evidence: {
        validated: false,
        resultRef: `corrected:${corr.assetId}`,
        at: new Date().toISOString(),
      },
      bucket,
      risk: deriveRisk(content, bucket),
    });
  }

  return drafts;
}

/**
 * 回流钩子调用入口（自动触发）：从 finalize outcome + 会话事件提炼候选，
 * 返回草案数组（由调用方决定是否落库）。失败不抛，返回 []。
 */
export function proposeFromSession(input: ProposeInput): CandidateDraft[] {
  try {
    return generateCandidates(input);
  } catch (err) {
    console.warn(`[propose] generateCandidates failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * mem:receipt — 资产使用回执（任务四，从任务三 asset_event 表聚合）。
 *
 * 展示本会话的证据链事实：用了哪些资产、属于哪类过程资产、影响了什么、
 * 为什么适用、有什么风险。分两档：
 *   - 默认（mem:receipt）＝**对外平实语言**：按过程资产类别分组，每卡给
 *     「作用摘要 + 为什么适用 + 平实风险」，去工程口径（token-overlap/双计数/validated_no_use）。
 *   - --full ＝**技术明细**：默认内容 + 阶段路径/决策证据/归因/双计数/链提醒（加粗）。
 *
 * 数据全部来自 asset_event 事件表 —— 不是 LLM 自述，可回溯、可核查。
 *
 * 用法：
 *   mem:receipt                 → 平实回执（Markdown）：类别分组 + 每卡「作用/为什么适用/风险」
 *   mem:receipt --full          → 技术明细：+ 阶段/决策证据/证据细节/双计数/证据链完整性提醒（加粗）
 *   mem:receipt --json          → 输出结构化 JSON（脚本 / CLI 消费）
 *   mem:receipt <assetId>       → 单资产深潜（列出该资产全部证据事件）
 *
 * 聚合逻辑在 evidence/receipt-data.ts（与 /v3/evidence/* HTTP API 共享）。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import { buildReceiptData, buildReceiptJson, distinctStageCounts, type ReceiptAsset, type ReceiptData } from "../../evidence/receipt-data.js";
import { EFFECTIVENESS_META, type AssetEffectiveness } from "../../evidence/effectiveness.js";
import { querySessionSignals, sessionReliability, formatSessionSignals } from "../../evidence/session-signals.js";
import { categorizeSkill } from "../../retrieval/categorize.js";
import type { AssetBucket } from "../../retrieval/types.js";
import type { AssetEvent, AssetEventStage } from "../../db/asset-event.js";

/** 阶段显示顺序（证据链推进方向）。 */
const STAGE_ORDER: AssetEventStage[] = [
  "recalled", "selected", "injected", "used", "validated", "corrected", "contributed",
];

const STAGE_LABEL: Record<AssetEventStage, string> = {
  recalled: "召回", selected: "选中", injected: "注入", used: "使用",
  validated: "已验证", corrected: "已纠正", contributed: "已贡献",
};

const TYPE_LABEL: Record<string, string> = {
  skill: "Skill", "chat-memory": "Chat-Memory", profile: "Profile",
  wiki: "Wiki", "code-graph": "CodeGraph", "product-knowledge": "产品知识",
};

/** 卡片排序优先级（越小越靠前；reference_only 最后折叠）。 */
const EFFECTIVENESS_PRIORITY: Record<AssetEffectiveness, number> = {
  corrected: 0,
  contributed: 1,
  validated: 2,
  reused: 3,
  adopted: 4,
  selected: 5,
  validated_no_use: 6,
  reference_only: 7,
};

/** 过程资产类别（赛题任务四）展示：图标 + 标签。加粗首字便于扫读。 */
const BUCKET_META: Record<AssetBucket, { icon: string; label: string }> = {
  "历史方案": { icon: "📘", label: "历史方案" },
  "失败经验": { icon: "⚠️", label: "失败经验" },
  "项目约定": { icon: "📐", label: "项目约定" },
  "代码知识": { icon: "📚", label: "代码知识" },
  "产品知识": { icon: "💡", label: "产品知识" },
  "Skill": { icon: "🧩", label: "Skill" },
};

/** 类别分组显示顺序。 */
const BUCKET_ORDER: AssetBucket[] = ["历史方案", "失败经验", "项目约定", "代码知识", "产品知识", "Skill"];

type ReceiptMode = "default" | "full" | "json" | "deep-dive";

/**
 * A1 过程资产类别 —— 复用检索层关键词启发式（展示标签，非事实）。
 * skill 走 categorizeSkill({name})；其余按 asset_type 兜底，避免无谓的"Skill"淹没真正类别。
 */
function assetBucketOf(asset: ReceiptAsset): AssetBucket {
  if (asset.asset_type === "product-knowledge") return "产品知识";
  if (asset.asset_type === "wiki") return "产品知识";
  // 其余（skill/chat-memory/profile/code-graph）用关键词启发式；name 足够触发关键词。
  return categorizeSkill({ name: asset.name ?? asset.asset_id });
}

/** A2 作用摘要 —— 这项资产影响了什么（代码改动/测试/检索/仅背景）。按信号强→弱取一条。 */
function impactSummary(asset: ReceiptAsset): string {
  // 写操作带 code_diff（真实变更片段）：影响代码改动。
  const codeDiff = asset.events.find((e) => e.evidence?.code_diff);
  if (codeDiff?.evidence?.code_diff) {
    const firstPath = codeDiff.evidence.code_diff.split("\n").find((l) => l.trim())?.trim() ?? "";
    return `影响代码改动${firstPath ? `（${firstPath.slice(0, 60)}）` : ""}`;
  }
  // 测试/校验：影响风险检查或验证。
  const test = asset.events.find((e) => e.evidence?.test_result);
  if (test?.evidence?.test_result) {
    const tr = test.evidence.test_result;
    return `通过测试验证（${tr.runner} exit=${tr.exitCode}）`;
  }
  // 实际使用：读取/检索了内容。
  const tc = asset.events.find((e) => e.evidence?.tool_call);
  if (tc?.evidence?.tool_call) {
    return `用于检索/读取（${tc.evidence.tool_call.bridge}/${tc.evidence.tool_call.endpoint}）`;
  }
  // 被推荐但未使用。
  if (asset.stages.includes("selected") || asset.stages.includes("injected")) {
    return "作为候选/背景，未实际使用";
  }
  return "仅作背景参考";
}

/** 事件里最新的 rerank 证据（selected decision=rerank）。 */
function rerankFor(asset: ReceiptAsset): { weightedScore: number; dims?: Record<string, number>; rank?: number; threshold?: number } | undefined {
  const evt = [...asset.events]
    .filter((e) => e.stage === "selected" && e.evidence?.decision === "rerank")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return evt?.evidence?.rerank;
}

/** A3 为什么适用 —— 从六维 dim 映射平实短语；无 rerank 回退浅层人话。 */
function whyApplicable(asset: ReceiptAsset): string {
  const r = rerankFor(asset);
  if (r?.weightedScore !== undefined) {
    const d = r.dims ?? {};
    const parts: string[] = [];
    if (d.relevance !== undefined) parts.push(d.relevance >= 0.6 ? "与当前任务高度相关" : "与任务相关性一般");
    if (d.credibility !== undefined && d.credibility >= 0.5) parts.push("历史高可信");
    if (d.freshness !== undefined && d.freshness >= 0.6) parts.push("内容较新");
    if (d.envCompat !== undefined) parts.push(envCompatPhrase(d.envCompat));
    if (d.historicalEffect !== undefined && d.historicalEffect >= 0.5) parts.push("上次被成功复用");
    if (parts.length === 0) parts.push("检索匹配入选");
    const score = r.weightedScore.toFixed(2);
    const base = parts.slice(0, 3).join(" · ");
    return `${base}（综合 ${score}${r.threshold !== undefined ? ` / 阈值 ${r.threshold}` : ""}）`;
  }
  // 无 rerank → 浅层人话：来源 + 版本。
  const src = asset.source && asset.source !== "self" ? `来自 ${asset.source}` : "团队沉淀";
  const ver = asset.version ? `，v${asset.version}` : "";
  return `与当前任务相关${ver}（${src}）`;
}

/** envCompat 维度 → 平实环境适配短语。 */
function envCompatPhrase(v: number): string {
  // 与 rerank.ts envCompatFrom 语义对齐：same-agent 1.0 / same-team 0.7 / cross 0.3 / no-owner 0.5。
  if (v >= 0.95) return "本机/同 Agent 环境适配";
  if (v >= 0.65) return "同团队环境适配";
  if (v >= 0.45) return "跨团队/无归属环境适配一般";
  return "跨团队环境适配较弱";
}

/** A4 平实效果计数 —— 去掉 validated_no_use 等术语，平实词表达。 */
function plainEffectivenessLines(eff: Record<AssetEffectiveness, number>): string[] {
  const buckets: string[] = [];
  if (eff.contributed > 0) buckets.push(`🌟 ${eff.contributed} 项已验证且本次贡献`);
  if (eff.validated > 0) buckets.push(`✅ ${eff.validated} 项已通过验证`);
  if (eff.corrected > 0) buckets.push(`❌ ${eff.corrected} 项需修正`);
  const pending = (eff.adopted ?? 0) + (eff.selected ?? 0);
  if (pending > 0) buckets.push(`⏳ ${pending} 项待验证`);
  if (eff.reused > 0) buckets.push(`🔄 ${eff.reused} 项被复用（间接验证）`);
  if (eff.reference_only > 0) buckets.push(`💤 ${eff.reference_only} 项仅作背景参考`);
  // validated_no_use 不再作为计数术语，转为平实诚实说明（若有）。
  const honestyLines: string[] = [];
  if ((eff.validated_no_use ?? 0) > 0) {
    honestyLines.push(`> ⚠️ 说明：有 ${eff.validated_no_use} 项标记为「已通过验证」，但证据中缺少「实际使用」记录，请核查。`);
  }
  return [buckets.join(" · "), ...honestyLines];
}

/** 风险 messageKey → 本地化词（后端已返回 level+messageKey，文案在此统一映射，消除中英混排）。 */
const RISK_WORD: Record<string, string> = {
  "risk.low_confidence": "置信度",
  "risk.possibly_stale": "时效",
  "risk.multi_source": "多来源",
};
function riskWord(messageKey: string): string {
  return RISK_WORD[messageKey] ?? messageKey;
}

/** A5 平实风险 —— 实数 + 标未检测。 */
function plainRisk(asset: ReceiptAsset): string {
  const parts: string[] = [];
  for (const r of asset.risks) {
    const icon = r.level === "high" ? "🔴" : r.level === "medium" ? "🟠" : "🟡";
    parts.push(`${icon} ${riskWord(r.messageKey)}${r.detail ? `（${r.detail}）` : ""}`);
  }
  // 权限 / 环境：能确认则给，否则诚实标未检测。
  const r = rerankFor(asset);
  if (r?.dims?.envCompat !== undefined) parts.push(`🌐 环境兼容 ${envCompatPhrase(r.dims.envCompat)}`);
  else if (asset.stages.includes("used") || asset.stages.includes("validated")) parts.push("🌐 环境兼容 未检测");
  parts.push("🔒 权限 未检测");
  return parts.join(" · ");
}

/** 卡标题用名：chat-memory 等 name 是全文/长句，按自然断点截断避免标题变长墙。 */
function cardName(asset: ReceiptAsset): string {
  return naturalTrunc(asset.name || asset.asset_id, 26);
}

/** 平实卡标题：名 vX · 站内有效性。 */
function plainCardTitle(asset: ReceiptAsset): string {
  const meta = EFFECTIVENESS_META[asset.effectiveness];
  const ver = asset.version ? ` v${asset.version}` : "";
  return `### ${cardName(asset)}${ver} · ${meta.icon} ${meta.label}`;
}

/** tech（技术明细）卡标题：名 vX · 来源 X · 站内有效性。 */
function techCardTitle(asset: ReceiptAsset): string {
  const meta = EFFECTIVENESS_META[asset.effectiveness];
  const ver = asset.version ? ` v${asset.version}` : "";
  const src = asset.source ? ` · 来源 ${asset.source}` : "";
  return `### ${cardName(asset)}${ver}${src} · ${meta.icon} ${meta.label}`;
}

/** 更新时间：取资产最新事件的日期（last_stage_at 各阶段最大值）。 */
function updatedAtFor(asset: ReceiptAsset): string {
  const latest = Math.max(...asset.events.map((e) => e.createdAt), ...Object.values(asset.last_stage_at ?? {}));
  if (!Number.isFinite(latest) || latest <= 0) return "未记录";
  return new Date(latest).toISOString().slice(0, 10);
}

/** 使用位置：代码区域（code_diff 首路径）优先，否则 tool_call 查询，否则未记录。 */
function usageLocationFor(asset: ReceiptAsset): string {
  const code = asset.events.find((e) => e.evidence?.code_diff)?.evidence?.code_diff;
  if (code) {
    const first = code.split("\n").find((l) => l.trim())?.trim() ?? "";
    return first ? `代码区域 ${first.slice(0, 60)}` : "代码变更";
  }
  const tc = asset.events.find((e) => e.evidence?.tool_call)?.evidence?.tool_call;
  if (tc) {
    const q = tc.query ? `查询 "${tc.query.slice(0, 40)}"` : "定向读取";
    return `工具调用 ${tc.bridge}/${tc.endpoint} · ${q}`;
  }
  return "未记录";
}

/** 自然断点字符：中文标点 + ASCII 标点 + 空格（技术内容用）。 */
const NATURAL_BREAK = "，。；、！？：,.!?;: )\"'";

/** 自然截断：在整个字符预算内找最后一个自然断点（中文/ASCII 标点、空格），避免硬切在词语中间。
 *  找不到断点才回退按 max 硬切。 */
function naturalTrunc(text: string, max = 40): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // 从预算末尾向整段找最后一个自然断点；找不到断点就回退硬切。
  for (let i = max - 1; i >= Math.floor(max * 0.5); i--) {
    if (NATURAL_BREAK.includes(head[i])) return `${head.slice(0, i + 1)}…`;
  }
  return `${head}…`;
}

/** 按自然断点截断 reference_only 名字（修复超长 Chat-Memory 全文行，避免切词）。 */
function truncName(name: string, max = 40): string {
  return naturalTrunc(name, max);
}


/** 解析 mem:receipt 参数。 */
function parseReceiptArgs(args: string): { mode: ReceiptMode; assetId?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let mode: ReceiptMode = "default";
  let assetId: string | undefined;
  for (const t of tokens) {
    if (t === "--json") mode = "json";
    else if (t === "--full") mode = "full";
    else if (!assetId) {
      // 首个裸 token 视为 assetId → 进入深潜模式。
      assetId = t;
      mode = "deep-dive";
    }
  }
  return { mode, assetId };
}

/**
 * C 决策/变更关联（诚实边界）：decision 用工具调用证据表达（"通过 skill-bridge
 * get-by-name 使用"），code_diff/outcome 在 proxy 侧无本地 diff 源，标"不可得"。
 */
function decisionExcerptFor(assetId: string, events: AssetEvent[]): string | undefined {
  const decisionEvt = events
    .filter((e) => e.asset.assetId === assetId && (e.stage === "used" || e.stage === "selected"))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const ev = decisionEvt?.evidence;
  const tc = ev?.tool_call;
  if (!tc) return undefined;
  const q = tc.query ? ` · query="${tc.query.slice(0, 40)}"` : "";
  let s = `工具调用 ${tc.bridge}/${tc.endpoint}${q}`;
  // P1 #6：写操作已带真实变更片段（code_diff/outcome），附到决策证据。
  if (ev?.code_diff) s += ` · diff: ${naturalTrunc(ev.code_diff, 80)}`;
  if (ev?.outcome) s += ` · 结果: ${ev.outcome}`;
  return s;
}

function formatStagePath(stages: AssetEventStage[]): string {
  return STAGE_ORDER
    .filter((s) => stages.includes(s))
    .map((s) => STAGE_LABEL[s])
    .join(" → ");
}

/** 取某资产最新事件（按 created_at）。 */
function latestEventFor(assetId: string, events: AssetEvent[]): AssetEvent | undefined {
  let latest: AssetEvent | undefined;
  for (const e of events) {
    if (e.asset.assetId !== assetId) continue;
    if (!latest || e.createdAt >= latest.createdAt) latest = e;
  }
  return latest;
}

function evidenceExcerpt(e: AssetEvent | undefined): string | undefined {
  const ev = e?.evidence;
  if (ev?.test_result) {
    // validated/corrected：真测试退出码。finalize 事件带 outcome/code_diff → 单独展示；
    // 纯校验器事件（无 outcome）回退展示单行输出摘要（如 PASS/FAIL），避免 TAP 整屏刷卡。
    let s = `[${ev.test_result.runner}] exit=${ev.test_result.exitCode}`;
    if (ev.outcome) {
      s += `\n  结果: ${ev.outcome}`;
    } else if (ev.test_result.output) {
      const flat = ev.test_result.output.split(/\n+/).map((x) => x.trim()).filter(Boolean).join(" · ");
      if (flat) s += ` ${naturalTrunc(flat, 120)}`;
    }
    if (ev.code_diff) {
      const first = ev.code_diff.split("\n").find((l) => l.trim());
      if (first) s += `\n  diff: ${naturalTrunc(first.trim(), 120)}`;
    }
    // 边界硬化：finalize 的归因是启发式（token 共现），让评审在回执看到"为什么归到它"，
    // 而不是只看到 "✅ exit 0"。结构化 correlation 来自 asset-event.evidence.correlation。
    const corr = ev.correlation;
    if (corr?.heuristic) {
      const hits = (corr.hits ?? []).slice(0, 6);
      const more = (corr.hits?.length ?? 0) > 6 ? ",…" : "";
      const nShare = corr.sharedHits?.length ?? 0;
      const nPath = corr.pathHits?.length ?? 0;
      const bucket = nPath || nShare ? `（shared ${nShare}/path ${nPath}）` : "";
      s += `\n  归因:token-overlap[${hits.join(",")}${more}]${bucket}（启发式非因果）`;
    }
    return s;
  }
  if (ev?.tool_call) {
    let s = `${ev.tool_call.bridge}/${ev.tool_call.endpoint}${ev.tool_call.query ? ` · query="${naturalTrunc(ev.tool_call.query, 40)}"` : ""}`;
    // P1 #6：写操作已带 code_diff/outcome（真实变更片段），诚实展示。
    if (ev.code_diff) s += `\n  diff: ${naturalTrunc(ev.code_diff, 120)}`;
    if (ev.outcome) s += `\n  结果: ${ev.outcome}`;
    return s;
  }
  return undefined;
}

/**
 * 单张资产卡（Markdown）。
 * @param mode "plain"=默认（对外平实：作用摘要/为什么适用/平实风险，无阶段/决策证据/证据细节）；
 *             "tech"=--full（技术明细：加阶段路径/决策证据/证据细节多行块）。
 * @param showAllEvents true=深潜：列出该资产全部证据事件表（独立于 mode）。
 */
function assetCardLines(asset: ReceiptAsset, events: AssetEvent[], mode: "plain" | "tech", showAllEvents = false): string[] {
  const lines: string[] = [];
  if (showAllEvents) {
    // 深潜：技术标题 + 阶段 + 全部证据事件表。
    lines.push(techCardTitle(asset));
    lines.push(`- 阶段：${formatStagePath(asset.stages)}`);
    const decision = decisionExcerptFor(asset.asset_id, events);
    if (decision) lines.push(`- 决策证据：${decision}`);
    lines.push(`- 证据事件（${asset.events.length}）：`);
    for (const e of asset.events) {
      const t = new Date(e.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
      lines.push(`  - [${STAGE_LABEL[e.stage] ?? e.stage}] ${t} · ${evidenceExcerpt(e) ?? "（无证据）"}`);
    }
    return lines;
  }

  if (mode === "tech") {
    // --full 技术明细：保留工程锚点（阶段/决策证据/证据细节）+ 更新时间/使用位置（答赛题 5 问）。
    lines.push(techCardTitle(asset));
    lines.push(`- 类型：${TYPE_LABEL[asset.asset_type] ?? asset.asset_type}`);
    lines.push(`- 阶段：${formatStagePath(asset.stages)}`);
    lines.push(`- 更新时间：${updatedAtFor(asset)}`);
    lines.push(`- 有效性：${EFFECTIVENESS_META[asset.effectiveness].icon} ${EFFECTIVENESS_META[asset.effectiveness].label}`);
    if (asset.risks.length > 0) {
      lines.push(`- 风险：${asset.risks.map((r) => `\`[${r.level}] ${riskWord(r.messageKey)}${r.detail ? `（${r.detail}）` : ""}\``).join("；")}`);
    }
    lines.push(`- 使用位置：${usageLocationFor(asset)}`);
    const decision = decisionExcerptFor(asset.asset_id, events);
    if (decision) lines.push(`- 决策证据：${decision}`);
    const excerpt = evidenceExcerpt(latestEventFor(asset.asset_id, events));
    if (excerpt) lines.push(`- 证据细节：${excerpt}`);
    return lines;
  }

  // 默认（对外平实）：答 4 问（类别/作用/为什么适用/风险），无工程口径。
  lines.push(plainCardTitle(asset));
  lines.push(`- 作用：${impactSummary(asset)}`);
  lines.push(`- 为什么适用：${whyApplicable(asset)}`);
  lines.push(`- 风险：${plainRisk(asset)}`);
  return lines;
}

/**
 * 渲染完整 Markdown 回执。
 * @param mode "plain"=默认（对外平实语言）：类别分组 + 每卡「作用/为什么适用/平实风险」，
 *             去工程口径；文末附 --json/--full 入口提示。诚实说明用平实行。
 *             "tech"=--full（技术明细）：保留阶段路径/决策证据/证据细节/双计数/链提醒（加粗）。
 */
export function renderMarkdownReceipt(
  data: ReceiptData,
  mode: "plain" | "tech",
  sigLine?: string,
  relWarning?: string,
): string {
  const lines: string[] = [];
  lines.push("## 📋 资产使用回执（本会话）");
  lines.push("");

  const eff = data.effectiveness;
  if (mode === "plain") {
    lines.push(`本次应用 ${data.assets.length} 项团队资产`);
    lines.push("");
    const [effLine, ...honesty] = plainEffectivenessLines(eff);
    lines.push(effLine);
    for (const h of honesty) lines.push(h);
    lines.push("");
  } else {
    // --full 技术汇总：保留双口径 + 有效性精确术语（供 e2e 锚点 + 评审）。
    const byType = new Map<string, number>();
    for (const a of data.assets) {
      const t = TYPE_LABEL[a.asset_type] ?? a.asset_type;
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    const typeSummary = [...byType.entries()].map(([t, n]) => `${t} ${n}`).join(" · ");
    lines.push(`**应用资产：${data.assets.length} 项**（${typeSummary || "—"}）`);
    lines.push("");
    const distinct = distinctStageCounts(data.assets);
    const stageSummary = STAGE_ORDER
      .filter((s) => distinct[s] > 0)
      .map((s) => `${STAGE_LABEL[s]} ${distinct[s]}`)
      .join(" · ");
    lines.push(`**证据链（按资产去重）：** ${stageSummary || "（暂无）"}`);
    lines.push("");
    const rawSummary = STAGE_ORDER
      .filter((s) => data.stageCounts[s] > 0)
      .map((s) => `${STAGE_LABEL[s]} ${data.stageCounts[s]}`)
      .join(" · ");
    lines.push(`**证据链（事件计数）：** ${rawSummary || "（暂无）"}`);
    lines.push("");
    const effParts = [
      `🌟已验证且本次贡献 ${eff.contributed}`,
      `✅已验证 ${eff.validated}`,
      `🔄复用 ${eff.reused}`,
      `⏳待验证 ${eff.adopted + eff.selected}`,
    ];
    if (eff.validated_no_use > 0) effParts.push(`⚠️已标记验证(缺使用) ${eff.validated_no_use}`);
    effParts.push(`💤参考 ${eff.reference_only}`);
    if (eff.corrected > 0) effParts.push(`❌需修正 ${eff.corrected}`);
    lines.push(`**有效性：** ${effParts.join(" · ")}`);
    lines.push("");
    if (sigLine) lines.push(sigLine);
    lines.push("");
  }

  // 分组：默认按「过程资产类别」，--full 按「资源类型（TYPE_LABEL，供 e2e 锚点 ## Skill（N））」。
  const groups = new Map<string, ReceiptAsset[]>();
  const groupKey = (a: ReceiptAsset) => (mode === "plain" ? BUCKET_META[assetBucketOf(a)].label : TYPE_LABEL[a.asset_type] ?? a.asset_type);
  for (const a of data.assets) {
    const k = groupKey(a);
    const arr = groups.get(k) ?? [];
    arr.push(a);
    groups.set(k, arr);
  }
  // 分组显示顺序。
  const orderOf = (k: string) => (mode === "plain" ? BUCKET_ORDER.indexOf(k as AssetBucket) : Object.keys(TYPE_LABEL).indexOf(k));
  for (const key of [...groups.keys()].sort((a, b) => orderOf(a) - orderOf(b))) {
    const assets = groups.get(key)!;
    const sorted = [...assets].sort(
      (a, b) => (EFFECTIVENESS_PRIORITY[a.effectiveness] ?? 99) - (EFFECTIVENESS_PRIORITY[b.effectiveness] ?? 99),
    );
    if (mode === "plain") {
      // 默认：只铺非 reference_only 卡；reference_only 折叠（按字符截断名字，修复超长行）。
      const shown = sorted.filter((a) => a.effectiveness !== "reference_only");
      const refs = sorted.filter((a) => a.effectiveness === "reference_only");
      const icon = BUCKET_META[assetBucketOf(sorted[0])]?.icon ?? "🧩";
      // 类别标题用 H2（大于资产卡 ### → 更好层次）。
      lines.push(`## ${icon} ${key}（${sorted.length} 项）`);
      for (const a of shown) lines.push(...assetCardLines(a, data.events, "plain"));
      if (refs.length > 0) {
        const names = refs.map((a) => truncName(a.name || a.asset_id));
        const nameList = names.length > 4 ? `${names.slice(0, 4).join("、")}…` : names.join("、");
        lines.push(`> 💤 仅背景参考（${refs.length} 项）：${nameList}`);
      }
      lines.push("");
      continue;
    }
    // --full：全铺开（含 reference_only），按 TYPE_LABEL 分组。
    lines.push(`## ${key}（${sorted.length}）`);
    for (const a of sorted) lines.push(...assetCardLines(a, data.events, "tech"));
    lines.push("");
  }

  // 证据链完整性检查（赛题 F4）—— 仅技术明细展示；问题句加粗。
  if (mode === "tech" && data.chainIssues.length > 0) {
    lines.push("⚠️ **证据链完整性提醒：**");
    for (const issue of data.chainIssues) {
      const icon = issue.level === "error" ? "🔴" : "🟡";
      // 在「——」处切开：前段问题句加粗，后段解释句常规（与 Panel 对齐）。
      const sep = issue.message.indexOf("——");
      const head = sep >= 0 ? issue.message.slice(0, sep) : issue.message;
      const tail = sep >= 0 ? issue.message.slice(sep) : "";
      lines.push(`- ${icon} **${head}**${tail}`);
    }
    lines.push("");
  }

  // 脚注：分行。
  if (mode === "plain") {
    lines.push("> 数据来自 **asset_event 事件表**（非模型自述，可回溯）。");
    lines.push("");
    lines.push("> **结构化 JSON：**`mem:receipt --json`");
    lines.push("");
    lines.push("> **技术明细（阶段/证据/归因）：**`mem:receipt --full`");
  } else {
    lines.push("> 数据来自 **asset_event 事件表**（非模型自述，可回溯）。");
    lines.push("");
    lines.push("> 注：**读操作**的 diff/outcome 信号在 proxy 侧不可得，决策以工具调用为据。");
    lines.push("> **写操作**已记录真实变更片段 code_diff/outcome。");
  }
  return lines.join("\n");
}

export async function executeReceipt(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const { mode, assetId } = parseReceiptArgs(ctx.args);

  const repo = getAssetEventRepo();
  if (!repo) {
    const text = "⚠️ 本地证据库不可用，无法生成回执。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const data = buildReceiptData(ctx.sessionKey);
  if (!data) {
    const text = "ℹ️ 本会话暂无资产证据记录（还没有 recalled/used/validated 事件）。\n"
      + "让模型实际调用 skill_bridge / memory 工具后，或运行 `mem:validate` 后再查。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  // 会话级结果信号（任务四 ①）：CH 可用时展示（降级友好）。
  let sigLine: string | undefined;
  let relWarning: string | undefined;
  try {
    const signals = await querySessionSignals(ctx.sessionKey);
    sigLine = formatSessionSignals(signals) ?? undefined;
    const rel = signals ? sessionReliability(signals) : null;
    if (rel && !rel.ok && rel.warning) relWarning = rel.warning;
  } catch {
    // 会话信号查询失败静默跳过
  }

  let messageText: string;
  if (mode === "json") {
    messageText = JSON.stringify(buildReceiptJson(data), null, 2);
  } else if (mode === "deep-dive") {
    const target = data.assets.find((a) => a.asset_id === assetId);
    if (!target) {
      messageText = `❌ 会话内未找到资产 ${assetId}。\n输入 \`mem:receipt\` 查看本会话资产列表。`;
    } else {
      const lines = [`## 📋 资产回执 · ${cardName(target)}`, ""];
      lines.push(...assetCardLines(target, data.events, "tech", true));
      messageText = lines.join("\n");
    }
  } else {
    messageText = renderMarkdownReceipt(data, mode === "full" ? "tech" : "plain", sigLine, relWarning);
  }

  const response = buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking });
  // 命令返回结构：在 --json 数据层基础上补渲染派生的「平实字段」（不写库）。
  const resultData = buildReceiptJson(data);
  (resultData.assets as Array<Record<string, unknown>>)?.forEach((a, i) => {
    const asset = data.assets[i];
    a.bucket = BUCKET_META[assetBucketOf(asset)].label;
    a.impact_summary = impactSummary(asset);
    a.why_applicable = whyApplicable(asset);
  });
  return {
    success: true,
    messageText,
    data: resultData,
    response,
  };
}

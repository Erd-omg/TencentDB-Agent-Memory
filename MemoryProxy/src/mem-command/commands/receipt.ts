/**
 * mem:receipt — 资产使用回执（任务四，从任务三 asset_event 表聚合）。
 *
 * 展示本会话的证据链事实：用了哪些资产（类型/来源/版本）、各自走到哪个阶段、
 * 效果状态（已验证 / 已采用待验证 / 仅注入）、每项最新证据。
 *
 * 数据全部来自 asset_event 事件表 —— 不是 LLM 自述，可回溯、可核查。
 *
 * 用法：
 *   mem:receipt                 → 完整回执（Markdown）：开头「本次任务相关资产」叙事段
 *                                 （推荐/使用/验证一句话）+ 去重计数 + reference_only 折叠
 *   mem:receipt --full          → 展开全部资产卡（含仅背景参考）+ 事件计数 + 会话信号
 *   mem:receipt --json          → 输出结构化 JSON（脚本 / CLI 消费）
 *   mem:receipt <assetId>       → 单资产深潜（列出该资产全部证据事件）
 *
 * 聚合逻辑在 evidence/receipt-data.ts（与 /v3/evidence/* HTTP API 共享）。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import { buildReceiptData, buildReceiptJson, type ReceiptAsset, type ReceiptData } from "../../evidence/receipt-data.js";
import { EFFECTIVENESS_META, type AssetEffectiveness } from "../../evidence/effectiveness.js";
import { querySessionSignals, sessionReliability, formatSessionSignals } from "../../evidence/session-signals.js";
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
  validated: 1,
  reused: 2,
  adopted: 3,
  selected: 4,
  validated_no_use: 5,
  reference_only: 6,
};

type ReceiptMode = "default" | "full" | "json" | "deep-dive";

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
  if (ev?.code_diff) s += ` · diff: ${ev.code_diff.slice(0, 80)}`;
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
      if (flat) s += ` ${flat.slice(0, 120)}`;
    }
    if (ev.code_diff) {
      const first = ev.code_diff.split("\n").find((l) => l.trim());
      if (first) s += `\n  diff: ${first.trim().slice(0, 120)}`;
    }
    return s;
  }
  if (ev?.tool_call) {
    let s = `${ev.tool_call.bridge}/${ev.tool_call.endpoint}${ev.tool_call.query ? ` · query="${ev.tool_call.query.slice(0, 40)}"` : ""}`;
    // P1 #6：写操作已带 code_diff/outcome（真实变更片段），诚实展示。
    if (ev.code_diff) s += `\n  diff: ${ev.code_diff.slice(0, 120)}`;
    if (ev.outcome) s += `\n  结果: ${ev.outcome}`;
    return s;
  }
  return undefined;
}

/** 按资产去重：各阶段触及的 distinct 资产数（回执默认展示，避免"注入165"这类事件计数观感）。 */
function distinctStageCounts(assets: ReceiptAsset[]): Record<AssetEventStage, number> {
  const out = {} as Record<AssetEventStage, number>;
  for (const a of assets) {
    for (const s of a.stages) out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/** 叙事段用：一张资产的一句话人话。优先 corrected/validated 证据（结果信号最强），再 used；否则给推荐/读取口径。 */
function highlightWhyFor(asset: ReceiptAsset, events: AssetEvent[]): string {
  const mine = events.filter((e) => e.asset.assetId === asset.asset_id);
  const sorted = [...mine].sort((a, b) => b.createdAt - a.createdAt);
  // 结果信号最强：corrected / validated（有 test_result）。
  for (const e of sorted) {
    if (e.stage === "corrected" || e.stage === "validated") {
      const ex = evidenceExcerpt(e);
      if (ex) return ex;
    }
  }
  // 行为信号：used（tool_call）。
  for (const e of sorted) {
    if (e.stage === "used") {
      const ex = evidenceExcerpt(e);
      if (ex) return ex;
    }
  }
  // 任务二六维重排推荐（selected decision="rerank"）：给归一化加权分 + 来源。
  const rerank = sorted
    .find((e) => e.stage === "selected" && e.evidence?.decision === "rerank")
    ?.evidence?.rerank;
  if (rerank) {
    const src = asset.source && asset.source !== "self" ? ` · 来源 ${asset.source}` : "";
    return `六维重排入选 · 加权${rerank.weightedScore.toFixed(2)}${src}`;
  }
  // 定向读取（selected decision="direct-read"）。
  const direct = sorted.find((e) => e.stage === "selected" && e.evidence?.tool_call);
  if (direct?.evidence?.tool_call) {
    const tc = direct.evidence.tool_call;
    return `已定向读取 · ${tc.bridge}/${tc.endpoint}`;
  }
  return "";
}

/** 单张资产卡（Markdown）。showAllEvents=true 时列出该资产全部证据事件（深潜）。 */
function assetCardLines(asset: ReceiptAsset, events: AssetEvent[], showAllEvents = false): string[] {
  const ver = asset.version ? ` v${asset.version}` : "";
  const src = asset.source ? ` · 来源 ${asset.source}` : "";
  const lines: string[] = [];
  lines.push(`### ${asset.name || asset.asset_id}${ver}${src}`);
  lines.push(`- 阶段：${formatStagePath(asset.stages)}`);
  lines.push(`- 有效性：${EFFECTIVENESS_META[asset.effectiveness].icon} ${EFFECTIVENESS_META[asset.effectiveness].label}`);
  if (asset.risks.length > 0) {
    lines.push(`- 风险：${asset.risks.map((r) => `\`[${r.level}] ${r.label}${r.detail ? `（${r.detail}）` : ""}\``).join("；")}`);
  }
  const decision = decisionExcerptFor(asset.asset_id, events);
  if (decision) lines.push(`- 决策证据：${decision}`);
  if (showAllEvents) {
    lines.push(`- 证据事件（${asset.events.length}）：`);
    for (const e of asset.events) {
      const t = new Date(e.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
      lines.push(`  - [${STAGE_LABEL[e.stage] ?? e.stage}] ${t} · ${evidenceExcerpt(e) ?? "（无证据）"}`);
    }
  } else {
    const excerpt = evidenceExcerpt(latestEventFor(asset.asset_id, events));
    if (excerpt) lines.push(`- 最新证据：${excerpt}`);
  }
  return lines;
}

/** 叙事段展示上限（Top N）。 */
const NARRATIVE_TOP = 4;

/**
 * 渲染完整 Markdown 回执。
 * @param full true=--full：展开 reference_only 卡片 + 事件计数 + 会话信号（技术细节）。
 *              false=默认：折叠 reference_only、只显示去重计数、隐藏会话信号。
 */
function renderMarkdownReceipt(
  data: ReceiptData,
  full: boolean,
  sigLine?: string,
  relWarning?: string,
): string {
  const lines: string[] = [];
  lines.push("## 📋 资产使用回执（本会话）");
  lines.push("");

  // 叙事段：按有效性优先级取 Top N，一句人话（推荐/使用/验证），
  // 让用户第一眼看到"这次任务系统推荐了什么、哪些真的用上了"，而非数字墙。
  const highlighted = [...data.assets]
    .filter((a) => a.effectiveness !== "reference_only")
    .sort((a, b) => (EFFECTIVENESS_PRIORITY[a.effectiveness] ?? 99) - (EFFECTIVENESS_PRIORITY[b.effectiveness] ?? 99));
  if (highlighted.length > 0) {
    lines.push("**本次任务相关资产（按重要性）：**");
    for (const a of highlighted.slice(0, NARRATIVE_TOP)) {
      const meta = EFFECTIVENESS_META[a.effectiveness];
      const type = TYPE_LABEL[a.asset_type] ?? a.asset_type;
      const why = highlightWhyFor(a, data.events);
      lines.push(`- ${meta.icon} [${type}] ${a.name || a.asset_id} — ${meta.label}${why ? ` · ${why}` : ""}`);
    }
    if (highlighted.length > NARRATIVE_TOP) {
      lines.push(`- … 另有 ${highlighted.length - NARRATIVE_TOP} 项，完整明细见下方分组`);
    }
    lines.push("");
  }

  // 汇总行
  const byType = new Map<string, number>();
  for (const a of data.assets) {
    const t = TYPE_LABEL[a.asset_type] ?? a.asset_type;
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const typeSummary = [...byType.entries()].map(([t, n]) => `${t} ${n}`).join(" · ");
  lines.push(`**应用资产：${data.assets.length} 项**（${typeSummary || "—"}）`);
  // 默认按资产去重（injected 每轮缓存命中重打 → 事件计数虚高，见 evidence-observer）。
  const distinct = distinctStageCounts(data.assets);
  const stageSummary = STAGE_ORDER
    .filter((s) => distinct[s] > 0)
    .map((s) => `${STAGE_LABEL[s]} ${distinct[s]}`)
    .join(" · ");
  lines.push(`**证据链（按资产去重）：** ${stageSummary || "（暂无）"}`);
  if (full) {
    const rawSummary = STAGE_ORDER
      .filter((s) => data.stageCounts[s] > 0)
      .map((s) => `${STAGE_LABEL[s]} ${data.stageCounts[s]}`)
      .join(" · ");
    lines.push(`**证据链（事件计数）：** ${rawSummary || "（暂无）"}`);
  }
  const eff = data.effectiveness;
  const effParts = [
    `✅已验证 ${eff.validated}`,
    `🔄复用 ${eff.reused}`,
    `⏳待验证 ${eff.adopted + eff.selected}`,
  ];
  if (eff.validated_no_use > 0) effParts.push(`⚠️已标记验证(缺使用) ${eff.validated_no_use}`);
  effParts.push(`💤参考 ${eff.reference_only}`);
  if (eff.corrected > 0) effParts.push(`❌需修正 ${eff.corrected}`);
  lines.push(`**有效性：** ${effParts.join(" · ")}`);
  // 会话信号（CH）是技术细节：默认隐藏，--full 展示。
  if (full && sigLine) lines.push(sigLine);
  if (relWarning) lines.push(`⚠️ ${relWarning}`);
  lines.push("");

  // 按类型分组 + 组内按有效性优先级排序；reference_only 默认折叠。
  const groups = new Map<string, ReceiptAsset[]>();
  for (const a of data.assets) {
    const t = TYPE_LABEL[a.asset_type] ?? a.asset_type;
    const arr = groups.get(t) ?? [];
    arr.push(a);
    groups.set(t, arr);
  }
  for (const [type, assets] of groups) {
    const sorted = [...assets].sort(
      (a, b) => (EFFECTIVENESS_PRIORITY[a.effectiveness] ?? 99) - (EFFECTIVENESS_PRIORITY[b.effectiveness] ?? 99),
    );
    const shown = sorted.filter((a) => full || a.effectiveness !== "reference_only");
    const refCount = sorted.length - shown.length;
    lines.push(`## ${type}（${sorted.length}）`);
    for (const a of shown) lines.push(...assetCardLines(a, data.events));
    if (refCount > 0) {
      lines.push(`> 💤 仅背景参考（${refCount} 项）· \`mem:receipt --full\` 展开`);
    }
    lines.push("");
  }

  // 证据链完整性检查（赛题 F4）：防止"仅召回/注入就宣称已验证"的过度归因。
  if (data.chainIssues.length > 0) {
    lines.push("⚠️ **证据链完整性提醒：**");
    for (const issue of data.chainIssues) {
      const icon = issue.level === "error" ? "🔴" : "🟡";
      lines.push(`- ${icon} [${issue.level}] ${issue.message}`);
    }
    lines.push("");
  }

  lines.push("> （数据来自 asset_event 事件表，非模型自述，可回溯）");
  lines.push("> （注：读操作（get/get-by-name）的 diff/outcome 信号在 proxy 侧不可得，决策以工具调用为据；写操作（update/patch/files/write）已记录真实变更片段 code_diff/outcome）");
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
      const lines = [`## 📋 资产回执 · ${target.name || target.asset_id}`, ""];
      lines.push(...assetCardLines(target, data.events, true));
      messageText = lines.join("\n");
    }
  } else {
    messageText = renderMarkdownReceipt(data, mode === "full", sigLine, relWarning);
  }

  const response = buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking });
  return {
    success: true,
    messageText,
    data: buildReceiptJson(data),
    response,
  };
}

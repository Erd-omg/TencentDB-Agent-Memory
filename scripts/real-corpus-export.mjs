#!/usr/bin/env node
/**
 * real-corpus-export.mjs —— 真实开发 Session 导出器（P0-2 外推验证素材）。
 *
 * 目的：赛方无法提供真实历史语料，本项目用**本地真实 Claude Code 开发 Session**
 * （`~/.claude/projects/*\/*.jsonl`）作为「非自造语料」外推验证的素材。这些 session
 * 是开发过程中自然产生的（非为评测撰写），与 demo-corpus 的自造语料有本质区别。
 *
 * ⚠️ 脱敏降级（Q2=a，用户决策）：**只取元数据 + 消息摘要，不落原始代码内容**。
 *   - 绝对路径 `/Users/<owner>/...` → `/workspace/<proj>/...`
 *   - 超长 tool_result / 文本（> MAX_CHARS）→ 保留首尾摘要 + 省略标记
 *   - 疑似密钥 / token / 邮箱 → 占位符替换
 *   - 只导出「消息角色 + 摘要文本 + 工具名 + 文件路径」，不导出完整代码体
 *
 * ⚠️ ground truth 缺失（Q3=c）：真实 session **没有预埋 expected_assets**，因此
 * 导出 manifest 中的 `ground_truth` 为 null，并显式标注「用跨 session 检索命中率近似召回」。
 *
 * 输出：`demo-corpus/real-corpus/sessions/*.jsonl` + `demo-corpus/real-corpus/manifest.json`
 *
 * 用法：
 *   node scripts/real-corpus-export.mjs                 # 默认扫描 ~/.claude/projects，取 top-N
 *   node scripts/real-corpus-export.mjs --top 8         # 取最大的 8 个主会话
 *   node scripts/real-corpus-export.mjs --src <dir>     # 指定真实 session 根目录
 *   node scripts/real-corpus-export.mjs --out <dir>     # 指定输出目录
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── 参数 ──
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SRC_ROOT = argVal("--src", join(homedir(), ".claude", "projects"));
const OUT_ROOT = argVal("--out", join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "real-corpus"));
const TOP_N = Number(argVal("--top", "8"));
const PER_PROJECT = Number(argVal("--per-project", "0")); // >0 时每个项目各取 N 个（保证多项目分组）
const MAX_CHARS = Number(argVal("--max-chars", "1200")); // 单条消息摘要上限

// ── 脱敏规则（Q2=a：不落原始代码内容）──

/** 绝对路径 → 占位符路径。保留项目名，抹掉 owner 与机器信息。 */
function scrubPath(text) {
  return text
    .replace(/\/Users\/[^/\s"']+\//g, "/workspace/")
    .replace(/\/home\/[^/\s"']+\//g, "/workspace/")
    .replace(/\/private\/var\/folders\/[^\s"']+/g, "/tmp/")
    .replace(/C:\\Users\\[^\\\s"']+\\/g, "C:\\\\workspace\\\\");
}

/** 疑似密钥 / token / 邮箱 → 占位符。规则保守（只替换强特征），避免误伤代码。 */
function scrubSecrets(text) {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, "$1-***REDACTED***")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_***REDACTED***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer ***REDACTED***")
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, "***@redacted***");
}

/**
 * 摘要化：把长内容（尤其 tool_result 的完整代码体）压成「首部 + 尾部」摘要，
 * 中间省略。保留足够语义供检索/抽取演示，但不落完整代码。
 */
function summarize(text, max = MAX_CHARS) {
  const t = scrubSecrets(scrubPath(String(text ?? "")));
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.7));
  const tail = t.slice(-Math.floor(max * 0.2));
  return `${head}\n... [省略 ${t.length - head.length - tail.length} 字符：原始代码/输出已按 Q2=a 脱敏降级] ...\n${tail}`;
}

/** 从 Claude Code 原生记录中抽取「工具名 + 关键参数（路径）」用于摘要展示。 */
function toolMeta(rec) {
  const blocks = rec?.message?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === "tool_use") {
      const input = b.input ?? {};
      const path = input.file_path ?? input.path ?? input.notebook_path ?? "";
      return { name: b.name ?? "tool", path: typeof path === "string" ? scrubPath(path) : "" };
    }
  }
  return null;
}

/**
 * 把 Claude Code 原生记录映射为 demo-corpus 兼容的导入行。
 *
 * 格式契约（对齐 agents/asset-import.ts 的 parseJsonlLines）：
 *   - 记录 role 只能是 user/assistant（tool_call/tool_result 会被解析器跳过）；
 *   - 工具结构靠 content 数组里的 `{type:'tool_use'}` / `{type:'tool_result'}` 块表达，
 *     由解析器 expandContent 还原为结构化片段（自带 tool_call_id 配对锚点）。
 * Q2=a：tool_result 的正文经 summarize 脱敏降级，不落完整代码。
 */
function mapRecord(rec) {
  const type = rec?.type;
  if (type !== "user" && type !== "assistant") return null;
  const blocks = rec?.message?.content;
  const role = type === "assistant" ? "assistant" : "user";

  // 字符串内容（旧格式）
  if (typeof blocks === "string") {
    const text = summarize(blocks);
    return text ? { role, content: [{ type: "text", text }] } : null;
  }
  if (!Array.isArray(blocks)) return null;

  const content = [];
  for (const b of blocks) {
    if (typeof b === "string") { content.push({ type: "text", text: summarize(b) }); continue; }
    if (b?.type === "text" && b.text) {
      content.push({ type: "text", text: summarize(b.text) });
    } else if (b?.type === "tool_use") {
      const m = toolMeta(rec);
      content.push({
        type: "tool_use",
        id: b.id ?? "t",
        name: m?.name ?? b.name ?? "tool",
        input: m?.path ? { path: m.path } : {}, // Q2=a：只保留脱敏路径，不落参数全文
      });
    } else if (b?.type === "tool_result") {
      const c = b.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map((x) => x?.text ?? "").join("\n");
      content.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id ?? "t",
        content: summarize(text),
      });
    }
  }
  if (content.length === 0) return null;
  return { role, content };
}

/** 扫描真实 session：主会话（排除 subagents），返回 {path, lines, mtime, proj}。 */
function scanSessions() {
  const out = [];
  for (const proj of readdirSync(SRC_ROOT)) {
    const pdir = join(SRC_ROOT, proj);
    if (!statSync(pdir).isDirectory()) continue;
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(pdir, f);
      // 排除 subagents 子目录（都在子目录里，readdirSync 不含）
      const lines = readFileSync(full, "utf8").split("\n").filter(Boolean).length;
      if (lines < 50) continue;
      out.push({ full, lines, proj: proj.replace(/^-/, "").replace(/-/g, "/"), id: f.replace(/\.jsonl$/, "") });
    }
  }
  return out.sort((a, b) => b.lines - a.lines);
}

// ── 主流程 ──
function main() {
  const sessions = scanSessions();
  // 选取策略：--per-project N>0 时每项目各取 N 个（保证多项目分组，供跨项目对照）；
  // 否则取全局最大的 TOP_N 个。
  let picked;
  if (PER_PROJECT > 0) {
    const byProj = new Map();
    for (const s of sessions) {
      if (!byProj.has(s.proj)) byProj.set(s.proj, []);
      const arr = byProj.get(s.proj);
      if (arr.length < PER_PROJECT) arr.push(s);
    }
    picked = [...byProj.values()].flat();
  } else {
    picked = sessions.slice(0, TOP_N);
  }
  mkdirSync(join(OUT_ROOT, "sessions"), { recursive: true });

  const manifestSessions = [];
  for (const s of picked) {
    const raw = readFileSync(s.full, "utf8").split("\n").filter(Boolean);
    const outLines = [];
    const shortId = `real-${s.id.slice(0, 8)}`;

    // 头部 session_meta（对齐 demo-corpus 契约）
    outLines.push(JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: shortId,
        cwd: `/workspace/${basename(s.proj)}`,
        ts: "real-session@exported",     // 真实 ts 在原始文件里；导出层不主张精确时间
        agent: "claude-code",
        task_type: "unknown",             // 真实 session 无预置 task_type
        source: "real-session",
        redaction: "Q2=a: metadata+summary only, no raw code",
      },
    }));

    let kept = 0;
    for (const line of raw) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const mapped = mapRecord(rec);
      if (!mapped) continue;
      outLines.push(JSON.stringify(mapped));
      kept++;
    }

    const file = `sessions/${shortId}.jsonl`;
    writeFileSync(join(OUT_ROOT, file), outLines.join("\n") + "\n", "utf8");

    manifestSessions.push({
      id: shortId,
      file,
      title: `真实 session（${basename(s.proj)}，${s.lines} 行原始）`,
      task_type: "unknown",
      agent: "claude-code",
      project: basename(s.proj), // D2 跨 session / 跨项目分组用
      source: "real-session",
      source_path: s.full.replace(/\/Users\/[^/]+/g, "/workspace"), // 路径也脱敏
      buckets: [],
      expected_assets: null, // Q3=c：真实 session 无预埋 ground truth
      mapped_messages: kept,
    });
  }

  const manifest = {
    corpus_id: "real-corpus-2026",
    title: "真实开发 Session 外推验证语料（脱敏降级）",
    description:
      "从本机 Claude Code 真实开发轨迹（~/.claude/projects）导出的非自造语料，用于 P0-2 外推验证。"
      + "按 Q2=a 只保留元数据 + 消息摘要，不落原始代码内容；按 Q3=c 无预埋 ground truth，"
      + "召回用跨 session 检索命中率近似。",
    business_domain: "多个真实项目（详见 sessions[].source_path 的项目名）",
    authorization: "本机 owner 自有开发记录，脱敏后用于本项目管线验证，不外发",
    created_at: "2026-09-12",
    provenance: "real-session (Claude Code native jsonl under ~/.claude/projects)",
    redaction: {
      rule: "Q2=a",
      path_scrub: "/Users/<owner>/** → /workspace/**",
      secret_scrub: "sk-*/ghp_*/AKIA*/Bearer/email → placeholder",
      content: `消息正文与 tool_result 超长内容截断为 ${MAX_CHARS} 字符摘要`,
    },
    ground_truth: null, // Q3=c
    ground_truth_note:
      "真实 session 无人工标注的 expected_assets。本语料不用于计算召回率，"
      + "仅用于验证「整条链在真实数据上可跑通、资产可抽取、且检索命中不经由作者预设短语」。"
      + "跨 session 检索命中率（real-corpus-e2e.mjs）作为「近似召回」口径，详见 docs/design-156.md。",
    sessions: manifestSessions,
  };
  writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`导出完成：${picked.length} 个真实 session → ${OUT_ROOT}`);
  for (const m of manifestSessions) {
    console.log(`  ${m.id}  (原始 ${m.source_path?.split("/").slice(-2).join("/")}, 映射 ${m.mapped_messages} 条)`);
  }
  console.log(`\nmanifest: ${join(OUT_ROOT, "manifest.json")}`);
}

main();

#!/usr/bin/env node
/**
 * github-issue-corpus.mjs —— 第三方独立语料抓取器（P0-2 升级：真正独立的第三方语料）。
 *
 * 背景：赛方无法提供真实历史语料；本机真实 session（real-corpus）与本项目同 owner/同机器
 * （Q6 共源局限）。为突破共源，本脚本从**第三方公开仓库**抓取 issue 讨论，构造与本公司
 * 业务域无关的独立语料：
 *   - `pallets/flask`（Python Web 框架，BSD-3）
 *   - `BurntSushi/ripgrep`（Rust CLI，Unlicense）
 *
 * 映射规则：一个 issue 的「正文 + 全部评论」按时间顺序映射为一段对话 session：
 *   - 第 1 条（issue 正文）→ role=user
 *   - 后续评论交替 → user / assistant（按评论者是否为 issue 作者区分）
 *   这样一段讨论 = 「问题提出 → 讨论 → 结论」，符合开发会话语义，可走现有导入/抽取链路。
 *
 * 脱敏：复用与 real-corpus-export 相同的规则（URL 保留，用户邮箱不入库，超长正文摘要化）。
 *
 * 版权：仅抓取**公开仓库的 issue 文本**（非代码），manifest 标注来源 URL + LICENSE；
 *       issue 文本版权归原作者，本语料仅用于本地管线验证，不再分发。
 *
 * 用法：
 *   node scripts/github-issue-corpus.mjs                       # 默认 flask + ripgrep
 *   node scripts/github-issue-corpus.mjs --per-repo 5 --min-comments 5
 *   node scripts/github-issue-corpus.mjs --repos pallets/flask
 *   GITHUB_TOKEN=xxx node scripts/github-issue-corpus.mjs      # 提升 rate limit（可选）
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPOS = argVal("--repos", "pallets/flask,BurntSushi/ripgrep").split(",").map((s) => s.trim());
const PER_REPO = Number(argVal("--per-repo", "4"));
const MIN_COMMENTS = Number(argVal("--min-comments", "5"));
const MODE = argVal("--mode", "issue");    // issue | pr
const OUT_SUBDIR = argVal("--out-subdir", MODE === "pr" ? "pr-review" : "issue");
const MAX_CHARS = Number(argVal("--max-chars", "1200"));
const OUT = argVal("--out", join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "third-party"));
// token 来源：环境变量 GITHUB_TOKEN 优先；否则读 ~/.github-token（chmod 600，不入库）。
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const p = join(homedir(), ".github-token");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  } catch { /* ignore */ }
  return "";
}
const TOKEN = loadToken();

const HDRS = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "tdai-agent-memory-corpus/1.0",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const resp = await fetch(`https://api.github.com${path}`, { headers: HDRS });
  if (!resp.ok) throw new Error(`GitHub ${resp.status} ${path}: ${(await resp.text()).slice(0, 120)}`);
  return resp.json();
}

// ── 脱敏 / 摘要（与 real-corpus-export 同口径）──
function scrub(text) {
  return String(text ?? "")
    .replace(/\/Users\/[^/\s"']+\//g, "/workspace/")
    .replace(/\/home\/[^/\s"']+\//g, "/workspace/")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, "$1-***REDACTED***")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_***REDACTED***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***REDACTED***")
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, "***@redacted***");
}
function summarize(text, max = MAX_CHARS) {
  const t = scrub(text);
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.75));
  const tail = t.slice(-Math.floor(max * 0.15));
  return `${head}\n... [省略 ${t.length - head.length - tail.length} 字符] ...\n${tail}`;
}

/**
 * 抓一个 PR 的「描述 + review comments + issue comments」，映射为迭代式开发会话（2A）。
 * PR review 含「提出修改 → 讨论 → 结论」的迭代结构，比纯 issue 更接近 dev session。
 */
async function buildPrSession(repo, pr) {
  const number = pr.number;
  const detail = await gh(`/repos/${repo}/pulls/${number}`);
  const reviews = await gh(`/repos/${repo}/pulls/${number}/comments?per_page=100`);
  const conv = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100`);
  const author = detail.user?.login ?? "unknown";
  const sid = `${repo.replace("/", "-")}-pr-${number}`;

  const lines = [];
  lines.push(JSON.stringify({
    type: "session_meta",
    payload: {
      session_id: sid,
      cwd: `/workspace/${repo.split("/")[1]}`,
      ts: detail.created_at,
      agent: "github-pr",
      task_type: "third-party-pr-review",
      source: `github:${repo}#${number}`,
    },
  }));
  // PR 描述（含改动意图）→ user
  lines.push(JSON.stringify({ role: "user", content: [{ type: "text", text: summarize(`# PR: ${detail.title}\n\n${detail.body ?? ""}`) }] }));
  // review comments（行内评审意见）：评审者=assistant，作者回应=user
  for (const c of reviews) {
    const role = c.user?.login === author ? "user" : "assistant";
    const where = c.path ? ` [${c.path}:${c.line ?? c.original_line ?? ""}]` : "";
    lines.push(JSON.stringify({ role, content: [{ type: "text", text: summarize(`${where} ${c.body ?? ""}`) }] }));
  }
  // issue 级讨论
  for (const c of conv) {
    const role = c.user?.login === author ? "user" : "assistant";
    lines.push(JSON.stringify({ role, content: [{ type: "text", text: summarize(c.body ?? "") }] }));
  }
  // 元信息作为 tool 语境（改动文件数）
  lines.push(JSON.stringify({ role: "tool_call", content: [{ type: "text", text: `[review ${repo.split("/")[1]} PR #${number}: ${detail.changed_files ?? "?"} files]` }] }));
  lines.push(JSON.stringify({ role: "tool_result", content: [{ type: "text", text: `// PR #${number} ${detail.state} merged=${detail.merged ?? false}` }] }));

  return {
    file: `sessions/${sid}.jsonl`,
    content: lines.join("\n") + "\n",
    manifest: {
      id: sid,
      file: `sessions/${sid}.jsonl`,
      title: `${repo} PR #${number}: ${detail.title.slice(0, 70)}`,
      project: repo,
      task_type: "third-party-pr-review",
      agent: "github-pr",
      source: "third-party",
      source_url: detail.html_url,
      license: repo === "pallets/flask" ? "BSD-3-Clause" : (repo === "BurntSushi/ripgrep" ? "Unlicense" : "see repo"),
      author,
      review_comments: reviews.length,
      conversation_comments: conv.length,
      created_at: detail.created_at,
      expected_assets: null,
    },
  };
}

/** 抓一个 issue 的正文 + 评论，映射为对话行。 */
async function buildSession(repo, issueSummary) {
  const number = issueSummary.number;
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  const comments = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100`);
  const author = issue.user?.login ?? "unknown";

  const lines = [];
  const sid = `${repo.replace("/", "-")}-issue-${number}`;
  lines.push(JSON.stringify({
    type: "session_meta",
    payload: {
      session_id: sid,
      cwd: `/workspace/${repo.split("/")[1]}`,
      ts: issue.created_at,
      agent: "github-issue",
      task_type: "third-party-issue",
      source: `github:${repo}#${number}`,
    },
  }));
  // 正文 → user
  lines.push(JSON.stringify({ role: "user", content: [{ type: "text", text: summarize(`# ${issue.title}\n\n${issue.body ?? ""}`) }] }));
  // 评论按时间顺序交替：作者本人的评论算 user（延续诉求），他人算 assistant（答复）
  let turn = 0;
  for (const c of comments) {
    const role = c.user?.login === author ? "user" : "assistant";
    lines.push(JSON.stringify({ role, content: [{ type: "text", text: summarize(c.body ?? "") }] }));
    turn++;
    // 简单交替提示：连续同角色也允许（真实讨论常如此）
    if (role === "assistant") {
      lines.push(JSON.stringify({ role: "tool_call", content: [{ type: "text", text: `[inspect ${repo.split("/")[1]} issue #${number}]` }] }));
      lines.push(JSON.stringify({ role: "tool_result", content: [{ type: "text", text: `// ${repo} discussion thread #${number}` }] }));
    }
  }
  return {
    file: `sessions/${sid}.jsonl`,
    content: lines.join("\n") + "\n",
    manifest: {
      id: sid,
      file: `sessions/${sid}.jsonl`,
      title: `${repo} issue #${number}: ${issue.title.slice(0, 70)}`,
      project: repo,
      task_type: "third-party-issue",
      agent: "github-issue",
      source: "third-party",
      source_url: issue.html_url,
      license: repo === "pallets/flask" ? "BSD-3-Clause" : (repo === "BurntSushi/ripgrep" ? "Unlicense" : "see repo"),
      author: author,
      comments: comments.length,
      created_at: issue.created_at,
      expected_assets: null,
    },
  };
}

async function main() {
  const base = join(OUT, OUT_SUBDIR);
  mkdirSync(join(base, "sessions"), { recursive: true });
  const sessions = [];
  for (const repo of REPOS) {
    console.log(`\n=== ${repo} (mode=${MODE}) ===`);
    let picked = [];
    if (MODE === "pr") {
      // 取 review 讨论丰富的 PR：先按 updated 拉一批，再逐个查 review comments 数
      const prs = await gh(`/repos/${repo}/pulls?state=all&per_page=40&sort=updated&direction=desc`);
      const withCounts = [];
      for (const pr of prs) {
        try {
          const rc = await gh(`/repos/${repo}/pulls/${pr.number}/comments?per_page=100`);
          if (rc.length >= MIN_COMMENTS) withCounts.push({ pr, count: rc.length });
        } catch { /* 跳过 */ }
        if (withCounts.length >= PER_REPO * 2) break;
      }
      withCounts.sort((a, b) => b.count - a.count);
      picked = withCounts.slice(0, PER_REPO);
      console.log(`  候选 PR（review≥${MIN_COMMENTS}）: ${picked.length}`);
      for (const { pr, count } of picked) {
        try {
          const s = await buildPrSession(repo, pr);
          writeFileSync(join(base, s.file), s.content, "utf8");
          sessions.push(s.manifest);
          console.log(`  ✓ PR#${pr.number} (${count} reviews) ${pr.title.slice(0, 55)}`);
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) { console.error(`  ✗ PR#${pr.number}: ${e?.message ?? e}`); }
      }
    } else {
      const issues = await gh(`/repos/${repo}/issues?state=all&per_page=60&sort=comments&direction=desc`);
      picked = issues.filter((i) => !i.pull_request && i.comments >= MIN_COMMENTS).slice(0, PER_REPO);
      console.log(`  候选 issue（comments≥${MIN_COMMENTS}）: ${picked.length}`);
      for (const iss of picked) {
        try {
          const s = await buildSession(repo, iss);
          writeFileSync(join(base, s.file), s.content, "utf8");
          sessions.push(s.manifest);
          console.log(`  ✓ #${iss.number} (${iss.comments} comments) ${iss.title.slice(0, 55)}`);
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) { console.error(`  ✗ #${iss.number}: ${e?.message ?? e}`); }
      }
    }
  }

  const isPr = MODE === "pr";
  const manifest = {
    corpus_id: isPr ? "third-party-pr-2026" : "third-party-issue-2026",
    title: isPr
      ? "第三方公开仓库 PR review 语料（迭代式开发会话，独立于本公司的非自造语料）"
      : "第三方公开仓库 issue 讨论语料（独立于本公司的非自造语料）",
    description: isPr
      ? "从第三方公开仓库（pallets/flask、BurntSushi/ripgrep）抓取 PR review 讨论，"
        + "含「提出修改→讨论→结论」迭代结构，更接近 dev session（2A）。"
      : "从第三方公开仓库（pallets/flask、BurntSushi/ripgrep）抓取 issue 讨论，"
        + "映射为开发会话。用于验证管线在**真正独立**语料上的可运行性与检索区分度（P0-2 升级）。",
    business_domain: "Python Web 框架 + Rust CLI（与本项目业务域无关）",
    authorization: "仅抓取公开 issue/PR 文本（非代码）；版权归各作者；仅本地验证用，不再分发",
    created_at: "2026-09-12",
    provenance: isPr ? "third-party-github-pr-reviews" : "third-party-github-issues",
    redaction: { rule: "同 real-corpus-export（路径/密钥/邮箱脱敏 + 超长摘要）" },
    ground_truth: null,
    ground_truth_note: "无人工标注；用跨仓库检索区分度近似验证（flask query 应命中 flask 资产，"
      + "不应命中 ripgrep 资产）。",
    sessions,
  };
  writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`\n导出完成：${sessions.length} session → ${base}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

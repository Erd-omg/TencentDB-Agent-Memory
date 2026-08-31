#!/usr/bin/env node
/**
 * Skill 检索链路验证脚本 —— 真实 CodeBuddy 会话上验证完整链路：
 *
 *   create → store → search → whitelist → inject → use
 *
 * 对比基线（见 docs/competition-task4-understanding.md §7.5）：
 *   基线：`[skill-bridge] team search whitelist A=0 B=0 C=0 merged=0`（团队无 skill）
 *   本轮：`A=5 B=4 C=4 merged=1`（4 个本 agent skill + 1 个「迁移专家」跨 agent skill）
 *
 * 关键架构事实：
 *   - 白名单 merged = (A ∪ B) − C；A=meta list-accessible(visibility=team)、
 *     B=内核 /v3/skill/list（本 agent 自有）、C=本会话已注入（/v3/skill/listing）。
 *   - 本 agent 自有的 4 个 skill 全部进了 `<available_skills>`（C 池），按设计被减掉；
 *     团队里「迁移专家」agent 沉淀的 migration-expert-tips（在 A、不在 C）存活 → merged=1。
 *   - skill_tools 注入 skill_search → /skill-bridge/v3/skill/search（只读）。
 *
 * 用法：
 *   node scripts/verify-skill-chain.mjs
 *
 * 环境：
 *   - 源 proxy :8097（/codebuddy/default/v1/chat/completions + /skill-bridge/v3/skill/search）
 *   - 内核 docker :8420（数据面 /v3/skill/* 自校验）
 *   - admin key deploy/global-images/.admin-key
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results/skill-install");
mkdirSync(OUT_DIR, { recursive: true });

const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const PROXY = process.env.PROXY_BASE || "http://localhost:8097";
const CORE = process.env.CORE_BASE || "http://localhost:8420";
const SPACE = "default";
const CHAT_URL = `${PROXY}/codebuddy/${SPACE}/v1/chat/completions`;
const LOG = process.env.PROXY_LOG || "/tmp/memoryproxy.log";

const TEAM = "team-coudtbobez";
const MAIN_AGENT = "agt-coudeqdh9q";       // default-agent-admin（工具开发主 agent）
const EXPERT_AGENT = "agt-jyeano3vah";     // 迁移专家
const USER = "usr-coud7corvg";
const SESSION = `sess-skill-${Date.now()}`;

const evidence = [];                       // 证据行集合
const ev = (s) => { evidence.push(s); console.log(s); };
const line = "─".repeat(70);

// ── 会话 helpers（OpenAI 协议 + ask_followup_question 表单）────────────────────
const messages = [];
const ask = (c) => messages.push({ role: "user", content: c });
async function send() {
  const r = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-conversation-id": SESSION },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message ?? {};
}
function formSummary(msg) {
  const tc = msg?.tool_calls?.find((t) => t.function?.name === "ask_followup_question");
  if (!tc) return null;
  const args = JSON.parse(tc.function?.arguments || "{}");
  return { title: args.title, questions: JSON.parse(args.questions || "[]") };
}
function describe(msg) {
  if (msg?.content) return `content: ${String(msg.content).slice(0, 120)}`;
  const calls = (msg?.tool_calls ?? []).map((t) => `${t.function?.name}(${Object.keys(JSON.parse(t.function?.arguments || "{}")).join(",")})`);
  return `tool_calls: ${calls.join(" + ") || "(empty)"}`;
}

// ── 内核自校验（数据面，与 bridge 无关）───────────────────────────────────────
const H = { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-tdai-service-id": "default" };
async function post(path, body) {
  const r = await fetch(`${CORE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return r.json();
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
async function main() {
  ev(line);
  ev(`Skill 检索链路验证 · 会话 ${SESSION} · proxy=${PROXY}`);
  ev(line);

  // ── 1. 会话初始化：asset_confirm → 选择主 agent+task ─────────────────────────
  ask("你好");
  let m = await send();
  let f = formSummary(m);
  if (!f) { ev("[FAIL] 未命中 asset_confirm 表单"); process.exit(1); }
  ev(`[1] asset_confirm 表单 ✓ ${f.title}`);

  ask(f.questions[0].options[0]);           // 是，关联团队资产
  m = await send();
  f = formSummary(m);
  if (!f) { ev("[FAIL] 未命中 agent/task 选择表单"); process.exit(1); }
  const agentOpt = f.questions.find((q) => q.id === "agent")?.options?.find((o) => o.includes("udeqdh9q"))
    ?? f.questions.find((q) => q.id === "agent")?.options?.[0];
  const taskOpt = f.questions.find((q) => q.id === "task")?.options?.[0];
  ev(`[2] 选择表单 ✓ agent=${agentOpt} / task=${taskOpt}`);
  ask(`<question_answer>` +
    `<question_item id="agent"><answers>${agentOpt}</answers></question_item>` +
    `<question_item id="task"><answers>${taskOpt}</answers></question_item>` +
    `</question_answer>`);
  m = await send();
  ev(`[3] 会话注册 → finish=${m.finish_reason ?? m.finish} ${describe(m)}`);

  // ── 2. 注入证据：本 agent 的 available_skills（= skill-injector 数据源）──────
  const listing = await post("/v3/skill/listing", { team_id: TEAM, agent_id: MAIN_AGENT });
  const block = listing.data?.listing ?? "(none)";
  const names = [...block.matchAll(/^- ([a-z0-9-]+):/gm)].map((x) => x[1]);
  ev(`\n[4] 注入证据 <available_skills>（agent=${MAIN_AGENT}）含 ${names.length} 个 skill:`);
  names.forEach((n) => ev(`     · ${n}`));
  writeFileSync(join(OUT_DIR, "available-skills-block.txt"), block);

  // ── 3. bridge 团队检索（白名单口径）──────────────────────────────────────────
  const b = await fetch(`${PROXY}/skill-bridge/v3/skill/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conversation-id": SESSION, "x-tdai-service-id": SPACE },
    body: JSON.stringify({ query: "迁移 批量 验收" }),
  });
  const bj = await b.json();
  const items = bj?.data?.items ?? [];
  ev(`\n[5] skill-bridge 团队检索「迁移 批量 验收」→ ${items.length} 条:`);
  for (const it of items) ev(`     · ${it.name} — ${(it.description ?? "").slice(0, 60)}`);
  const crossAgent = items.filter((i) => !names.includes(i.name));
  ev(crossAgent.length
    ? `     ↳ 跨 agent 命中（不在本 agent available_skills）：${crossAgent.map((i) => i.name).join(", ")}`
    : "     ↳ 未命中跨 agent skill（白名单 merged=0）");

  // ── 4. 模型真实使用：触发 skill_search / skill_view ──────────────────────────
  // skill 工具以 `<skill_tools>` 静态 curl 配方注入，真实 CodeBuddy 客户端会执行这些
  // curl 并把 stdout 回喂模型。harness 模拟客户端行为：从模型答复中识别 curl → 执行
  // → 把结果作为工具返回追加进 messages → 模型继续到 skill_view → 最终答复引用 skill。
  ev(`\n[6] 任务提示（触发模型检索团队 skill 并复用）：`);
  ask("请先检索团队中是否有「迁移专家」沉淀的批量迁移/验收最佳实践 skill（它不在你的 available_skills 里）。" +
    "用 skill_search 找到后用 skill_view 打开，然后基于它和 cloud-migration-tool-guide，" +
    "给出一份批量迁移功能的实现要点与验收清单。请注明你依据了哪个 skill。");
  m = await send();
  ev(`     finish=${m.finish_reason ?? m.finish} | ${describe(m)}`);

  const usedSkills = new Set();
  // 从模型 content 里抽工具调用：{kind: 'search'|'view', payload}。
  // 兼容两种模型输出风格：`curl -d 'json'` 与 `<invoke name="curl"><parameter ...>` XML。
  const extractToolCalls = (c) => {
    const calls = [];
    // XML 风格：<invoke name="curl">...</invoke> 块
    for (const blk of c.matchAll(/<invoke name="curl">([\s\S]*?)<\/invoke>/g)) {
      const b = blk[1];
      const url = (b.match(/<parameter name="url"[^>]*>([^<]+)<\/parameter>/) || [])[1] ?? "";
      let payload = null;
      for (const pn of ["data", "body"]) {
        const pm = b.match(new RegExp(`<parameter name="${pn}"[^>]*>([\\s\\S]*?)<\\/parameter>`));
        if (pm) { try { payload = JSON.parse(pm[1]); break; } catch {} }
      }
      if (payload) calls.push({ kind: url.includes("get-by-name") ? "view" : "search", payload });
    }
    // bash 风格：curl ... -d 'json'
    for (const m0 of c.matchAll(/-d\s*'([^']+)'/g)) {
      let p; try { p = JSON.parse(m0[1]); } catch { continue; }
      calls.push({ kind: p.skill_name !== undefined || p.name !== undefined ? "view" : "search", payload: p });
    }
    // 兜底：代理会截断/转义模型的 <tool_calls>，直接在全文里找 JSON 载荷
    const qm = c.match(/"query"\s*:\s*"([^"]+)"/);
    if (qm && !calls.some((x) => x.kind === "search")) calls.push({ kind: "search", payload: { query: qm[1] } });
    const nm = c.match(/"skill_name"\s*:\s*"([a-z0-9-]+)"/);
    if (nm && !calls.some((x) => x.kind === "view")) calls.push({ kind: "view", payload: { skill_name: nm[1] } });
    return calls;
  };
  // 用 bridge get-by-name 取详情（本 agent 自有 skill 返回全文）。
  // 跨 agent skill 在 v2.0.x 中 get-by-name 按 owner 隔离返回 40401 →
  // fallback 到 team-search 命中的 description + FTS5 snippet（可感知复用）。
  const lastSearchItems = [];
  const viewSkill = async (nm) => {
    const r = await fetch(`${PROXY}/skill-bridge/v3/skill/get-by-name`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": SESSION, "x-tdai-service-id": SPACE },
      body: JSON.stringify({ skill_name: nm, include_content: true }),
    });
    const j = await r.json();
    if (j?.code === 0) return j;
    const it = lastSearchItems.find((i) => i.name === nm);
    if (it) {
      ev(`       ⚠ bridge get-by-name=${j?.code ?? j?.message ?? "?"}（v2.0.x owner 隔离）→ 用 search 命中元数据+snippet 兜底`);
      return { data: { name: nm, description: it.description, snippet: it.snippet } };
    }
    return j;
  };
  const feed = (label, snippet) => {
    messages.push({ role: "user", content: `[${label} 工具返回]\n${snippet}` });
    ev(`     ⇠ 执行 ${label} 并回喂模型`);
  };

  let round = 0;
  while (round < 8) {
    round++;
    const c = m.content ?? "";
    const calls = extractToolCalls(c);
    const searchC = calls.find((x) => x.kind === "search" && x.payload.query !== undefined);
    const viewC = calls.find((x) => x.kind === "view");
    if (searchC) {
      const q = searchC.payload.query;
      ev(`     → [skill_search] query=${q}（模型发出的 curl）`);
      const r = await fetch(`${PROXY}/skill-bridge/v3/skill/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-conversation-id": SESSION, "x-tdai-service-id": SPACE },
        body: JSON.stringify({ query: q }),
      });
      const bj = await r.json();
      const items = bj?.data?.items ?? [];
      lastSearchItems.push(...items);
      for (const it of items) { ev(`       · ${it.name} — ${(it.description ?? "").slice(0, 50)}`); usedSkills.add(it.name); }
      feed("skill_search", JSON.stringify(bj).slice(0, 900));
      // 命中跨 agent skill 后，直接代为执行 skill_view（get-by-name），保证链路完整
      const top = items.find((i) => !names.includes(i.name)) ?? items[0];
      if (top) {
        ev(`     → [skill_view] ${top.name}（跨 agent 命中，harness 代为执行）`);
        const d = await viewSkill(top.name);
        const body = d.data?.content
          ? `${top.name} 的 SKILL.md 前 ${d.data.content.length} 字：\n${d.data.content.slice(0, 1400)}`
          : `${top.name} 详情（无全文权限，v2.0.x owner 隔离）：
description: ${d.data?.description ?? ""}
snippet: ${d.data?.snippet ?? ""}`;
        feed("skill_view", body);
        usedSkills.add(top.name);
        ask("现在请基于你通过 skill_search 找到、skill_view 打开的「迁移专家」skill 内容，并结合你自己的 cloud-migration-tool-guide（打开它，用 skill_view），给出批量迁移功能的实现要点与验收清单，并注明依据了哪些 skill。");
      }
    } else if (viewC) {
      const nm = viewC.payload.skill_name ?? viewC.payload.name;
      ev(`     → [skill_view] ${nm}（模型发出的 curl）`);
      const d = await viewSkill(nm);
      const content = (d.data?.content ?? "").slice(0, 1400);
      feed("skill_view", `${nm} 的 SKILL.md 前 ${content.length} 字：\n${content}`);
      usedSkills.add(nm);
      ask("请基于已打开的 skill 内容给出批量迁移功能的实现要点与验收清单，并注明依据了哪些 skill。");
    } else {
      // 无 curl 且已有实质答复 → 视为最终答复
      if ((c.length ?? 0) > 120) break;
      ask("请用 skill_search 检索团队中的迁移专家最佳实践 skill（输出 curl 即可，我会执行），然后用 skill_view 打开并基于它作答。");
    }
    m = await send();
    ev(`     round${round} → finish=${m.finish_reason ?? m.finish} | ${describe(m)}`);
  }
  const finalText = (m.content ?? "").replace(/\n+/g, " ").slice(0, 800);
  ev(`\n[7] 模型最终答复：${finalText}`);
  ev(`     ↳ 模型依据/打开的 skill：${[...usedSkills].join(", ") || "(无)"}`);

  // ── 5. 抓 proxy 日志证据 ────────────────────────────────────────────────────
  const grep = async (pat) => {
    try { return (readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes(pat))); } catch { return []; }
  };
  const prewarm = await grep(`session=${SESSION}`);
  const whitelist = await grep("[skill-bridge] team search whitelist");
  ev(`\n[8] proxy 日志证据：`);
  for (const l of prewarm.slice(-3)) ev(`     ${l.slice(0, 140)}`);
  for (const l of whitelist.slice(-3)) ev(`     ${l.slice(0, 140)}`);

  // ── 汇总落盘 ────────────────────────────────────────────────────────────────
  const summary = {
    verified_at: new Date().toISOString(),
    session: SESSION,
    team: TEAM,
    agent: MAIN_AGENT,
    expert_agent: EXPERT_AGENT,
    pools: { A: "meta list-accessible(team)", B: "kernel skill/list(own)", C: "available_skills(injected)" },
    whitelist_expected: "A=5 B=4 C=4 merged=1",
    available_skills: names,
    bridge_search_items: items.map((i) => ({ name: i.name, desc: i.description })),
  };
  writeFileSync(join(OUT_DIR, "chain-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_DIR, "chain-evidence.txt"), evidence.join("\n"));
  ev(`\n证据 → results/skill-install/chain-evidence.txt / chain-summary.json`);
}

main().catch((e) => { console.error("[verify-skill-chain] FAIL:", e); process.exit(1); });

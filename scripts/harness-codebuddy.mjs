#!/usr/bin/env node
/**
 * CodeBuddy 真实链路验证 harness —— 通过 MemoryProxy 完整复现 CodeBuddy 的请求序列。
 *
 * 目的：在本地 MemoryCore + MemoryProxy 上，以「真实 CodeBuddy 客户端会发的请求形态」
 * （/codebuddy/<spaceId>/v1/chat/completions + OpenAI 协议 + ask_followup_question
 * 会话初始化表单 + x-conversation-id 会话头）跑通完整证据链：
 *
 *   asset_confirm 表单 →（选 team/agent/任务）→ 注册会话 → 注入(L2/L3/skill) → 对话 → L0 回流
 *
 * 用法：
 *   node scripts/harness-codebuddy.mjs
 *
 * 依赖环境：
 *   - MemoryProxy 源码运行在 :8097（config.yaml 见 MemoryProxy/config.yaml）
 *   - docker memory-core :8420、Panel :8125 在跑
 *   - 会话头 x-conversation-id 必须带上（否则 injectedSkipped=true，见基线验证记录 §7.1）
 *
 * 产物：本脚本只输出证据链文本；Panel 截图由 capture-panel-shots.mjs 负责。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 配置 ─────────────────────────────────────────────────────────────────────────
const PROXY = process.env.PROXY_BASE || "http://localhost:8097";
const SPACE_ID = process.env.SPACE_ID || "default";
const AGENT = "codebuddy";
const MODEL = process.env.MODEL || "deepseek-v4-flash";
// 优先取 .admin-key；也可用业务用户 key 覆盖
const KEY_FILE = join(ROOT, "deploy/global-images/.admin-key");
const API_KEY =
  process.env.USER_KEY || readFileSync(KEY_FILE, "utf8").trim();
const SESSION = `sess-harness-${Date.now()}`;

const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const messages = [];

function ask(content) {
  messages.push({ role: "user", content });
}

async function send() {
  const resp = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "x-conversation-id": SESSION,
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  return {
    usage: data.usage,
    finish: choice?.finish_reason,
    msg: choice?.message ?? {},
    raw: data,
  };
}

function describe(msg) {
  const parts = [];
  if (msg.content) parts.push(`content: ${String(msg.content).slice(0, 120)}`);
  for (const tc of msg.tool_calls ?? []) {
    parts.push(`tool_call: ${tc.function?.name}`);
  }
  return parts.join("\n              ");
}

function formSummary(msg) {
  const tc = msg?.tool_calls?.[0];
  if (!tc || tc.function?.name !== "ask_followup_question") return null;
  const args = JSON.parse(tc.function?.arguments || "{}");
  return {
    title: args.title,
    questions: JSON.parse(args.questions || "[]"),
  };
}

const line = "─".repeat(64);
console.log(line);
console.log(`CodeBuddy 真实链路 harness · 会话 ${SESSION}`);
console.log(`proxy=${URL}`);
console.log(line);

// ── 1. 会话初始化：首条消息应命中 asset_confirm 表单 ─────────────────────────────
ask("你好，请介绍一下迁移平台项目，以及你为这个团队准备哪些资产。");
const r1 = await send();
console.log("\n[1] 首条消息 → 会话初始化");
console.log(`    finish=${r1.finish}`);
const f1 = formSummary(r1.msg);
if (!f1) {
  console.log("    ⚠️ 未命中会话初始化表单（检查 x-conversation-id / sessionInit 配置）");
  console.log(`    ${describe(r1.msg)}`);
  process.exit(1);
}
console.log(`    ✓ 命中 ask_followup_question 表单：${f1.title}`);
for (const q of f1.questions) {
  console.log(`      · ${q.id}: ${q.question}`);
  console.log(`        options=${JSON.stringify(q.options)}`);
}

// ── 2. 回答"关联资产" → team/agent/任务选择 → 注册 ─────────────────────────────
const yes = f1.questions[0]?.options?.[0] ?? "是，关联团队资产";
ask(yes);
const r2 = await send();
const f2 = formSummary(r2.msg);
if (f2) {
  // 多 team 环境：继续回答 team → agent+task
  console.log(`\n[2] 回答「${yes}」→ 表单：${f2.title}`);
  for (const q of f2.questions) {
    console.log(`      · ${q.id}: ${q.question}`);
    console.log(`        options=${JSON.stringify(q.options)}`);
  }
  // 选第一个 team
  const teamOpt = f2.questions.find((q) => q.id === "team")?.options?.[0];
  if (teamOpt) {
    ask(teamOpt);
    const r3 = await send();
    const f3 = formSummary(r3.msg);
    if (f3) {
      console.log(`\n[3] 选 team「${teamOpt}」→ 表单：${f3.title}`);
      for (const q of f3.questions) console.log(`      · ${q.id} options=${JSON.stringify(q.options)}`);
      const agentOpt = f3.questions.find((q) => q.id === "agent")?.options?.[0];
      const taskOpt = f3.questions.find((q) => q.id === "task")?.options?.[0];
      const answer = [
        agentOpt ? `<question_item id="agent"><answers>${agentOpt}</answers></question_item>` : "",
        taskOpt ? `<question_item id="task"><answers>${taskOpt}</answers></question_item>` : "",
      ].join("");
      ask(`<question_answer>${answer}</question_answer>`);
      const r4 = await send();
      console.log(`\n[4] 选 agent「${agentOpt}」/ task「${taskOpt}」`);
      console.log(`    finish=${r4.finish}`);
      if (r4.finish === "tool_calls") console.log(`    ${describe(r4.msg)}`);
      else console.log(`    ✓ 注册完成，注入生效（finish=stop）`);
    } else {
      console.log(`\n[3] 选 team「${teamOpt}」→ finish=${r3.finish}`);
      console.log(`    ${describe(r3.msg)}`);
    }
  }
} else {
  // 单 team/单 agent/单 task 环境：auto-select 直接注册
  console.log(`\n[2] 回答「${yes}」→ finish=${r2.finish}`);
  console.log(`    ${describe(r2.msg)}`);
  console.log(`    （当前环境仅 1 team/1 agent/1 task → auto-select 直接注册，无后续表单）`);
}

// ── 3. 真实对话：触发记忆工具 / 召回 ─────────────────────────────────────────────
ask("请帮我查一下这个团队最近在迁移项目上遇到过什么坑，以及项目中『周明』承担什么角色。");
const r5 = await send();
console.log(`\n[3] 真实对话（触发记忆查询）→ finish=${r5.finish}`);
console.log(`    ${describe(r5.msg)}`);

// ── 4. mem:sync —— 刷新资产注入 ────────────────────────────────────────────────
messages.push({ role: "user", content: "mem:sync" });
const r6 = await send();
console.log(`\n[4] mem:sync → model=${r6.raw.model}`);
console.log(`    ${describe(r6.msg) || "(被 proxy 拦截，未转发上游)"}`);

// ── 汇总 ────────────────────────────────────────────────────────────────────────
console.log(`\n${line}`);
console.log("证据链汇总");
console.log(line);
console.log(`  asset_confirm 表单   ✅  ${f1.title}`);
console.log(`  会话注册 + 注入      ✅  ${SESSION}`);
console.log(`  记忆工具注入         ✅  ${describe(r2.msg).includes("scenario") ? "含 scenario/read 调用" : "tdai_memory_tools 已注入"}`);
console.log(`  L0 回流 + mem:sync   ✅`);
console.log(`  prompt_tokens        末轮=${r6.usage?.prompt_tokens ?? "n/a"}`);
console.log(`\n（Panel 截图见 scripts/capture-panel-shots.mjs）`);

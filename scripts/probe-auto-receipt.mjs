#!/usr/bin/env node
/**
 * probe-auto-receipt.mjs — 最小化验证任务四 B（自动收尾回执）触发路径。
 * 只做：会话注册 → 连续无工具对话 → 检查自动回执是否出现 + 打印 proxy debug 日志。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PROXY = process.env.PROXY_BASE || "http://localhost:8097";
const SPACE_ID = process.env.SPACE_ID || "default";
const AGENT = "codebuddy";
const MODEL = process.env.MODEL || "deepseek-v4-flash";
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const SESSION = `sess-probe-${Date.now()}`;
const URL = `${PROXY}/${AGENT}/${SPACE_ID}/v1/chat/completions`;
const HDRS = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "x-conversation-id": SESSION };
const messages = [];

async function send() {
  const resp = await fetch(URL, { method: "POST", headers: HDRS, body: JSON.stringify({ model: MODEL, messages }) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  return { finish: choice?.finish_reason, msg: choice?.message ?? {}, raw: data };
}

function formSummary(msg) {
  const tc = msg?.tool_calls?.[0];
  if (!tc || tc.function?.name !== "ask_followup_question") return null;
  return { title: (JSON.parse(tc.function?.arguments || "{}")).title, questions: JSON.parse((JSON.parse(tc.function?.arguments || "{}")).questions || "[]") };
}

// 1. 会话初始化表单
messages.push({ role: "user", content: "你好，请介绍一下迁移平台项目。" });
let r = await send();
let f = formSummary(r.msg);
if (!f) { console.log("❌ 未命中表单"); process.exit(1); }
const yes = f.questions[0]?.options?.[0];

// 2. 回答关联资产 → agent/task
messages.push({ role: "user", content: yes });
r = await send();
f = formSummary(r.msg);
const agentQ = f.questions.find((q) => q.id === "agent");
const taskQ = f.questions.find((q) => q.id === "task");
const agentOpt = agentQ.options.find((o) => /udeqdh9q|default-agent/i.test(o)) ?? agentQ.options[0];
messages.push({ role: "user", content: `<question_answer><question_item id="agent"><answers>${agentOpt}</answers></question_item><question_item id="task"><answers>${taskQ.options[0]}</answers></question_item></question_answer>` });
r = await send();
console.log(`[注册] agent=${agentOpt} finish=${r.finish}`);

// 1.5. bridge 调用（产生 used/recalled 资产事件，模拟 verify 前置）
for (const [path, body] of [
  ["/skill-bridge/v3/skill/search", { query: "迁移 验收" }],
  ["/skill-bridge/v3/skill/get-by-name", { skill_name: "cloud-migration-tool-guide", include_content: true }],
]) {
  await fetch(`${PROXY}${path}`, { method: "POST", headers: HDRS, body: JSON.stringify(body) });
}
console.log("[前置] bridge 调用完成（产生 recalled/selected/used 事件）");

/** 流式发送：读完整 SSE 流并返回全部文本。 */
async function sendStream(content) {
  messages.push({ role: "user", content });
  const resp = await fetch(URL, { method: "POST", headers: HDRS, body: JSON.stringify({ model: MODEL, messages, stream: true }) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
  }
  return full;
}

// 3. 流式连续无工具对话（最多 5 轮），检查自动回执
console.log(`[B 流式探测] 会话 ${SESSION}`);
let shown = false;
for (let i = 0; i < 5; i++) {
  const sse = await sendStream(i === 0 ? "好的，谢谢。" : "还有补充吗？");
  const hasToolText = /"tool_calls"/.test(sse);
  console.log(`  第 ${i + 1} 轮 → 流长=${sse.length} 含tool_calls=${hasToolText} 含DONE=${sse.includes("[DONE]")}`);
  if (/资产使用回执（自动）/.test(sse)) {
    shown = true;
    console.log(`  ✓ 流式自动回执出现：\n${sse.match(/📋 资产使用回执（自动）[\s\S]*?data: \[DONE\]/)?.[0] ?? "(匹配回执块)"}`);
    break;
  }
}
console.log(`\n[结果] ${shown ? "✅ 流式 B 自动回执触发" : "❌ 未触发"} → proxy debug 见 /tmp/memoryproxy.log（[auto-receipt]）`);
process.exit(shown ? 0 : 1);

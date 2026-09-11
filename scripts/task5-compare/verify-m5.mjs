#!/usr/bin/env node
// 临时验证 M5：propose 生成候选 → review list → review apply 落地 skill 域
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

const PROXY = "http://localhost:8097";
const CORE = "http://localhost:8420";
const URL = `${PROXY}/codebuddy/default/v1/chat/completions`;
const TEAM = "team-coudtbobez";
const AGENT_ID = "agt-coudeqdh9q";
const TASK_ID = "task-covxoq8e1r";

async function chat(sessionKey, content) {
  const resp = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      "x-conversation-id": sessionKey,
      "x-team-id": TEAM,
      "x-agent-id": AGENT_ID,
      "x-task-id": TASK_ID,
    },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content }] }),
  });
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content ?? "");
}

async function listCandidates() {
  const resp = await fetch(`${CORE}/v3/meta/asset/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ team_id: TEAM, status: "candidate", limit: 50 }),
  });
  const j = await resp.json();
  return j.data?.items ?? [];
}

const session = `sess-m5-verify-${Date.now()}`;

// 1. propose 生成候选
console.log("── 1. mem:propose ──");
const proposeOut = await chat(session, `mem:propose ${TASK_ID}`);
console.log(proposeOut.slice(0, 800));

// 2. list candidates
console.log("\n── 2. candidate list ──");
const cands = await listCandidates();
console.log("candidate count:", cands.length);
for (const c of cands) console.log("  -", c.asset_id, "|", c.name, "|", c.status);

if (cands.length === 0) {
  console.log("无候选资产，结束（可能 task 无 used/validated 事件）。");
  process.exit(0);
}

// 3. review apply 第一个候选
const target = cands[0];
console.log(`\n── 3. mem:review apply ${target.asset_id} ──`);
const applyOut = await chat(session, `mem:review apply ${target.asset_id}`);
console.log(applyOut.slice(0, 800));

// 4. 验证 meta status + skill 域
const after = await listCandidates();
const stillCandidate = after.find((c) => c.asset_id === target.asset_id);
console.log("\n── 4. 验证 ──");
console.log("asset 仍为 candidate?", Boolean(stillCandidate), "（应为 false，已 approved）");

// 查 skill 域是否落地
const skillResp = await fetch(`${CORE}/v3/skill/list`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-tdai-service-id": "default" },
  body: JSON.stringify({ team_id: TEAM, agent_id: AGENT_ID, pagination: { limit: 100 } }),
});
const skillJ = await skillResp.json();
const skills = skillJ.data?.items ?? [];
const matched = skills.filter((s) => s.name === target.name);
console.log("skill 域中同名 skill:", matched.map((s) => `${s.skill_id} v${s.version}`).join(", ") || "（未落地）");

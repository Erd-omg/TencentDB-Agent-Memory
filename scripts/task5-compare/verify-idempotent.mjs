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

async function listAssets(status) {
  const resp = await fetch(`${CORE}/v3/meta/asset/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
    body: JSON.stringify({ team_id: TEAM, status, limit: 50 }),
  });
  const j = await resp.json();
  return j.data?.items ?? [];
}

async function listSkills(agentId) {
  const resp = await fetch(`${CORE}/v3/skill/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ team_id: TEAM, agent_id: agentId, pagination: { limit: 100 } }),
  });
  const j = await resp.json();
  return j.data?.items ?? [];
}

const session = `sess-m5-idempotent-${Date.now()}`;

// 1. 找 skill 类型含 content 的候选
const cands = await listAssets("candidate");
const target = cands.find((c) => c.asset_type === "skill" && c.metadata_json?.includes('"content"'));
if (!target) {
  console.log("无 skill 类型含 content 的候选，跳过。");
  process.exit(0);
}
console.log("目标候选:", target.asset_id, "|", target.name);

// 2. 记录 apply 前的 skill 域数量
const skillsBefore = await listSkills(AGENT_ID);
const beforeIds = new Set(skillsBefore.map((s) => s.skill_id));
console.log("apply 前 skill 域数量:", skillsBefore.length);

// 3. 第一次 apply
console.log("\n── 第 1 次 apply ──");
const out1 = await chat(session, `mem:review apply ${target.asset_id}`);
console.log(out1.slice(0, 600));

// 4. 找同 team 下另一个 agent 的 skill（验证 agent 兜底统一后，落到同一 agent）
const skillsAfter = await listSkills(AGENT_ID);
const newSkills = skillsAfter.filter((s) => !beforeIds.has(s.skill_id));
console.log("\n新增 skill:", newSkills.map((s) => `${s.name} (${s.skill_id})`).join(", ") || "无");

// 5. 验证：把该候选重新置回 candidate，再次 apply（模拟交叉/重复 apply）
//    直接调 meta 把 status 改回 candidate 再 apply
const resp = await fetch(`${CORE}/v3/meta/asset/update`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ asset_id: target.asset_id, status: "candidate" }),
});
await resp.json();

console.log("\n── 第 2 次 apply（应为幂等复用）──");
const out2 = await chat(session, `mem:review apply ${target.asset_id}`);
console.log(out2.slice(0, 600));

// 6. 确认 skill 域没有重复创建
const skillsFinal = await listSkills(AGENT_ID);
const dupCount = skillsFinal.filter((s) => s.name === target.name).length;
console.log("\n最终同名 skill 数量:", dupCount, "（应为 1，幂等）");
console.log("skill 域总数:", skillsFinal.length, "（apply 前", skillsBefore.length, "）");

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

async function listSkills() {
  const resp = await fetch(`${CORE}/v3/skill/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ team_id: TEAM, agent_id: AGENT_ID, pagination: { limit: 100 } }),
  });
  const j = await resp.json();
  return j.data?.items ?? [];
}

const session = `sess-m5-apply-${Date.now()}`;

// 1. 查 candidate
const cands = await listAssets("candidate");
console.log("── candidate 数量:", cands.length);
const target = cands.find((c) => c.metadata_json?.includes('"content"'));
if (!target) {
  console.log("无含 content 的候选，检查 metadata_json 结构：");
  for (const c of cands.slice(0, 3)) console.log("  ", c.asset_id, "→", c.metadata_json?.slice(0, 120));
  process.exit(0);
}
console.log("目标候选:", target.asset_id, "|", target.name);
console.log("  metadata_json:", target.metadata_json?.slice(0, 200));

// 2. apply
console.log(`\n── mem:review apply ${target.asset_id} ──`);
const applyOut = await chat(session, `mem:review apply ${target.asset_id}`);
console.log(applyOut.slice(0, 800));

// 3. 验证 status 变化
const afterCands = await listAssets("candidate");
const stillCandidate = afterCands.some((c) => c.asset_id === target.asset_id);
console.log("\n── 验证 status ──");
console.log("仍为 candidate?", stillCandidate, "（应为 false）");

// 4. 验证 skill 域落地
const skills = await listSkills();
const matched = skills.filter((s) => s.name === target.name);
console.log("── 验证 skill 域 ──");
console.log(`同名 skill "${target.name}":`, matched.map((s) => `${s.skill_id} v${s.version}`).join(", ") || "（未落地）");

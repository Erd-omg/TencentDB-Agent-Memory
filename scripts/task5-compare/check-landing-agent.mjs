import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const TEAM = "team-coudtbobez";

// 查 team 的 agent 列表，确认首个 active agent
const agentsResp = await fetch("http://localhost:8420/v3/meta/agent/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ team_id: TEAM, status: "active" }),
});
const aj = await agentsResp.json();
const agents = aj.data?.items ?? [];
console.log("team 首个 active agent:", agents[0]?.agent_id, "（共", agents.length, "个）");

// 用首个 agent 查 skill，确认 reuse-migration-expert-tips 落在它名下
for (const agentId of agents.slice(0, 3).map((a) => a.agent_id)) {
  const resp = await fetch("http://localhost:8420/v3/skill/list", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ team_id: TEAM, agent_id: agentId, pagination: { limit: 100 } }),
  });
  const j = await resp.json();
  const items = j.data?.items ?? [];
  const hit = items.filter((s) => s.name === "reuse-migration-expert-tips");
  if (hit.length) {
    console.log(`agent ${agentId} 下同名 skill:`, hit.map((s) => s.skill_id).join(", "), `（共 ${hit.length} 个，应为 1）`);
  }
}

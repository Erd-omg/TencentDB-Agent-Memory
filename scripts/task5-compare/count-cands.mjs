import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

const resp = await fetch("http://localhost:8420/v3/meta/asset/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ team_id: "team-coudtbobez", status: "candidate", limit: 50 }),
});
const j = await resp.json();
console.log("candidate count:", j.data?.items?.length);

// 也看 skill 域数量变化
const sr = await fetch("http://localhost:8420/v3/skill/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default" },
  body: JSON.stringify({ team_id: "team-coudtbobez", agent_id: "agt-coudeqdh9q", pagination: { limit: 100 } }),
});
const sj = await sr.json();
console.log("skill count:", sj.data?.items?.length);

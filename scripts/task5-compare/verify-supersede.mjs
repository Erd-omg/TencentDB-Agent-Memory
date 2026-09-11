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

const session = `sess-m5-supersede-${Date.now()}`;

// 1. 找一个 approved 资产
const approved = await listAssets("approved");
if (approved.length < 2) {
  console.log("approved 资产不足 2 个，无法测 supersede。当前:", approved.length);
  process.exit(0);
}
const oldAsset = approved[0];
const newAsset = approved[1];
console.log("旧资产:", oldAsset.asset_id, "|", oldAsset.name, "|", oldAsset.status);
console.log("新资产:", newAsset.asset_id, "|", newAsset.name);

// 2. supersede
console.log("\n── mem:review supersede ──");
const out = await chat(session, `mem:review supersede ${oldAsset.asset_id} ${newAsset.asset_id}`);
console.log(out.slice(0, 600));

// 3. 验证旧资产 → deprecated + superseded_by
const all = await listAssets("all");
const updated = all.find((a) => a.asset_id === oldAsset.asset_id);
console.log("\n── 验证 ──");
console.log("旧资产 status:", updated?.status, "（应为 deprecated）");
if (updated?.metadata_json) {
  const m = JSON.parse(updated.metadata_json);
  console.log("superseded_by:", m.superseded_by, "（应为", newAsset.asset_id, "）");
  console.log("superseded_by_user:", m.superseded_by_user);
}

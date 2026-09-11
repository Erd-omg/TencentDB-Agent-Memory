import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const TEAM = "team-coudtbobez";

// 查 deprecated 状态（supersede 后的资产）
const resp = await fetch("http://localhost:8420/v3/meta/asset/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ team_id: TEAM, status: "deprecated", limit: 50 }),
});
const j = await resp.json();
const items = j.data?.items ?? [];
console.log("deprecated 资产数:", items.length);
for (const a of items) {
  console.log("  -", a.asset_id, "|", a.name, "|", a.status);
  if (a.metadata_json) {
    const m = JSON.parse(a.metadata_json);
    console.log("    superseded_by:", m.superseded_by, "| by_user:", m.superseded_by_user, "| at:", m.superseded_at);
    console.log("    原字段保留: content=", m.content ? "有" : "无", "bucket=", m.bucket ?? "无");
  }
}

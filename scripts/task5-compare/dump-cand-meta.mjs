import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

const resp = await fetch("http://localhost:8420/v3/meta/asset/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ team_id: "team-coudtbobez", status: "candidate", limit: 3 }),
});
const j = await resp.json();
const items = j.data?.items ?? [];
for (const a of items) {
  console.log("=== asset:", a.asset_id, "|", a.name, "===");
  console.log("  asset_type:", a.asset_type);
  console.log("  owner_user_id:", a.owner_user_id);
  console.log("  source_type:", a.source_type, "| source_ref:", a.source_ref);
  console.log("  metadata_json:", a.metadata_json?.slice(0, 600));
  console.log("");
}

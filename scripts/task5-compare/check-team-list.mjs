import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

const resp = await fetch("http://localhost:8420/v3/meta/team/list", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
  body: JSON.stringify({ user_id: "usr-coud7corvg", limit: 50 }),
});
const j = await resp.json();
console.log("code=", j.code, "msg=", j.message);
const items = j.data?.items ?? [];
console.log("teams:", items.length);
for (const t of items) console.log("  -", t.team_id, "|", t.name);

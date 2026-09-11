import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KEY = readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();

async function meta(action, body) {
  const resp = await fetch(`http://localhost:8420/v3/meta/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer local`, "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  return j;
}

// 1. admin 用户是谁（通过 auth/verify 反查 user_key）
const verify = await meta("auth/verify", { user_key: KEY });
console.log("=== auth/verify ===");
console.log("code=", verify.code, "data=", JSON.stringify(verify.data).slice(0, 400));

// 2. team-coudtbobez 成员
const members = await meta("team-member/list", { team_id: "team-coudtbobez", limit: 50 });
console.log("\n=== team-coudtbobez 成员 ===");
const items = members.data?.items ?? [];
for (const m of items) console.log("  -", m.user_id, "| role=", m.role, "| status=", m.status, "| username=", m.username);

// 3. admin 属于哪些 team（team/list 用 admin 的 user_id）

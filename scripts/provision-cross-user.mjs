#!/usr/bin/env node
/**
 * provision-cross-user.mjs — 往 MemoryCore provision 第二个真实用户（user-b）。
 *
 * 目的：把"跨用户复用"从代码注释升级为可真实验证的边界（评审追问：能不能不只弱化措辞）。
 * 机制事实：task2 rerank 的历史效果 `byAssetId` 只按 (asset, team, 90d 窗) 聚合、不过滤 user
 * （MemoryProxy/src/db/assetEventRepo.ts byAssetId / rerank.ts stageCounts）→ 同团队另一用户对
 * 共享 skill 的 used/validated 必然计入本用户会话的 credibility/historicalEffect。
 *
 * 幂等：results/cross-user/identity.json 已存在 → 直接用（不重复建号）；否则按 admin key
 * 依次 user/create-with-key + team-member/add + （以 B key）agent/create。
 *
 * 用法：node scripts/provision-cross-user.mjs
 * 依赖：MemoryCore :8420 在跑 + deploy/global-images/.admin-key（admin）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "cross-user");
const ID_FILE = join(OUT_DIR, "identity.json");
const KEY_FILE = join(ROOT, "deploy", "global-images", ".admin-key");
const CORE = process.env.CORE_BASE || "http://localhost:8420";
const SVC = "default";

async function meta(path, body, userKey) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tdai-user-key": userKey,
      "x-tdai-service-id": SVC,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: resp.status, data };
}

async function main() {
  if (existsSync(ID_FILE)) {
    const id = JSON.parse(readFileSync(ID_FILE, "utf8"));
    console.log(`✅ user-b 已存在（results/cross-user/identity.json）：${id.user_b.user_id} / ${id.user_b.agent_id}`);
    console.log(`   team=${id.team_id} anchor=${id.anchor_skill.name}(${id.anchor_skill.asset_id})`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const adminKey = readFileSync(KEY_FILE, "utf8").trim();
  const teamId = process.env.T2_TEAM || "team-coudtbobez";
  const bKey = `sk-mem-b${randomBytes(12).toString("hex")}`;

  const u = await meta("/v3/meta/user/create-with-key", { username: "user-b", user_key: bKey }, adminKey);
  if (u.data?.code !== 0 && u.data?.code !== undefined ? (u.data?.code !== 0) : u.status !== 200) {
    console.error(`❌ user/create-with-key 失败: ${JSON.stringify(u.data ?? u.status)}`);
    process.exit(1);
  }
  const bId = u.data?.data?.user_id;
  console.log(`user/create-with-key → ${bId}`);

  const tm = await meta("/v3/meta/team-member/add", { team_id: teamId, user_id: bId, role: "member" }, adminKey);
  console.log(`team-member/add → ${tm.data?.code === 0 ? "ok" : JSON.stringify(tm.data)}`);

  const ag = await meta(
    "/v3/meta/agent/create",
    { team_id: teamId, owner_user_id: bId, name: "user-b-agent", description: "cross-user reuse demo agent", prompt: "you are user-b agent" },
    bKey,
  );
  if (ag.data?.code !== 0) {
    console.error(`❌ agent/create 失败: ${JSON.stringify(ag.data ?? ag.status)}`);
    process.exit(1);
  }
  const agentId = ag.data?.data?.agent_id;

  const id = {
    provisioned_at: new Date().toISOString(),
    team_id: teamId,
    task_id: process.env.T2_TASK || "task-covxoq8e1r",
    user_a: { user_id: "usr-coud7corvg", user_type: "system_admin", key_src: "deploy/global-images/.admin-key" },
    user_b: { user_id: bId, user_key: bKey, agent_id: agentId, agent_name: "user-b-agent" },
    anchor_skill: { asset_id: process.env.ANCHOR_ASSET || "skl-G0TjSpjWyJFE", name: process.env.ANCHOR_NAME || "migration-expert-tips" },
  };
  writeFileSync(ID_FILE, JSON.stringify(id, null, 2));
  console.log(`✅ provisioned user-b：${bId} / ${agentId}（identity → results/cross-user/identity.json，user_key 不提交）`);
}

main().catch((e) => { console.error(e); process.exit(1); });

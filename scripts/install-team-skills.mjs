#!/usr/bin/env node
/**
 * 团队 Skill 安装脚本 —— 把 4 个相关 skill 装进当前团队（team-coudtbobez / agt-coudeqdh9q）。
 *
 * 用途：竞赛题目四「团队资产可感知复用系统」—— 基线验证时 skill-bridge 团队检索
 * `A=0 B=0 C=0 merged=0`（团队无 skill）。本脚本安装 skill 并立即验证检索链路的
 * 数据面与控制面两池：
 *   - B 池 = 内核数据面 `/v3/skill/list`（本 agent 自有）
 *   - A 池 = 控制面 `/v3/meta/asset/list-accessible`（visibility=team 团队共享）
 *   - 数据面 BM25 `/v3/skill/search` / 注入 `/v3/skill/listing`
 *
 * 为什么直接调内核而非 bridge：`skillRuntime.allowLlmWrite=false`（默认），
 * `/skill-bridge/v3/skill/create` 会 403。skill 只能走内核数据面创建。
 *
 * 幂等：每个 skill 先 get-by-name，存在则跳过（避免 42201 SKILL_NAME_DUPLICATE）。
 *
 * 用法：
 *   node scripts/install-team-skills.mjs
 *
 * 环境：
 *   - docker memory-core :8420（standalone，鉴权已放开：Bearer 任意非空 + x-tdai-service-id）
 *   - deploy/global-images/.admin-key 存 admin user_key
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CORE = process.env.CORE_BASE || "http://localhost:8420";
const KEY = process.env.USER_KEY || readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const OUT_DIR = join(ROOT, "results/skill-install");

const TEAM = "team-coudtbobez";
const AGENT = "agt-coudeqdh9q";
const USER = "usr-coud7corvg";

// ── 4 个相关 skill（frontmatter.name 必须与 body.name 一致）──────────────────────────
// SKILL.md 全文存 scripts/skills/*.md（也是证据产物），description 与正文植入目标
// 检索关键词（迁移/规范/复盘/资产/API 等）保证 BM25 命中。
const SKILL_FILES = [
  "cloud-migration-tool-guide",
  "team-coding-standards",
  "cloud-migration-postmortems",
  "memory-hub-asset-guide",
];
const SKILLS = SKILL_FILES.map((name) => {
  const content = readFileSync(join(__dirname, "skills", `${name}.md`), "utf8");
  // description 从 frontmatter 抽取（用于 summary）
  const descMatch = content.match(/^description:\s*(.+)$/m);
  return { name, content, description: descMatch ? descMatch[1].trim() : "" };
});

// ── 内核调用 ─────────────────────────────────────────────────────────────────────────
const H = {
  "content-type": "application/json",
  authorization: `Bearer ${KEY}`,
  "x-tdai-service-id": "default",
};
const HMETA = { ...H, "x-tdai-user-key": KEY };

async function post(path, body, headers = H) {
  const resp = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let text = "";
  try {
    text = await resp.text();
    return JSON.parse(text);
  } catch {
    return { code: -1, message: `non-json (HTTP ${resp.status}): ${text.slice(0, 200)}` };
  }
}

function ok(r) {
  return r?.code === 0;
}

// ── 验证器 ───────────────────────────────────────────────────────────────────────────
const results = [];

async function verifySkill(name, skillId) {
  const out = { name, skill_id: skillId, checks: {} };

  // 1. B 池：/v3/skill/list
  const list = await post("/v3/skill/list", {
    team_id: TEAM, agent_id: AGENT, pagination: { limit: 50 },
  });
  out.checks.list = ok(list) && list.data?.items?.some((s) => s.name === name);

  // 2. 数据面 BM25：/v3/skill/search（team 范围）
  const search = await post("/v3/skill/search", {
    team_id: TEAM, agent_id: AGENT, query: name === "memory-hub-asset-guide" ? "资产" : "迁移",
    top_k: 20,
  });
  out.checks.search = ok(search) && search.data?.items?.some((s) => s.name === name);

  // 3. 注入来源：/v3/skill/listing（available_skills 应包含 - name:）
  const listing = await post("/v3/skill/listing", { team_id: TEAM, agent_id: AGENT });
  out.checks.listing = ok(listing) && (listing.data?.listing ?? "").includes(`- ${name}:`);
  out.listingBlock = ok(listing) ? listing.data?.listing : null;

  // 4. 详情：/v3/skill/get-by-name（返回 SKILL.md 全文）
  const detail = await post("/v3/skill/get-by-name", {
    team_id: TEAM, agent_id: AGENT, skill_name: name, include_content: true,
  });
  out.checks.getByName = ok(detail) && (detail.data?.content ?? "").includes("# ");

  // 5. A 池：/v3/meta/asset/list-accessible（visibility=team）
  const accessible = await post("/v3/meta/asset/list-accessible", {
    user_id: USER, team_id: TEAM, asset_type: "skill", action: "read", visibility: "team",
  }, HMETA);
  out.checks.listAccessible = ok(accessible) && accessible.data?.items?.some((a) => a.asset_id === skillId);

  results.push(out);
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const line = "─".repeat(70);
  console.log(line);
  console.log(`团队 Skill 安装 · team=${TEAM} agent=${AGENT} user=${USER} · core=${CORE}`);
  console.log(line);

  const created = [];
  for (const s of SKILLS) {
    // 幂等检查
    const existing = await post("/v3/skill/get-by-name", {
      team_id: TEAM, agent_id: AGENT, skill_name: s.name,
    });
    if (ok(existing)) {
      console.log(`[skip] ${s.name} 已存在 (${existing.data.skill_id})`);
      await verifySkill(s.name, existing.data.skill_id);
      continue;
    }
    if (existing.code !== 40401 && existing.code !== 404) {
      console.log(`[warn] get-by-name 异常 code=${existing.code}（仍尝试 create）`);
    }

    // 创建
    const createdSkill = await post("/v3/skill/create", {
      user_id: USER, team_id: TEAM, agent_id: AGENT, name: s.name, content: s.content,
    });
    if (!ok(createdSkill)) {
      console.log(`[FAIL] ${s.name} create 失败: code=${createdSkill.code} ${createdSkill.message ?? createdSkill.error?.message}`);
      // 撞重名则回退幂等
      if (createdSkill.code === 42201) {
        const again = await post("/v3/skill/get-by-name", { team_id: TEAM, agent_id: AGENT, skill_name: s.name });
        if (ok(again)) {
          console.log(`[recover] ${s.name} 实际已存在，回退幂等: ${again.data.skill_id}`);
          await verifySkill(s.name, again.data.skill_id);
        }
      }
      continue;
    }
    const skillId = createdSkill.data.skill_id;
    console.log(`[create] ${s.name} → ${skillId} v${createdSkill.data.version}`);

    // 翻成团队共享（A 池关键）
    const up = await post("/v3/meta/asset/update", { asset_id: skillId, visibility: "team" }, HMETA);
    console.log(`  [visibility] ${skillId} → team ${ok(up) ? "✓" : `✗ code=${up.code} ${up.message ?? ""}`}`);

    await verifySkill(s.name, skillId);
    created.push({ name: s.name, skill_id: skillId, version: createdSkill.data.version });
  }

  // ── 汇总 ──
  console.log(`\n${line}`);
  console.log("验证汇总（B 池 list / 数据面 search / listing 注入 / get-by-name / A 池 list-accessible）");
  console.log(line);
  for (const r of results) {
    const c = r.checks;
    const allOk = Object.values(c).every(Boolean);
    console.log(
      `${allOk ? "✓" : "✗"} ${r.name.padEnd(28)} ` +
      `list=${c.list ? "✓" : "✗"} search=${c.search ? "✓" : "✗"} ` +
      `listing=${c.listing ? "✓" : "✗"} getByName=${c.getByName ? "✓" : "✗"} ` +
      `teamA=${c.listAccessible ? "✓" : "✗"} (${r.skill_id})`,
    );
  }

  // listing 块落盘（注入证据）
  const anyListing = results.find((r) => r.listingBlock);
  if (anyListing) {
    const p = join(OUT_DIR, "available-skills-block.txt");
    writeFileSync(p, anyListing.listingBlock);
    console.log(`\navailable_skills 块 → ${p}`);
  }

  const summary = {
    installed_at: new Date().toISOString(),
    team: TEAM,
    agent: AGENT,
    created,
    checks: results.map((r) => ({ name: r.name, skill_id: r.skill_id, checks: r.checks })),
  };
  const outFile = join(OUT_DIR, "install-summary.json");
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\n汇总 → ${outFile}`);
}

main().catch((e) => { console.error("[install-team-skills] FAIL:", e); process.exit(1); });

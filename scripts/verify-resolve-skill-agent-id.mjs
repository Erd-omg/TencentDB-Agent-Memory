#!/usr/bin/env node
/**
 * verify-resolve-skill-agent-id.mjs — 锁定 resolveSkillAgentId 语义（design-156.md §15.5）。
 *
 * 背景：任务一 e2e 曾因 `--target team` 导入，使 skill 抽取的 agent_id 落到 userId 兜底、
 * 抽取走错 owner、`candidates=0`、recall=0。修复是「改用 --target agent」，但该坑
 * 未用测试锁定，易复发。
 *
 * 本脚本通过 tsx 动态 import `agents/asset-import.ts` 的导出，断言两个语义：
 *   1. target === 'agent' → 返回 agentId（skill 绑定 agent 维度，抽取正常）；
 *   2. target === 'team'   → 返回 userId（团队池兜底，属设计语义而非 bug）。
 *
 * 用法：node scripts/verify-resolve-skill-agent-id.mjs
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const tsx = join(ROOT, "MemoryProxy", "node_modules", ".bin", "tsx");

// 用 tsx 跑一段内联 TS，动态 import 并断言，避免 .mjs 直接 import .ts 的类型/运行时问题。
const inline = `
import { resolveSkillAgentId } from ${JSON.stringify(join(ROOT, "agents", "asset-import.ts"))};

const agentId = "agent-001";
const userId = "user-001";

const cases = [
  { target: "agent", expect: agentId, desc: "--target agent 应绑定 agent 维度" },
  { target: "team", expect: userId, desc: "--target team 应兜底 userId（设计语义）" },
];

let failed = 0;
for (const c of cases) {
  const got = resolveSkillAgentId({ teamId: "t1", agentId, userId, target: c.target });
  const ok = got === c.expect;
  console.log(\`  \${ok ? "✅" : "❌"} target=\${c.target} → \${got}（期望 \${c.expect}）\${ok ? "" : "  ← " + c.desc}\`);
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(\`\\n❌ \${failed} 个断言失败：resolveSkillAgentId 语义被破坏，skill 抽取可能再次 candidates=0。\`);
  process.exit(1);
}
console.log("\\n✅ resolveSkillAgentId 语义锁定：--target agent 绑定 agent、--target team 兜底 userId。");
`;

const r = spawnSync(tsx, ["-e", inline], { cwd: ROOT, encoding: "utf8" });
process.stdout.write(r.stdout ?? "");
if (r.stderr) process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);

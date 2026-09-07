/**
 * mem:finalize — 任务结束 git-diff 关联（真实代码修改 + 真实测试 → validated）。
 *
 * 用法：
 *   mem:finalize                                  → 按会话 task_id 查 config.finalize.taskRepos 定位仓库
 *   mem:finalize --repo <abs> [--test <cmd>]      → 显式指定仓库 / 测试命令（覆盖映射）
 *
 * 行为（detail 见 evidence/finalize.ts）：
 *   1. `git diff HEAD` 检测本仓库真实代码变更；无变更 → 诚实返回，不写 validated。
 *   2. 在仓库 cwd 跑配置/指定的测试命令，取**真实退出码**。
 *   3. token 相关度把本次 diff 归因到会话 used/selected 资产（证据记 hit tokens）。
 *   4. 测试通过（exit 0）→ 相关资产写 `validated` 事件，evidence 带
 *      test_result(真退出码) + code_diff(diff 摘要) + outcome —— 补齐
 *      asset → decision/change → outcome 的 change/outcome。测试未过不写。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getAssetEventRepo } from "../../db/assetEventRepo.js";
import { runTaskFinalize } from "../../evidence/finalize.js";
import { mdHeader, mdSection, mdBullet, mdBlank, mdFootnote, mdJoin } from "../md.js";

/** 解析显式参数：--repo <单token>、--test <到末尾>。 */
function parseArgs(args: string): { repo?: string; test?: string } {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const tokens = trimmed.split(/\s+/);
  let repo: string | undefined;
  let test: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--repo") {
      repo = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--test") {
      test = tokens.slice(i + 1).join(" ").trim();
      i = tokens.length; // test 取到末尾
    }
  }
  return { repo, test };
}

export async function executeFinalize(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const cfg = ctx.config.finalize;
  if (!cfg?.enabled) {
    const text = "⚠️ 任务结束归因（mem:finalize）未启用：请配置 `finalize.enabled: true`（并给本任务配 taskRepos）。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const si = ctx.sessionInfo ?? {};
  const pick = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const taskId = pick(si.task_id);
  const mapping = taskId ? cfg.taskRepos[taskId] : undefined;

  const { repo: repoArg, test: testArg } = parseArgs(ctx.args);
  const repo = repoArg ?? mapping?.repo;
  const testCmd = testArg ?? mapping?.test;

  if (!repo) {
    const text = "❌ 无法确定目标仓库。请用 `mem:finalize --repo <abs路径>` 显式指定，"
      + (taskId ? `或给 config.finalize.taskRepos 配置任务 ${taskId} 的 repo。` : "或在 config.finalize.taskRepos 配置当前任务的 repo。");
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }
  if (!testCmd) {
    const text = "❌ 缺少测试命令。请用 `mem:finalize --test <cmd>` 显式指定，或给映射配置 test。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const repoEvents = getAssetEventRepo();
  if (!repoEvents) {
    const text = "⚠️ 本地证据库不可用，无法写 validated 事件。";
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }

  const outcome = await runTaskFinalize({
    sessionKey: ctx.sessionKey,
    repo,
    testCmd,
    runnerLabel: mapping?.runnerLabel,
    timeoutMs: cfg.timeoutMs,
    sessionInfo: si,
    repoEvents,
  });

  // —— 输出（Markdown 统一版式；关键 token 保留供 verify-* grep）——
  const md: Array<string | undefined> = [
    mdHeader("⚙️", "任务结束归因（mem:finalize）"),
    mdBlank(),
    mdSection("仓库 / 变更"),
    mdBullet(`仓库：\`${outcome.repo}\``),
  ];
  if (!outcome.hasChange) {
    md.push(mdBullet(`⏭ 未写 validated：${outcome.reason ?? "无代码变更"}`));
    const text = mdJoin(md);
    return { success: false, messageText: text, response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
  }
  md.push(mdBullet(`变更：${outcome.diffStat?.split("\n").pop() ?? ""}`));
  if (typeof outcome.exitCode === "number") {
    md.push(mdBullet(`测试：\`${outcome.testCmd}\` → exit ${outcome.exitCode}${outcome.durationMs ? `（${outcome.durationMs}ms）` : ""}`));
  }
  md.push(mdBlank(), mdSection("归因（token 相关度，启发式非因果）"));
  if (outcome.correlated.length === 0) {
    md.push(mdBullet("本会话 used/selected 资产与本次 diff 无 token 共现，未写 validated（留 ⏳待验证）。"));
  } else if (outcome.exitCode === 0) {
    const nWrite = outcome.validatedAssetIds.length;
    const nWeak = outcome.weakRefusals.length;
    md.push(mdBullet(`相关 ${outcome.correlated.length} 项 → 写 validated ${nWrite} 项（真测试通过）${nWeak ? ` · 弱命中跳过 ${nWeak} 项` : ""}`));
    for (const c of outcome.correlated) {
      const weak = outcome.weakRefusals.find((w) => w.assetId === c.asset.assetId);
      if (weak) {
        md.push(mdBullet(`⏭ ${c.asset.name || c.asset.assetId}（${c.asset.assetType}）弱命中 → 跳过防摊分（${weak.reason}）`));
      } else {
        const anchor = c.pathHits.length > 0 ? "path" : (c.distinctiveHits.length > 0 ? "独有" : "普通");
        md.push(mdBullet(`✅ ${c.asset.name || c.asset.assetId}（${c.asset.assetType}）hits=[${c.hitTokens.join(",")}]（${anchor}锚点）`));
      }
    }
  } else {
    md.push(mdBullet(`⚠️ 测试未通过（exit ${outcome.exitCode}），相关 ${outcome.correlated.length} 项资产不写 validated。`));
  }
  const data: Record<string, unknown> = {
    repo: outcome.repo,
    has_change: outcome.hasChange,
    reason: outcome.reason ?? null,
    diff_stat: outcome.diffStat ?? null,
    test: outcome.testCmd ?? null,
    exit_code: outcome.exitCode ?? null,
    test_output: outcome.testOutput?.slice(0, 500) ?? null,
    duration_ms: outcome.durationMs ?? null,
    used_candidate_count: outcome.usedCandidateCount,
    correlated: outcome.correlated.map((c) => ({
      asset_id: c.asset.assetId,
      hits: c.hitTokens,
      path_hits: c.pathHits,
      distinctive_hits: c.distinctiveHits,
      shared_hits: c.sharedHits,
    })),
    weak_refusals: outcome.weakRefusals,
    validated: outcome.validatedAssetIds,
  };

  const messageText = mdJoin(md);
  return { success: true, messageText, data, response: buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }) };
}

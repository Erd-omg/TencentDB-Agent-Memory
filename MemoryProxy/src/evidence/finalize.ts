/**
 * 任务结束 git-diff 关联（`mem:finalize`，赛题任务三 C 补强）。
 *
 * 问题：used 事件目前只来自 bridge 工具动作（tool_call），缺 "asset → decision/change → outcome"
 * 的 change 与 outcome 字段；validated 也只验证"skill 正文格式"，从不对"目标仓库真实代码修改 +
 * 真实单测"负责。
 *
 * 本模块解决：给定一次真实 bug-fix 任务结束时的目标仓库，
 *   1. 抓真实代码变更：`git diff HEAD`（本仓库真实 diff，非标签）。
 *   2. 跑真实测试：在仓库 cwd 下执行配置的测试命令，取**真实退出码**。
 *   3. token 相关度归因：只把与本次 diff 文本/变更文件 token 共现的 used/selected 资产
 *      判 validated（不全会话摊分）；证据记录 hit tokens + correlation="token-overlap"。
 *   4. 测试通过（exit 0）→ 给相关资产写 `validated` 事件，evidence 带
 *      test_result（runner/exitCode/输出尾部）+ code_diff（diff 摘要）+ outcome。
 *      测试未过 → 不写 validated（诚实："有变更但未通过测试"不宣称验证有效）。
 *
 * 诚实边界：
 *   - 归因是启发式（token 共现），不是因果；未命中资产的 used 保持 ⏳待验证。
 *   - 无变更（git diff HEAD 为空）→ 直接返回，不写任何 validated。
 *   - 命令在配置/显式参数指定的仓库 cwd 下执行（mem: 命令为操作者触发，信任等同 mem:validate）。
 */

import { spawn } from "node:child_process";
import { getAssetEventRepo, type AssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEvent, AssetRef, AssetStageSummary } from "../db/asset-event.js";
import type { ProxyConfig } from "../types.js";

/** 命令输出尾部保留上限。 */
const OUTPUT_MAX_CHARS = 2000;
/** 存入 validated 事件 evidence.code_diff 的 diff 摘要上限。 */
const DIFF_EXCERPT_CHARS = 800;

export interface ExecResult {
  code: number;
  output: string;
}
/** 可注入的命令执行器（单测用）；缺省走真实 spawn。 */
export type ExecFn = (command: string, cwd: string, timeoutMs: number) => Promise<ExecResult>;

/** 真实执行一条命令（shell + 进程组超时 kill + 尾部截断，姿势对齐 command-runner）。 */
export async function runInRepo(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, detached: true });
    let out = "";
    const append = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      if (out.length > OUTPUT_MAX_CHARS * 4) out = out.slice(-OUTPUT_MAX_CHARS * 4);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: out || `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: out.slice(-OUTPUT_MAX_CHARS) });
    });
  });
}

/**
 * 文本分 token（相关性用）。拉丁词按 [a-z0-9] 拆（files/migration 等），
 * 中文连续串整体作一个 token；去重、≥2 字符才保留。
 */
export function tokenizeText(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const latin = lower.match(/[a-z0-9][a-z0-9_./-]*/g) ?? [];
  const cjk = lower.match(/[一-鿿]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const t of latin) {
    for (const sub of t.split(/[^a-z0-9]+/)) {
      if (sub.length >= 2) tokens.add(sub);
    }
  }
  for (const c of cjk) tokens.add(c);
  return [...tokens];
}

export interface CorrelatedAsset {
  asset: AssetRef;
  /** 命中的 token（证据里记录，说明"为何把验证归到它"）。 */
  hitTokens: string[];
}

/**
 * token 相关度归因（纯函数）：对会话内 **已使用(used)** 资产，取 name/assetId 的 token
 * 与 diff 文本的共现；共现数 ≥ minMatches 判"相关"。可经 extraText 补充资产描述/正文 token。
 *
 * 只认 used（定向读取/使用过），不认仅 selected —— 否则"被推荐但没打开"的资产也会被
 * 写 validated，触发 F4「validated 无 used」链错误（过度归因）。已 corrected 的跳过。
 */
export function correlateAssets(
  summaries: AssetStageSummary[],
  diffText: string,
  opts: { minMatches?: number; extraText?: Record<string, string> } = {},
): CorrelatedAsset[] {
  const { minMatches = 1, extraText } = opts;
  const diffTokens = new Set(tokenizeText(diffText));
  const out: CorrelatedAsset[] = [];
  for (const s of summaries) {
    if (!s.stages.includes("used")) continue;
    // 已纠正的资产不再参与重新归因（纠正已否定它）。
    if (s.stages.includes("corrected")) continue;
    const id = s.asset.assetId;
    const base = [s.asset.name ?? "", extraText?.[id] ?? ""].join(" ");
    const hitTokens = [...new Set(tokenizeText(base))].filter((t) => diffTokens.has(t));
    if (hitTokens.length >= minMatches) {
      out.push({ asset: s.asset, hitTokens });
    }
  }
  return out;
}

function pick(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export interface TaskFinalizeArgs {
  sessionKey: string;
  /** 目标仓库绝对路径（独立 git 仓库）。 */
  repo: string;
  /** 在仓库 cwd 下执行的测试命令（如 "node --test"）。 */
  testCmd: string;
  /** evidence.test_result.runner 标签（缺省用 testCmd）。 */
  runnerLabel?: string;
  timeoutMs?: number;
  sessionInfo?: Record<string, unknown>;
  /** 可注入 repo/exec（单测）。 */
  repoEvents?: AssetEventRepo | null;
  exec?: ExecFn;
  /** 相关度阈值（默认 1）。 */
  minMatches?: number;
}

export interface TaskFinalizeOutcome {
  repo: string;
  /** git diff HEAD 是否有跟踪文件变更。 */
  hasChange: boolean;
  /** 未执行/异常原因。 */
  reason?: string;
  diffStat?: string;
  /** 存入证据的 diff 摘要（真实 diff 头 + 首 hunks）。 */
  diffExcerpt?: string;
  testCmd?: string;
  exitCode?: number | null;
  testOutput?: string;
  durationMs?: number;
  /** 归因到的相关资产。 */
  correlated: CorrelatedAsset[];
  /** 实际写了 validated 事件的资产 id（测试 exit 0 的相关资产）。 */
  validatedAssetIds: string[];
}

/**
 * 执行一次任务结束归因（幂等调用方控制；同一会话可重跑——多写一条 validated 无害）。
 */
export async function runTaskFinalize(args: TaskFinalizeArgs): Promise<TaskFinalizeOutcome> {
  const repoEvents = args.repoEvents !== undefined ? args.repoEvents : getAssetEventRepo();
  const exec = args.exec ?? runInRepo;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const outcome: TaskFinalizeOutcome = {
    repo: args.repo,
    hasChange: false,
    correlated: [],
    validatedAssetIds: [],
  };

  // 1) 变更检测：git status + diff HEAD。diff 为空 → 无变更可归因。
  const stat = await exec("git status --porcelain", args.repo, 15_000);
  const diffStatRes = await exec("git diff HEAD --stat", args.repo, 15_000);
  if (!diffStatRes.output.trim()) {
    outcome.reason = stat.output.trim()
      ? "仓库仅有未跟踪(untracked)文件，无相对 HEAD 的已跟踪变更"
      : "仓库无相对 HEAD 的代码变更，无 change 可归因";
    return outcome;
  }
  outcome.hasChange = true;
  outcome.diffStat = diffStatRes.output.trim();

  // 2) 抓真实 diff（含变更文件路径与 hunks）。
  const diffRes = await exec("git diff HEAD", args.repo, 20_000);
  const diffText = diffRes.output;
  outcome.diffExcerpt = diffText.slice(0, DIFF_EXCERPT_CHARS);

  // 3) 跑真实测试（仓库 cwd）。
  const t0 = Date.now();
  const testRes = await exec(args.testCmd, args.repo, timeoutMs);
  outcome.testCmd = args.testCmd;
  outcome.exitCode = testRes.code;
  outcome.testOutput = testRes.output.trim();
  outcome.durationMs = Date.now() - t0;

  // 4) token 相关度归因（只对 used/selected 资产）。
  const summaries = repoEvents ? repoEvents.distinctAssets(args.sessionKey) : [];
  outcome.correlated = correlateAssets(summaries, [diffStatRes.output, diffText].join("\n"), {
    minMatches: args.minMatches ?? 1,
  });

  // 5) 测试通过 → 给相关资产写 validated（带 code_diff/outcome/test_result）。
  if (testRes.code === 0) {
    if (repoEvents) {
      const si = args.sessionInfo ?? {};
      for (const c of outcome.correlated) {
        const ev: AssetEvent["evidence"] = {
          test_result: {
            runner: args.runnerLabel ?? args.testCmd,
            command: args.testCmd,
            exitCode: testRes.code,
            output: testRes.output.trim().slice(-OUTPUT_MAX_CHARS),
            durationMs: outcome.durationMs,
          },
          code_diff: outcome.diffExcerpt,
          outcome: `目标仓库真实测试通过（exit 0）· ${testOutcomeSummary(testRes.output)}`,
          validator: {
            id: "task-git-diff-finalize",
            pass: true,
            detail: `correlation=token-overlap hits=[${c.hitTokens.join(",")}]`,
          },
        };
        try {
          repoEvents.insert(repoEvents.newEvent({
            stage: "validated",
            asset: c.asset,
            sessionKey: args.sessionKey,
            sessionId: pick(si.session_id),
            taskId: pick(si.task_id),
            agentId: pick(si.agent_id),
            teamId: pick(si.team_id),
            userId: pick(si.user_id),
            evidence: ev,
          }));
          outcome.validatedAssetIds.push(c.asset.assetId);
        } catch (err) {
          // 单条失败不阻断
          console.warn(`[finalize] validated insert failed (${c.asset.assetId}): ${(err as Error).message}`);
        }
      }
    }
  }

  return outcome;
}

/**
 * 从测试输出提一行可读摘要：优先 `# pass N` / `# fail N`（node --test / vitest TAP 尾部），
 * 否则取首行。回执 outcome 用，避免整屏 TAP。
 */
function testOutcomeSummary(output: string): string {
  if (!output) return "全部用例通过";
  const counts = output.match(/#\s*(pass|fail)\s+\d+/gi);
  if (counts && counts.length > 0) {
    return counts.map((s) => s.replace(/^#\s*/, "").trim()).join(" · ");
  }
  const line = output.split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, 120) : "全部用例通过";
}

/**
 * 任务收尾自动 finalize（fire-and-forget，非阻塞）。仅当 config.finalize.autoOnCompletion
 * 且本会话 task_id 在 taskRepos 有映射时运行；任何失败只记日志。
 */
export function maybeRunAutoFinalize(
  sessionKey: string,
  sessionInfo: Record<string, unknown>,
  config: ProxyConfig,
): void {
  try {
    const cfg = config.finalize;
    if (!cfg?.enabled || !cfg.autoOnCompletion) return;
    const taskId = pick(sessionInfo.task_id);
    const tr = taskId ? cfg.taskRepos[taskId] : undefined;
    if (!tr) return;
    void runTaskFinalize({
      sessionKey,
      repo: tr.repo,
      testCmd: tr.test,
      runnerLabel: tr.runnerLabel,
      timeoutMs: cfg.timeoutMs,
      sessionInfo,
    })
      .then((o) => {
        console.log(
          `[finalize] auto task=${taskId} change=${o.hasChange} correlated=${o.correlated.length} `
          + `validated=${o.validatedAssetIds.length} exit=${o.exitCode ?? "-"}${o.reason ? ` reason=${o.reason}` : ""}`,
        );
      })
      .catch((err: unknown) => {
        console.warn(`[finalize] auto task=${taskId} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  } catch (err) {
    console.warn(`[finalize] auto hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 任务结束 git-diff 关联（`mem:finalize`，赛题任务三 C 补强）。
 *
 * 问题：used 事件目前只来自 bridge 工具动作（tool_call），缺 "asset → decision/change → outcome"
 * 的 change 与 outcome 字段；validated 也只验证"skill 正文格式"，从不对"目标仓库真实代码修改 +
 * 真实单测"负责。
 *
 * 本模块解决：给定一次真实 bug-fix 任务结束时的目标仓库，
 *   1. 抓真实代码变更：`git diff <base>`（缺省防御链 base→HEAD→HEAD~1，含"最近一次 commit
 *      vs 上一次"兜底，解决会话中途已提交致 `git diff HEAD` 为空的问题）。
 *   2. 跑真实测试：在仓库 cwd 下执行配置的测试命令，取**真实退出码**。
 *   3. token 相关度归因：只把与本次 diff 文本/变更文件 token 共现的 used/selected 资产
 *      判 validated（不全会话摊分）；证据记录结构化 correlation{hits,pathHits,distinctiveHits,sharedHits}。
 *      归因 token 集 = 资产 name + **资产正文/摘要**（defaultAssetTextLoader 经 getSkill 取
 *      content+description），降低非命名文本资产（非代码/纯约束资产）被低估。
 *   4. 测试通过（exit 0）→ 给相关资产写 `validated` 事件，evidence 带
 *      test_result（runner/exitCode/输出尾部）+ code_diff（diff 摘要）+ outcome + correlation。
 *      测试未过 → 不写 validated（诚实："有变更但未通过测试"不宣称验证有效）。
 *
 * 诚实边界（2026-09 边界硬化，防"大 diff / 多资产把 validated 摊到未实际使用的资产"）：
 *   - 归因是启发式（token 共现），不是因果证明；证据带 correlation 可审计，回执展示 token-overlap。
 *   - 只判本会话 used 资产（used 前置）；仅 selected / 仅 opened（无引用锚点）/ 已 corrected
 *     一律跳过，防伪证（P0-1：打开 ≠ 采纳）。
 *   - used 语义收紧（P0-1）：used 由「写操作」直接产生，或由「opened + diff 引用锚点」
 *     在 finalize 阶段升级（见 effectiveUsedCandidates / 4b 补写 used 事件）。
 *   - 保守写判据：单候选 ≥1 命中；**多 used 候选**需「独有 token ∪ 变更文件路径 token」≥1，
 *     或 ≥2 个普通共享命中 —— 仅共享泛化词且无路径锚点 = 弱命中，不写 validated（CLI 报原因）。
 *   - 无变更（所选基准 diff 为空，含 HEAD 与 HEAD~1 兜底均空）→ 直接返回，不写任何 validated。
 *   - 命令在配置/显式参数指定的仓库 cwd 下执行（mem: 命令为操作者触发，信任等同 mem:validate）。
 */

import { spawn } from "node:child_process";
import { getCoreSkillClient } from "../skill/core-client.js";
import { getAssetEventRepo, type AssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetEvent, AssetRef, AssetStageSummary } from "../db/asset-event.js";
import type { ProxyConfig } from "../types.js";
import { extractCitationAnchors } from "./used-evidence.js";

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

/**
 * 资产正文/摘要加载器（归因 token 集扩充用）—— 单测可注入 fake。
 * 给定一个 used 候选资产，返回要并入 token 集的正文/摘要文本；返回 undefined
 * 表示"取不到/不支持该类型"，此时归因静默退化为 name-only（= 原行为，绝不阻断）。
 */
export type AssetTextLoader = (
  asset: AssetRef,
  ctx: { sessionInfo: Record<string, unknown>; config: ProxyConfig },
) => Promise<string | undefined>;

/**
 * 默认正文加载器：skill 类型经 core /v3/skill/get（include_content）取正文+摘要。
 * 对齐 run-validation.loadAssetContent，额外把 description 一起并入（正文+摘要两组 token）。
 * 缺 team/agent 身份、非 skill、或任何异常 → undefined（静默降级，绝不 throw）。
 */
export async function defaultAssetTextLoader(
  asset: AssetRef,
  ctx: { sessionInfo: Record<string, unknown>; config: ProxyConfig },
): Promise<string | undefined> {
  if (asset.assetType !== "skill") return undefined;
  const teamId = pick(ctx.sessionInfo.team_id);
  const agentId = pick(ctx.sessionInfo.agent_id);
  const spaceId = pick(ctx.sessionInfo.space_id);
  if (!teamId || !agentId) return undefined;
  try {
    const client = getCoreSkillClient(ctx.config.coreSkill);
    const detail = await client.getSkill(
      {
        team_id: teamId,
        agent_id: agentId,
        skill_id: asset.assetId,
        include_content: true,
      },
      spaceId ? { serviceId: spaceId } : {},
    );
    const body = `${detail.content ?? ""} ${detail.description ?? ""}`.trim();
    return body || undefined;
  } catch {
    return undefined;
  }
}

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
  /** 命中的 token（全量：name token ∩ diff token）。证据里记录，说明"为何把验证归到它"。 */
  hitTokens: string[];
  /** 命中中属于变更文件路径 token 的（diff 真实动了与该资产同名域的某文件）——强锚点。 */
  pathHits: string[];
  /** 命中中仅本候选名独有（未出现在其它 used&!corrected 候选名）——可单独归因的独有词。 */
  distinctiveHits: string[];
  /** 命中中与其它候选共享、且非路径锚点的泛化词（弱命中来源，多候选下不能仅凭它判）。 */
  sharedHits: string[];
}

/**
 * 从 diff 输出提取**变更文件路径 token**（强锚点）。
 * 识别 `diff --git a/… b/…` / `--- a/…` / `+++ b/…` 头，与 --stat 的 `path | N` 行。
 * 纯函数，供单测直接断言。
 */
export function pathTokensFromDiff(diffText: string): Set<string> {
  const paths: string[] = [];
  for (const line of (diffText ?? "").split("\n")) {
    const git = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (git) { paths.push(git[1], git[2]); continue; }
    const minus = line.match(/^--- a\/(\S+)/);
    if (minus) { paths.push(minus[1]); continue; }
    const plus = line.match(/^\+\+\+ b\/(\S+)/);
    if (plus) { paths.push(plus[1]); continue; }
    const stat = line.match(/^\s*(\S+)\s+\|/);
    if (stat && !/\bfile changed\b/.test(line)) paths.push(stat[1]);
  }
  const out = new Set<string>();
  for (const p of paths) for (const t of tokenizeText(p)) out.add(t);
  return out;
}

/**
 * 保守写判据（纯函数）：给定一个全命中的相关资产，判断是否值得写 validated。
 *  - 单 used 候选：语义不变（≥ minMatches 即写，没有别的资产可摊分）。
 *  - 多 used 候选（评审关注的大 diff / 多资产摊分场景）：
 *      「独有 token ∪ 变更文件路径 token」≥1 → 可归因，写；
 *      否则普通共享命中 ≥ max(minMatches, 2)（≥2 个独立共现佐证）→ 写；
 *      仅 1 个共享泛化词且无锚点 → 弱命中，不写（防把 validated 摊给未实际使用的资产）。
 */
export interface CorrelationWriteContext {
  /** 本会话 used 且未 corrected 的候选总数（共享集在其上算）。 */
  usedCandidateCount: number;
  minMatches: number;
}
export function decideCorrelationWrite(
  c: CorrelatedAsset,
  ctx: CorrelationWriteContext,
): { write: boolean; reason?: string } {
  const { usedCandidateCount, minMatches } = ctx;
  if (usedCandidateCount <= 1) {
    if (c.hitTokens.length >= minMatches) return { write: true };
    return { write: false, reason: `命中 ${c.hitTokens.length} < minMatches ${minMatches}` };
  }
  if (c.distinctiveHits.length + c.pathHits.length >= 1) return { write: true };
  if (c.sharedHits.length >= Math.max(minMatches, 2)) return { write: true };
  return {
    write: false,
    reason: `弱命中：仅 ${c.sharedHits.length} 个共享泛化词（与其它 ${usedCandidateCount - 1} 个 used 资产共享）且无独有/变更文件锚点 → 跳过防摊分`,
  };
}

/**
 * 判定一条资产是否"实际 used"（P0-1 语义收紧后的前置）：
 *   - 直接 used（写操作 / 已带引用锚点的 used 事件）→ true；
 *   - 仅 opened（定向读取）→ 需在 diff 文本中出现引用锚点（资产名 token 共现），
 *     证明模型在最终代码变更里"点名/采用了"该资产 —— 这才是"读了并照做"。
 *   - corrected → false（被纠正的不参与归因）。
 *
 * 纯函数，不写事件；返回 used 资产列表 + opened 但无引用锚点、被排除的资产列表
 * （供 weakRefusals 诚实披露"打开过但没引用，不判 validated"）。
 */
export function effectiveUsedCandidates(
  summaries: AssetStageSummary[],
  diffText: string,
): { used: AssetStageSummary[]; openedUncited: AssetStageSummary[] } {
  const used: AssetStageSummary[] = [];
  const openedUncited: AssetStageSummary[] = [];
  for (const s of summaries) {
    if (s.stages.includes("corrected")) continue;
    if (s.stages.includes("used")) {
      used.push(s);
      continue;
    }
    if (s.stages.includes("opened")) {
      const anchors = extractCitationAnchors(s.asset.name, diffText, 1);
      if (anchors.length > 0) {
        // opened + diff 引用锚点 → 升级为 used（引用锚点 = 独立于"打开"的采纳信号）。
        used.push(s);
      } else {
        openedUncited.push(s);
      }
    }
  }
  return { used, openedUncited };
}

/**
 * token 相关度归因（纯函数）：对会话内 **实际使用(used)** 资产，取 name/assetId 的 token
 * 与 diff 文本的共现；共现数 ≥ minMatches 判"相关"。可经 extraText 补充资产描述/正文 token。
 *
 * P0-1 收紧：归因候选 = `used` 或 `opened + diff 引用锚点`（见 effectiveUsedCandidates），
 * 不认仅 selected / 仅 opened（无引用锚点）—— 否则"被打开但没采纳"的资产也会被
 * 写 validated，触发 F4「validated 无 used」链错误（过度归因）。已 corrected 的跳过。
 *
 * 返回语义 = 全命中 ≥ minMatches 的相关资产（并携带 path/distinctive/shared 桶，
 * 供 decideCorrelationWrite 做保守写判定）；本函数不改判定、不写事件。
 */
export function correlateAssets(
  summaries: AssetStageSummary[],
  diffText: string,
  opts: { minMatches?: number; extraText?: Record<string, string> } = {},
): CorrelatedAsset[] {
  const { minMatches = 1, extraText } = opts;
  const diffTokens = new Set(tokenizeText(diffText));
  const pathTokens = pathTokensFromDiff(diffText);
  // 归因候选 = 本会话实际 used（含 opened+引用锚点升级）且未 corrected 的资产。
  const { used: usedCandidates } = effectiveUsedCandidates(summaries, diffText);
  const candidates = usedCandidates;
  // 共享集 = 出现在 ≥2 个候选 name token 集里的 token（多个 used 资产都有的词，
  // 单独出现时无法证明归给谁）。即使某候选零命中，它的名字也参与共享集（共享是"名里有"）。
  const tokenOwners = new Map<string, number>();
  for (const s of candidates) {
    const id = s.asset.assetId;
    const base = [s.asset.name ?? "", extraText?.[id] ?? ""].join(" ");
    for (const t of new Set(tokenizeText(base))) tokenOwners.set(t, (tokenOwners.get(t) ?? 0) + 1);
  }
  const sharedSet = new Set([...tokenOwners].filter(([, n]) => n >= 2).map(([t]) => t));

  const out: CorrelatedAsset[] = [];
  for (const s of candidates) {
    const id = s.asset.assetId;
    const base = [s.asset.name ?? "", extraText?.[id] ?? ""].join(" ");
    const hitTokens = [...new Set(tokenizeText(base))].filter((t) => diffTokens.has(t));
    if (hitTokens.length < minMatches) continue;
    out.push({
      asset: s.asset,
      hitTokens,
      pathHits: hitTokens.filter((t) => pathTokens.has(t)),
      distinctiveHits: hitTokens.filter((t) => !sharedSet.has(t)),
      sharedHits: hitTokens.filter((t) => sharedSet.has(t) && !pathTokens.has(t)),
    });
  }
  return out;
}

function pick(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * git 输出里是否包含诊断错误（坏 ref / 无法解析的提交）。
 * 因为 runInRepo 把 stderr 合并进 output（见 runInRepo），`git diff <坏ref> --stat`
 * 的 fatal 会出现在 output 里，单靠 `output.trim()` 会把错误误判成"有变更"。
 * 此正则仅作**拒绝候选**用（配合 code !== 0 双保险），绝不用于"判定有变更"。
 */
export function isGitError(output: string): boolean {
  return /\b(fatal|error|ambiguous argument|unknown revision|bad revision)\b/i.test(output ?? "");
}

/** selectDiffRef 探测一个候选 ref：stat 与 diff 命令共用同一基准（防 stat/diff 错配）。 */
interface DiffRefCandidate {
  label: string;
  statCmd: string;
  diffCmd: string;
}

/**
 * 变更探测（纯辅助，注入 exec 便于单测）：按防御链从必选基准序列里取**第一个有效变更**。
 *
 * 序列（用户确认"防御链"语义）：
 *   ① 显式 base（如 origin/main）—— 配置/传入则先探
 *   ② git diff HEAD —— 工作区 vs 最后提交
 *   ③ git diff HEAD~1 HEAD —— "最近一次 commit vs 上一次"（会话中途已提交、工作区已清 → 兜底）
 *
 * 每个候选以 `--stat` 探测：output 非空 且（code === 0 或 output 非 git 错误）→ 判为有效，
 * 返回该候选的 {label, statCmd, diffCmd}；`--stat` 为空/无效则探测下一个。
 * 全部无效 → 返回 { hasChange: false, reason }（reason 沿用 status 区分"仅未跟踪/无变更"）。
 *
 * 保证：为保住既有 e2e 的精确调用顺序，**无 base 且 HEAD 非空时只调 `git diff HEAD`（单 ref），
 * 不额外探测 HEAD~1**；HEAD 候选用单 ref 字面串（`git diff HEAD --stat`），HEAD~1 用双 ref 形式。
 */
export async function selectDiffRef(
  exec: ExecFn,
  repo: string,
  base: string | undefined,
  statusOutput: string,
): Promise<{ hasChange: true; label: string; statCmd: string; diffCmd: string; diffStat: string }
  | { hasChange: false; reason: string }> {
  const candidates: DiffRefCandidate[] = [];
  if (base) candidates.push({ label: base, statCmd: `git diff ${base} --stat`, diffCmd: `git diff ${base}` });
  candidates.push({ label: "HEAD", statCmd: "git diff HEAD --stat", diffCmd: "git diff HEAD" });
  candidates.push({ label: "HEAD~1", statCmd: "git diff HEAD~1 HEAD --stat", diffCmd: "git diff HEAD~1 HEAD" });

  for (const c of candidates) {
    const res = await exec(c.statCmd, repo, 15_000);
    const out = res.output.trim();
    // 候选有效性：code !== 0（git 对坏 ref 返回 128）或输出含 git 诊断错误 → 拒绝，试下一个。
    if (res.code !== 0 || isGitError(out)) continue;
    if (!out) continue; // 该基准无变更 → 试下一个
    return { hasChange: true, label: c.label, statCmd: c.statCmd, diffCmd: c.diffCmd, diffStat: out };
  }

  // 无候选命中 → 无变更。reason 沿用原文案（无 base 时保留"相对 HEAD"，保住既有测试/锚点）。
  const baseRef = base ? "选定基准" : "HEAD";
  return {
    hasChange: false,
    reason: statusOutput.trim()
      ? `仓库仅有未跟踪(untracked)文件，无相对 ${baseRef} 的已跟踪变更`
      : `仓库无相对 ${baseRef} 的代码变更，无 change 可归因`,
  };
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
  /**
   * git diff 基准（显式 ref，如 "origin/main" / "HEAD~3"）。缺省走防御链 base→HEAD→HEAD~1。
   * 见 selectDiffRef。
   */
  diffBase?: string;
  /** 资产正文/摘要加载器（扩充归因 token 集）。缺省走 defaultAssetTextLoader（skill 正文+摘要）。 */
  loadAssetText?: AssetTextLoader;
  /** 会话配置（defaultAssetTextLoader 取 coreSkill 客户端用）。 */
  config?: ProxyConfig;
}

export interface TaskFinalizeOutcome {
  repo: string;
  /** git diff 是否有跟踪文件变更（相对最终选定的 base/HEAD/HEAD~1）。 */
  hasChange: boolean;
  /** 未执行/异常原因。 */
  reason?: string;
  /** 实际用于 diff 的基准标签（"HEAD" / "HEAD~1" / 自定义 base），审计用。 */
  diffBase?: string;
  diffStat?: string;
  /** 存入证据的 diff 摘要（真实 diff 头 + 首 hunks）。 */
  diffExcerpt?: string;
  testCmd?: string;
  exitCode?: number | null;
  testOutput?: string;
  durationMs?: number;
  /** 归因候选（本会话 used 且未 corrected）总数——写判据用它区分单/多候选。 */
  usedCandidateCount: number;
  /** 归因到的相关资产（全命中 ≥ minMatches；是否真写 validated 看 decideCorrelationWrite）。 */
  correlated: CorrelatedAsset[];
  /** 相关但判"弱命中"未写 validated 的资产（评审可见：为什么没把验证归给它们）。 */
  weakRefusals: Array<{ assetId: string; name?: string; reason?: string }>;
  /** 实际写了 validated 事件的资产 id（测试 exit 0 且通过保守写判据的相关资产）。 */
  validatedAssetIds: string[];
  /** 实际写了 contributed 事件的资产 id（validated 写成功的同一批，证据链终点）。 */
  contributedAssetIds: string[];
}

/**
 * 执行一次任务结束归因（幂等调用方控制；同一会话可重跑——多写一条 validated 无害）。
 */
export async function runTaskFinalize(args: TaskFinalizeArgs): Promise<TaskFinalizeOutcome> {
  const repoEvents = args.repoEvents !== undefined ? args.repoEvents : getAssetEventRepo();
  const exec = args.exec ?? runInRepo;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const loadAssetText = args.loadAssetText ?? defaultAssetTextLoader;
  const outcome: TaskFinalizeOutcome = {
    repo: args.repo,
    hasChange: false,
    correlated: [],
    usedCandidateCount: 0,
    weakRefusals: [],
    validatedAssetIds: [],
    contributedAssetIds: [],
  };

  // 1) 变更检测：git status + 防御链选基准（base→HEAD→HEAD~1）。无变更 → 无可归因，早退。
  const stat = await exec("git status --porcelain", args.repo, 15_000);
  const sel = await selectDiffRef(exec, args.repo, args.diffBase, stat.output);
  if (!sel.hasChange) {
    outcome.reason = sel.reason;
    return outcome;
  }
  outcome.hasChange = true;
  outcome.diffBase = sel.label === "HEAD" ? undefined : sel.label;
  outcome.diffStat = sel.diffStat;

  // 2) 抓真实 diff（与 stat 同一基准；含变更文件路径与 hunks）。
  const diffRes = await exec(sel.diffCmd, args.repo, 20_000);
  const diffText = diffRes.output;
  outcome.diffExcerpt = diffText.slice(0, DIFF_EXCERPT_CHARS);

  // 3) 跑真实测试（仓库 cwd）。
  const t0 = Date.now();
  const testRes = await exec(args.testCmd, args.repo, timeoutMs);
  outcome.testCmd = args.testCmd;
  outcome.exitCode = testRes.code;
  outcome.testOutput = testRes.output.trim();
  outcome.durationMs = Date.now() - t0;

  // 4) token 相关度归因（只对实际 used 资产，含 opened+diff 引用锚点升级）。
  const summaries = repoEvents ? repoEvents.distinctAssets(args.sessionKey) : [];
  const diffForAttribution = [sel.diffStat, diffText].join("\n");
  const { used: effectiveUsed, openedUncited } = effectiveUsedCandidates(summaries, diffForAttribution);
  outcome.usedCandidateCount = effectiveUsed.length;
  // 诚实披露：打开过但在最终变更中无引用锚点的资产，不升级为 used（不判 validated）。
  for (const s of openedUncited) {
    outcome.weakRefusals.push({
      assetId: s.asset.assetId,
      name: s.asset.name,
      reason: "打开(opened)但最终代码变更中无引用锚点，未升级为 used（打开 ≠ 采纳）",
    });
  }
  // 资产正文/摘要并入 token 集（非命名文本资产补强）：对实际 used 候选逐个加载，
  // 各自容错（Promise.allSettled）；取不到则跳过，静默退化为 name-only（= 原行为）。
  let extraText: Record<string, string> | undefined;
  if (args.config && loadAssetText) {
    const si = args.sessionInfo ?? {};
    const candidateIds = effectiveUsed.map((s) => s.asset);
    const settled = await Promise.allSettled(candidateIds.map((a) => loadAssetText(a, { sessionInfo: si, config: args.config! })));
    const acc: Record<string, string> = {};
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) acc[candidateIds[i].assetId] = r.value;
    });
    if (Object.keys(acc).length > 0) extraText = acc;
  }
  outcome.correlated = correlateAssets(summaries, diffForAttribution, {
    minMatches: args.minMatches ?? 1,
    ...(extraText ? { extraText } : {}),
  });
  const minMatches = args.minMatches ?? 1;

  // 4b) 对「opened → used 升级」的资产补写 used 事件（带引用锚点 citation），
  //     使证据链闭合：validated 的前置必须是 used，而 used 现在有独立于"打开"的信号。
  if (repoEvents) {
    const siForUpgrade = args.sessionInfo ?? {};
    for (const s of effectiveUsed) {
      if (s.stages.includes("used")) continue; // 已是 used（写操作），无需补
      const anchors = extractCitationAnchors(s.asset.name, diffForAttribution, 1);
      if (anchors.length === 0) continue;
      repoEvents.insert(repoEvents.newEvent({
        stage: "used",
        asset: s.asset,
        sessionKey: args.sessionKey,
        sessionId: pick(siForUpgrade.session_id),
        taskId: pick(siForUpgrade.task_id),
        agentId: pick(siForUpgrade.agent_id),
        teamId: pick(siForUpgrade.team_id),
        userId: pick(siForUpgrade.user_id),
        evidence: {
          citation: { origin: "diff", anchors },
        },
      }));
    }
  }

  // 5) 测试通过 → 相关资产套**保守写判据**写 validated（带 correlation/code_diff/outcome/test_result）。
  //    判"弱命中"的进 weakRefusals 不写 —— 防大 diff/多 used 资产把验证摊给未实际使用的资产。
  if (testRes.code === 0) {
    if (repoEvents) {
      const si = args.sessionInfo ?? {};
      for (const c of outcome.correlated) {
        const dec = decideCorrelationWrite(c, { usedCandidateCount: outcome.usedCandidateCount, minMatches });
        if (!dec.write) {
          outcome.weakRefusals.push({
            assetId: c.asset.assetId,
            name: c.asset.name,
            reason: dec.reason ?? "weak match",
          });
          continue;
        }
        const correlation: NonNullable<NonNullable<AssetEvent["evidence"]>["correlation"]> = {
          type: "token-overlap",
          heuristic: true,
          hits: c.hitTokens,
          pathHits: c.pathHits,
          distinctiveHits: c.distinctiveHits,
          sharedHits: c.sharedHits,
        };
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
            detail: `correlation=token-overlap hits=[${c.hitTokens.join(",")}]`
              + (c.pathHits.length ? ` path=[${c.pathHits.join(",")}]` : ""),
          },
          correlation,
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
          // 证据链终点（任务五 §5.1）：validated 写成功后，同一资产追加 contributed。
          // 严格判据已由 decideCorrelationWrite 保证（used 前置 + 独有/路径/共享锚点 ≥ 阈值），
          // 且本循环只在 exit 0 分支内 → contributed 只在「真测试通过 + 通过保守归因」时写入。
          repoEvents.insert(repoEvents.newEvent({
            stage: "contributed",
            asset: c.asset,
            sessionKey: args.sessionKey,
            sessionId: pick(si.session_id),
            taskId: pick(si.task_id),
            agentId: pick(si.agent_id),
            teamId: pick(si.team_id),
            userId: pick(si.user_id),
            evidence: {
              outcome: `资产对本任务产生可验证贡献（测试 exit 0 + 保守归因通过）`,
              test_result: ev.test_result,
              code_diff: ev.code_diff,
              validator: {
                id: "task-contributed",
                pass: true,
                detail: `used→validated→contributed 链闭合（correlation=token-overlap）`,
              },
              correlation,
            },
          }));
          outcome.contributedAssetIds.push(c.asset.assetId);
        } catch (err) {
          // 单条失败不阻断
          console.warn(`[finalize] validated/contributed insert failed (${c.asset.assetId}): ${(err as Error).message}`);
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
      config,
      diffBase: tr.diffBase,
    })
      .then((o) => {
        console.log(
          `[finalize] auto task=${taskId} change=${o.hasChange} correlated=${o.correlated.length} `
          + `validated=${o.validatedAssetIds.length} contributed=${o.contributedAssetIds.length} `
          + `exit=${o.exitCode ?? "-"}${o.reason ? ` reason=${o.reason}` : ""}`,
        );
      })
      .catch((err: unknown) => {
        console.warn(`[finalize] auto task=${taskId} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  } catch (err) {
    console.warn(`[finalize] auto hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

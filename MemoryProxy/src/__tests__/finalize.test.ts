/**
 * 任务结束 git-diff 关联（mem:finalize）—— 单测。
 *
 * 覆盖：
 *   - tokenizeText / correlateAssets（token 相关度归因：used/selected 才可判；
 *     corrected 跳过；未共现不判）
 *   - runTaskFinalize 端到端（注入 fake exec + 临时 sqlite 证据库）：
 *       有变更 + 测试 exit 0 → 给相关资产写 validated（code_diff/outcome/test_result 真退出码）；
 *       测试非 0 → 不写；无变更 → 不跑测试、不写。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tokenizeText,
  correlateAssets,
  pathTokensFromDiff,
  decideCorrelationWrite,
  runTaskFinalize,
  type ExecResult,
  type ExecFn,
  type CorrelatedAsset,
} from "../evidence/finalize.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { AssetEventStage } from "../db/asset-event.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "finalize-test-"));
  process.env.PROXY_DB_PATH = join(tmpDir, "proxy.db");
  __resetAssetEventRepoForTests();
  __resetDbForTests();
});

afterEach(() => {
  __resetAssetEventRepoForTests();
  __resetDbForTests();
  delete process.env.PROXY_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SESSION = "sess-finalize";
const REPO = "/tmp/fake-migration-tool";

const DIFF_TEXT = [
  "diff --git a/src/windows-migration.js b/src/windows-migration.js",
  "--- a/src/windows-migration.js",
  "+++ b/src/windows-migration.js",
  "-  applyAcl(host, acl);",
  "+  captureVssSnapshot(host);",
  "-  captureVssSnapshot(host);",
  "+  applyAcl(host, acl);",
  "// rollback 用快照恢复；ACL 必须在快照之后",
].join("\n");

function addEvt(stage: AssetEventStage, assetId: string, name: string): void {
  const repo = getAssetEventRepo()!;
  repo.insert(repo.newEvent({
    stage,
    asset: { assetId, assetType: "skill", name },
    sessionKey: SESSION,
    taskId: "task-covxoq8e1r",
    teamId: "team-coudtbobez",
  }));
}

/** 按命令返回固定输出的 fake exec（记录调用顺序）。 */
function makeExec(calls: string[], opts: {
  diffStat?: string;
  diff?: string;
  status?: string;
  testExit?: number;
  testOutput?: string;
} = {}): ExecFn {
  const {
    diffStat = " src/windows-migration.js | 8 +++++------\n 1 file changed",
    diff = DIFF_TEXT,
    status = "",
    testExit = 0,
    testOutput = "# tests 6\n# pass 6\n# fail 0",
  } = opts;
  return async (command: string): Promise<ExecResult> => {
    calls.push(command);
    if (command.startsWith("git status")) return { code: 0, output: status };
    if (command.startsWith("git diff HEAD --stat")) return { code: 0, output: diffStat };
    if (command.startsWith("git diff HEAD")) return { code: 0, output: diff };
    if (command === "node --test") return { code: testExit, output: testOutput };
    return { code: 0, output: "" };
  };
}

describe("tokenizeText / correlateAssets", () => {
  it("tokenize：拉丁拆词 + 中文连续串", () => {
    const t = tokenizeText("cloud-migration-tool-guide 迁移快照回滚");
    expect(t).toContain("migration");
    expect(t).toContain("cloud");
    expect(t).toContain("guide");
    expect(t.some((x) => x.includes("迁移"))).toBe(true);
  });

  it("归因：只用 used；与 diff token 共现才判相关；corrected 跳过；selected-only 不判", () => {
    const summaries = [
      { asset: { assetId: "skl-post", assetType: "skill", name: "cloud-migration-postmortems" }, stages: ["used"] as AssetEventStage[], lastStageAt: {} },
      { asset: { assetId: "skl-guide", assetType: "skill", name: "cloud-migration-tool-guide" }, stages: ["used", "selected"] as AssetEventStage[], lastStageAt: {} },
      { asset: { assetId: "skl-mem", assetType: "skill", name: "memory-hub-asset-guide" }, stages: ["used"] as AssetEventStage[], lastStageAt: {} },
      { asset: { assetId: "skl-corr", assetType: "skill", name: "migration-expert-tips" }, stages: ["used", "corrected"] as AssetEventStage[], lastStageAt: {} },
      { asset: { assetId: "skl-recall", assetType: "skill", name: "acl-migrate 影响路径" }, stages: ["recalled"] as AssetEventStage[], lastStageAt: {} },
      // 只 selected 没 used（被推荐但没打开）→ 不判，否则 F4「validated 无 used」误报。
      { asset: { assetId: "skl-sel", assetType: "skill", name: "windows-acl-check" }, stages: ["selected"] as AssetEventStage[], lastStageAt: {} },
    ];
    const correlated = correlateAssets(summaries as never, DIFF_TEXT);
    const ids = correlated.map((c) => c.asset.assetId).sort();
    // postmortems / guide 命中 migration 等（且 used）；memory-hub 无共现；corrected 跳过；
    // recalled / selected-only 不参与
    expect(ids).toEqual(["skl-guide", "skl-post"]);
    for (const c of correlated) expect(c.hitTokens.length).toBeGreaterThan(0);
  });
});

describe("runTaskFinalize — 端到端（注入 exec）", () => {
  it("有变更 + 测试 exit 0 → 给相关 used/selected 资产写 validated（真退出码+code_diff/outcome）", async () => {
    addEvt("used", "skl-post", "cloud-migration-postmortems");
    addEvt("used", "skl-mem", "memory-hub-asset-guide");
    const calls: string[] = [];
    const outcome = await runTaskFinalize({
      sessionKey: SESSION,
      repo: REPO,
      testCmd: "node --test",
      runnerLabel: "node --test",
      sessionInfo: { team_id: "team-coudtbobez", agent_id: "agt-a", task_id: "task-covxoq8e1r" },
      repoEvents: getAssetEventRepo(),
      exec: makeExec(calls),
    });

    expect(calls).toEqual([
      "git status --porcelain",
      "git diff HEAD --stat",
      "git diff HEAD",
      "node --test",
    ]);
    expect(outcome.hasChange).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.correlated.map((c) => c.asset.assetId)).toEqual(["skl-post"]);
    expect(outcome.validatedAssetIds).toEqual(["skl-post"]);

    const validated = getAssetEventRepo()!.bySessionKey(SESSION, "validated");
    expect(validated).toHaveLength(1);
    const ev = validated[0].evidence!;
    expect(ev.test_result?.exitCode).toBe(0);
    expect(ev.test_result?.runner).toBe("node --test");
    expect(ev.code_diff).toBeTruthy();
    expect(ev.outcome).toContain("exit 0");
    expect(ev.validator?.detail).toContain("token-overlap");
    expect(ev.validator?.detail).toContain("migration");
  });

  it("测试非 0 → 相关资产也不写 validated", async () => {
    addEvt("used", "skl-post", "cloud-migration-postmortems");
    const outcome = await runTaskFinalize({
      sessionKey: SESSION,
      repo: REPO,
      testCmd: "node --test",
      repoEvents: getAssetEventRepo(),
      exec: makeExec([], { testExit: 1, testOutput: "# fail 2" }),
    });
    expect(outcome.hasChange).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.correlated.length).toBeGreaterThan(0);
    expect(outcome.validatedAssetIds).toEqual([]);
    expect(getAssetEventRepo()!.bySessionKey(SESSION, "validated")).toHaveLength(0);
  });

  it("无变更 → 不跑测试、不写 validated", async () => {
    addEvt("used", "skl-post", "cloud-migration-postmortems");
    const calls: string[] = [];
    const outcome = await runTaskFinalize({
      sessionKey: SESSION,
      repo: REPO,
      testCmd: "node --test",
      repoEvents: getAssetEventRepo(),
      exec: makeExec(calls, { diffStat: "", status: "" }),
    });
    expect(outcome.hasChange).toBe(false);
    expect(outcome.reason).toContain("无相对 HEAD 的代码变更");
    expect(calls.filter((c) => c === "node --test")).toHaveLength(0);
    expect(getAssetEventRepo()!.bySessionKey(SESSION, "validated")).toHaveLength(0);
  });
});

describe("finalize 保守写判据（防大 diff / 多资产摊分）", () => {
  const withExec = (diffStat: string, diff: string) => {
    const calls: string[] = [];
    const exec = makeExec(calls, { diffStat, diff });
    return { calls, exec };
  };

  it("多 used：仅一者含独有/变更文件路径锚点 → 只写它，另一判弱命中进 weakRefusals", async () => {
    addEvt("used", "skl-A", "cloud-migration-guide");   // guide 在变更路径 docs/guide.md → 锚点
    addEvt("used", "skl-B", "cloud-migration-tools");   // 仅共享泛化词 migration，无锚点 → 弱命中
    const { exec } = withExec(
      " docs/guide.md | 4 +--\n 1 file changed",
      [
        "diff --git a/docs/guide.md b/docs/guide.md",
        "--- a/docs/guide.md",
        "+++ b/docs/guide.md",
        "-  migration steps old",
        "+  migration steps new (rollback order)",
      ].join("\n"),
    );
    const outcome = await runTaskFinalize({
      sessionKey: SESSION, repo: REPO, testCmd: "node --test", runnerLabel: "node --test",
      repoEvents: getAssetEventRepo(), exec,
    });

    expect(outcome.usedCandidateCount).toBe(2);
    expect(outcome.correlated.map((c) => c.asset.assetId).sort()).toEqual(["skl-A", "skl-B"]);
    expect(outcome.validatedAssetIds).toEqual(["skl-A"]);           // A 有独有/路径锚点
    expect(outcome.weakRefusals.map((w) => w.assetId)).toEqual(["skl-B"]); // B 仅共享 migration
    expect(outcome.weakRefusals[0].reason).toContain("弱命中");

    const validated = getAssetEventRepo()!.bySessionKey(SESSION, "validated");
    expect(validated).toHaveLength(1);
    const corr = validated[0].evidence?.correlation;
    expect(corr?.heuristic).toBe(true);
    expect(corr?.type).toBe("token-overlap");
    expect(corr?.pathHits).toContain("guide");
    expect(corr?.distinctiveHits).toContain("guide");
  });

  it("大 diff + 单泛化共享 token 且无变更文件锚点 → 相关资产都判弱命中，不写 validated", async () => {
    addEvt("used", "skl-A", "alpha-migration-one");
    addEvt("used", "skl-B", "beta-migration-two");
    const { exec } = withExec(
      " src/generated/bundle.js | 80 +----\n 1 file changed",
      [
        "diff --git a/src/generated/bundle.js b/src/generated/bundle.js",
        "--- a/src/generated/bundle.js",
        "+++ b/src/generated/bundle.js",
        "-  // migration point 1: snapshot before acl",
        "-  // migration point 2: apply acl",
        "-  // migration point 3: rollback order",
        "+  // migration point 1: snapshot before acl (revised)",
        "+  // migration point 2: apply acl (revised)",
        "+  // migration point 3: rollback order (revised)",
      ].join("\n"),
    );
    const outcome = await runTaskFinalize({
      sessionKey: SESSION, repo: REPO, testCmd: "node --test",
      repoEvents: getAssetEventRepo(), exec,
    });
    // 两资产各只命中共享的 migration，migration 不在变更文件路径里 → 双双弱命中拒绝。
    expect(outcome.validatedAssetIds).toEqual([]);
    expect(outcome.weakRefusals).toHaveLength(2);
    expect(outcome.weakRefusals.every((w) => w.reason?.includes("弱命中"))).toBe(true);
    expect(getAssetEventRepo()!.bySessionKey(SESSION, "validated")).toHaveLength(0);
  });

  it("单 used 资产 1 token（仅 diff 正文、非路径）→ 仍判（无其它资产可摊分）", async () => {
    addEvt("used", "skl-R", "cloud-rollback-helper");
    const { exec } = withExec(
      " src/state.js | 6 +--\n 1 file changed",
      [
        "diff --git a/src/state.js b/src/state.js",
        "--- a/src/state.js",
        "+++ b/src/state.js",
        "-  // old rollback: revert window too short",
        "+  // new rollback: revert full window",
      ].join("\n"),
    );
    const outcome = await runTaskFinalize({
      sessionKey: SESSION, repo: REPO, testCmd: "node --test",
      repoEvents: getAssetEventRepo(), exec,
    });
    expect(outcome.usedCandidateCount).toBe(1);
    expect(outcome.validatedAssetIds).toEqual(["skl-R"]);
    expect(outcome.weakRefusals).toEqual([]);
  });
});

describe("pathTokensFromDiff / decideCorrelationWrite（纯函数矩阵）", () => {
  it("从 diff 头解析变更文件路径 token", () => {
    const set = pathTokensFromDiff([
      "diff --git a/src/windows-migration.js b/src/windows-migration.js",
      "--- a/src/windows-migration.js",
      "+++ b/src/windows-migration.js",
      " src/windows-migration.js | 8 +++",
      " 1 file changed",
    ].join("\n"));
    expect(set.has("windows")).toBe(true);
    expect(set.has("migration")).toBe(true);
    expect(set.has("js")).toBe(true);
  });

  const cand = (over: Partial<CorrelatedAsset>): CorrelatedAsset => ({
    asset: { assetId: "skl-x", assetType: "skill", name: "x" },
    hitTokens: ["migration"],
    pathHits: [],
    distinctiveHits: [],
    sharedHits: [],
    ...over,
  });

  it("单候选：≥ minMatches 即写", () => {
    expect(decideCorrelationWrite(cand({ hitTokens: ["migration"] }), { usedCandidateCount: 1, minMatches: 1 }).write).toBe(true);
    expect(decideCorrelationWrite(cand({ hitTokens: [] }), { usedCandidateCount: 1, minMatches: 1 }).write).toBe(false);
  });
  it("多候选：独有/路径锚点 ≥1 → 写", () => {
    expect(decideCorrelationWrite(
      cand({ pathHits: ["migration"], sharedHits: ["migration"] }),
      { usedCandidateCount: 2, minMatches: 1 },
    ).write).toBe(true);
    expect(decideCorrelationWrite(
      cand({ distinctiveHits: ["guide"] }),
      { usedCandidateCount: 2, minMatches: 1 },
    ).write).toBe(true);
  });
  it("多候选：仅 1 共享泛化词且无锚点 → 弱命中不写", () => {
    const d = decideCorrelationWrite(
      cand({ sharedHits: ["migration"], hitTokens: ["migration"] }),
      { usedCandidateCount: 2, minMatches: 1 },
    );
    expect(d.write).toBe(false);
    expect(d.reason).toContain("弱命中");
  });
  it("多候选：≥2 普通共享命中 → 写（独立共现佐证）", () => {
    expect(decideCorrelationWrite(
      cand({ sharedHits: ["migration", "windows"], hitTokens: ["migration", "windows"] }),
      { usedCandidateCount: 2, minMatches: 1 },
    ).write).toBe(true);
  });
});

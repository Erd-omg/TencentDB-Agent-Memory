/**
 * EvidenceTracingObserver 测试 —— 验证注入块 assets 标记 → injected 事件落库。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceTracingObserver } from "../injection/evidence-observer.js";
import { NoopInjectionObserver } from "../injection/observer.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../injection/types.js";
import { withBlockAssets } from "../injection/evidence.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "evidence-observer-test-"));
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

function meta(overrides: Partial<AgentContextMetadata> = {}): AgentContextMetadata {
  return {
    protocol: "openai",
    traceId: "trace-1",
    keyId: "key-1",
    modelId: "m",
    stream: false,
    agentSource: "codebuddy",
    sessionKey: "codebuddy:conv-demo",
    turnSeq: 1,
    userId: "usr-demo",
    custom: {
      session: {
        session_id: "sess-demo",
        team_id: "team-demo",
        agent_id: "agt-demo",
        task_id: "task-demo",
        user_id: "usr-demo",
      },
    },
    ...overrides,
  };
}

const fakeHook: InjectionHook = {
  id: "skill-injector",
  point: "system.before_tools",
  priority: 100,
  description: "test",
  execute: async () => [],
};

describe("EvidenceTracingObserver", () => {
  it("带 assets 标记的块 → 每条资产落 injected 事件", () => {
    const obs = new EvidenceTracingObserver(new NoopInjectionObserver());
    obs.onPipelineStart(meta());
    obs.onHookDone(fakeHook, "system.before_tools", [
      withBlockAssets(
        { type: "text", content: "<available_skills>…", metadata: { source: "skill-injector" } },
        [
          { assetId: "skl-1", assetType: "skill", version: 2, name: "guide", source: "self" },
          { assetId: "skl-2", assetType: "skill", version: 1, name: "std", source: "self" },
        ],
      ),
    ], 10);

    const repo = getAssetEventRepo()!;
    const events = repo.bySessionKey("codebuddy:conv-demo", "injected");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.asset.assetId)).toEqual(["skl-1", "skl-2"]);
    expect(events[0].teamId).toBe("team-demo");
    expect(events[0].taskId).toBe("task-demo");
    expect(events[0].turnSeq).toBe(1);
    expect(events[0].evidence?.decision).toContain("skill-injector");
  });

  it("无 assets 标记的块 → 不落事件", () => {
    const obs = new EvidenceTracingObserver(new NoopInjectionObserver());
    obs.onPipelineStart(meta());
    obs.onHookDone(fakeHook, "system.suffix", [
      { type: "text", content: "no assets here", metadata: { source: "x" } },
    ], 10);

    const repo = getAssetEventRepo()!;
    expect(repo.bySessionKey("codebuddy:conv-demo")).toHaveLength(0);
  });

  it("缺 sessionKey → 静默跳过不落事件", () => {
    const obs = new EvidenceTracingObserver(new NoopInjectionObserver());
    obs.onPipelineStart(meta({ sessionKey: undefined }));
    obs.onHookDone(fakeHook, "system.before_tools", [
      withBlockAssets(
        { type: "text", content: "x", metadata: {} },
        [{ assetId: "skl-1", assetType: "skill" }],
      ),
    ], 10);

    const repo = getAssetEventRepo()!;
    expect(repo.recent(10)).toHaveLength(0);
  });

  it("内层 observer 抛错不影响证据打点（safeCall 隔离）", () => {
    const throwing: NoopInjectionObserver = {
      onPipelineStart: () => { throw new Error("boom"); },
      onPipelineEnd: () => { throw new Error("boom"); },
      onPipelineError: () => { throw new Error("boom"); },
      onHookStart: () => { throw new Error("boom"); },
      onHookDone: () => { throw new Error("boom"); },
      onHookError: () => { throw new Error("boom"); },
    };
    const obs = new EvidenceTracingObserver(throwing);
    expect(() => {
      obs.onPipelineStart(meta());
      obs.onHookDone(fakeHook, "system.before_tools", [
        withBlockAssets(
          { type: "text", content: "x", metadata: {} },
          [{ assetId: "skl-1", assetType: "skill" }],
        ),
      ], 10);
    }).not.toThrow();

    const repo = getAssetEventRepo()!;
    expect(repo.bySessionKey("codebuddy:conv-demo", "injected")).toHaveLength(1);
  });
});

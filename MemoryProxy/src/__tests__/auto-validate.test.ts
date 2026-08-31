/**
 * auto-validate 测试 —— 任务收尾自动验证：开关、目标收集、静默执行。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_VALIDATE_CAP,
  autoValidateEnabled,
  collectAutoValidateTargets,
  runAutoValidation,
} from "../evidence/auto-validate.js";
import type { AssetEvent, AssetRef } from "../db/asset-event.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";
import type { ProxyConfig } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "auto-validate-test-"));
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

function cfg(validation: Partial<ProxyConfig["validation"]> = {}, enabled = true): ProxyConfig {
  return {
    validation: { enabled, rules: { skill: "node -e ''" }, ...validation },
  } as unknown as ProxyConfig;
}

describe("autoValidateEnabled", () => {
  it("validation.enabled=false → false", () => {
    expect(autoValidateEnabled(cfg({}, false))).toBe(false);
  });

  it("enabled=true 缺省 autoValidateOnCompletion → true", () => {
    expect(autoValidateEnabled(cfg())).toBe(true);
  });

  it("enabled=true + autoValidateOnCompletion=false → false", () => {
    expect(autoValidateEnabled(cfg({ autoValidateOnCompletion: false }))).toBe(false);
  });
});

describe("collectAutoValidateTargets", () => {
  const summaries = [
    { stages: ["used"], asset: { assetId: "skl-a", assetType: "skill" } as AssetRef },
    { stages: ["used", "validated"], asset: { assetId: "skl-b", assetType: "skill" } as AssetRef },
    { stages: ["used", "corrected"], asset: { assetId: "skl-c", assetType: "skill" } as AssetRef },
    { stages: ["injected"], asset: { assetId: "skl-d", assetType: "skill" } as AssetRef },
    { stages: ["used"], asset: { assetId: "atc-1", assetType: "chat-memory" } as AssetRef },
  ];
  const events: AssetEvent[] = [
    { stage: "used", asset: { assetId: "skl-a", assetType: "skill" }, createdAt: 100 } as AssetEvent,
    { stage: "used", asset: { assetId: "atc-1", assetType: "chat-memory" }, createdAt: 200 } as AssetEvent,
  ];

  it("只收 used-未-validated-未-corrected 的 skill", () => {
    const targets = collectAutoValidateTargets(summaries, events);
    expect(targets.map((a) => a.assetId)).toEqual(["skl-a"]);
  });

  it("按最近 used 倒序 + 截断到 CAP", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      stages: ["used"],
      asset: { assetId: `skl-${i}`, assetType: "skill" } as AssetRef,
    }));
    const evts = many.map((s, i) => ({ stage: "used", asset: s.asset, createdAt: i })) as AssetEvent[];
    const targets = collectAutoValidateTargets(many, evts);
    expect(targets.length).toBe(Math.min(10, AUTO_VALIDATE_CAP));
    // 最新 used 的资产排最前（createdAt 最大 = skl-9）
    expect(targets[0].assetId).toBe("skl-9");
  });
});

describe("runAutoValidation", () => {
  it("未启用 → 0", async () => {
    expect(await runAutoValidation({ sessionKey: "s", sessionInfo: {}, config: cfg({}, false) })).toBe(0);
  });

  it("会话无事件 → 0（静默）", async () => {
    expect(await runAutoValidation({ sessionKey: "s", sessionInfo: {}, config: cfg() })).toBe(0);
  });

  it("有 used skill 但取不到正文（无 core）→ 静默返回 0 不抛错", async () => {
    const repo = getAssetEventRepo()!;
    repo.insert(repo.newEvent({
      stage: "used",
      asset: { assetId: "skl-a", assetType: "skill" },
      sessionKey: "s",
    }));
    const n = await runAutoValidation({
      sessionKey: "s",
      sessionInfo: { team_id: "team-1", agent_id: "agt-1" },
      config: cfg(),
    });
    // 内容加载依赖 core /v3/skill/get —— 测试环境无 core → 跳过，不写事件。
    expect(n).toBe(0);
    expect(getAssetEventRepo()!.bySessionKey("s").filter((e) => e.stage === "validated")).toHaveLength(0);
  });
});

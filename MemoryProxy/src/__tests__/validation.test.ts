/**
 * validation 模块测试 —— 真实命令执行验证器 + 优雅降级路径。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandRunnerValidator } from "../validation/command-runner.js";
import { validateAsset } from "../validation/run-validation.js";
import type { ProxyConfig } from "../types.js";
import { getAssetEventRepo, __resetAssetEventRepoForTests } from "../db/assetEventRepo.js";
import { __resetDbForTests } from "../db/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "validation-test-"));
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

const baseCtx = {
  asset: { assetId: "skl-demo", assetType: "skill" },
  content: "# demo\n\n## 步骤\n1. 做\n",
  sessionKey: "codebuddy:conv-x",
  sessionInfo: {},
  config: {} as ProxyConfig,
};

describe("CommandRunnerValidator（真实命令）", () => {
  it("exit 0 → pass，证据带 command/exitCode/output；{file} 已替换为临时路径", async () => {
    const v = new CommandRunnerValidator("node -e \"console.log('ok'); process.exit(0)\" {file}", 5000);
    const r = await v.validate(baseCtx);
    expect(r.pass).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok");
    expect(r.command).toContain("tdai-validate-"); // {file} 已替换
  });

  it("exit 1 → fail（corrected 侧）", async () => {
    const v = new CommandRunnerValidator("node -e \"process.stderr.write('boom'); process.exit(1)\"", 5000);
    const r = await v.validate(baseCtx);
    expect(r.pass).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("boom");
  });

  it("不存在命令 → fail（pass=false，shell 返回非 0）且不抛", async () => {
    const v = new CommandRunnerValidator("definitely-not-a-command-xyz 123", 5000);
    const r = await v.validate(baseCtx);
    expect(r.pass).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });
});

describe("validateAsset", () => {
  it("验证未启用 → 不执行", async () => {
    const outcome = await validateAsset({
      asset: baseCtx.asset,
      config: { validation: { enabled: false, rules: {} } } as ProxyConfig,
      sessionKey: "codebuddy:conv-x",
      sessionInfo: {},
    });
    expect(outcome.result).toBeNull();
    expect(outcome.reason).toContain("disabled");
    expect(getAssetEventRepo()!.recent(10)).toHaveLength(0);
  });

  it("无对应规则 → 不执行不落事件", async () => {
    const outcome = await validateAsset({
      asset: { assetId: "atc-1", assetType: "chat-memory" },
      config: { validation: { enabled: true, rules: { skill: "node -e \"process.exit(0)\"" } } } as ProxyConfig,
      sessionKey: "codebuddy:conv-x",
      sessionInfo: {},
    });
    expect(outcome.result).toBeNull();
    expect(outcome.reason).toContain('no validation rule for asset type "chat-memory"');
  });

  it("无内容加载器的资产类型 → 不落事件（不假装验证过）", async () => {
    const outcome = await validateAsset({
      asset: { assetId: "atc-1", assetType: "chat-memory" },
      config: { validation: { enabled: true, rules: { "chat-memory": "node -e \"process.exit(0)\"" } } } as ProxyConfig,
      sessionKey: "codebuddy:conv-x",
      sessionInfo: { team_id: "t", agent_id: "a" },
    });
    expect(outcome.result).toBeNull();
    expect(outcome.reason).toContain("cannot load content");
    expect(getAssetEventRepo()!.recent(10)).toHaveLength(0);
  });
});

/**
 * config 新配置项解析测试 —— injection.assetEvidence.enabled 可关 +
 * validation.autoValidateOnCompletion 解析。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConfig } from "../config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function cfg(yamlText: string): ReturnType<typeof buildConfig> {
  const file = join(tmpDir, "config.yaml");
  writeFileSync(file, yamlText, "utf-8");
  return buildConfig({ configFile: file });
}

describe("buildConfig 新配置项", () => {
  it("injection.assetEvidence.enabled=false → 证据打点可关", () => {
    const c = cfg("injection:\n  assetEvidence:\n    enabled: false\n");
    expect(c.injection.assetEvidence?.enabled).toBe(false);
  });

  it("injection.assetEvidence 缺省 → 默认开启", () => {
    const c = cfg("# empty\n");
    expect(c.injection.assetEvidence?.enabled).toBe(true);
  });

  it("validation.autoValidateOnCompletion=false → 解析生效", () => {
    const c = cfg("validation:\n  enabled: true\n  autoValidateOnCompletion: false\n");
    expect(c.validation?.enabled).toBe(true);
    expect(c.validation?.autoValidateOnCompletion).toBe(false);
  });

  it("validation 缺省 → validation 未配置（undefined）", () => {
    const c = cfg("# empty\n");
    expect(c.validation).toBeUndefined();
  });
});

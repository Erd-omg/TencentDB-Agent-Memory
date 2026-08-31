/**
 * CommandRunnerValidator — 真实命令执行验证器（任务三 validated/corrected）。
 *
 * 把资产正文写到临时文件，用配置的校验命令（规则模板 `{file}` 替换为临时文件路径）
 * 真实执行，捕获 exit code + stdout/stderr 作为证据。exit 0 → validated，
 * 非 0 → corrected（资产被证明不通过/不适用）。
 *
 * 原则：
 *   - 真实进程、真实 exit code、真实输出 —— 不是 mock。
 *   - 临时文件用完即删（含异常路径）。
 *   - 超时 kill，按失败（corrected）处理。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AssetValidator, ValidationContext, ValidationResult } from "./types.js";

const OUTPUT_MAX_CHARS = 2000;

/**
 * 仓库根目录（`<repo>/MemoryProxy/src/validation/command-runner.ts` 向上三级）。
 * 校验脚本约定放 `<repo>/scripts/validators/`，规则里用 `{root}` 引用，
 * 与 proxy 启动目录无关。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 把资产 id 转成安全的临时文件名。 */
function safeFileName(assetId: string): string {
  return assetId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
}

/**
 * shell 单引号引用（P1 #9 健壮性）：路径含空格/特殊字符时命令不炸。
 * `{root}` 场景是 `{root}/scripts/...` —— `'<root>'/scripts` 在 shell 中相邻
 * 拼接等于 `<root>/scripts`，合法。
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** spawn 一条命令，收集 stdout+stderr，等退出。超时返回非 0。 */
function runCommand(
  command: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // detached:true → 子进程自成进程组，超时 kill(-pid) 能连带杀掉 shell 的子进程，
    // 避免 `node validate-skill-format.mjs` 变孤儿继续跑（P1 #9）。
    const child = spawn(command, { shell: true, detached: true });
    let out = "";
    // 持续累积但只保留尾部 OUTPUT_MAX_CHARS*4，截断时取真·尾部（失败原因通常在末尾）。
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
        child.kill("SIGKILL"); // 进程组 kill 失败兜底
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: out || `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const truncated = out.slice(-OUTPUT_MAX_CHARS);
      resolve({ code: code ?? 1, output: truncated });
    });
  });
}

export class CommandRunnerValidator implements AssetValidator {
  readonly id = "command";

  constructor(
    private rule: string,
    private timeoutMs = 30_000,
  ) {}

  async validate(ctx: ValidationContext): Promise<ValidationResult> {
    const start = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "tdai-validate-"));
    const file = join(dir, `${safeFileName(ctx.asset.assetId)}.md`);
    try {
      writeFileSync(file, ctx.content, "utf8");
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      return {
        pass: false,
        runner: this.id,
        command: this.rule,
        exitCode: 1,
        output: `cannot write asset content: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }

    const command = this.rule
      .replace(/\{file\}/g, shq(file))
      .replace(/\{root\}/g, shq(REPO_ROOT));
    const { code, output } = await runCommand(command, this.timeoutMs);

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    return {
      pass: code === 0,
      runner: this.id,
      command,
      exitCode: code,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  }
}

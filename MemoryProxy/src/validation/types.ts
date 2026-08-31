/**
 * 任务三 `validated / corrected` 验证器类型定义。
 *
 * 设计：验证器是**真实可执行**的 runner（接真实测试/检查脚本），不是 mock。
 * 验证结果带结构化证据（runner / command / exitCode / output / durationMs），
 * 落 `validated`（通过）或 `corrected`（资产被证明错误/过期/不适用）事件。
 */

import type { AssetRef } from "../db/asset-event.js";
import type { ProxyConfig } from "../types.js";

/** 一次验证需要的上下文。 */
export interface ValidationContext {
  asset: AssetRef;
  /** 资产正文（skill 全文 / 记忆内容等），验证脚本对它执行真实检查。 */
  content: string;
  sessionKey: string;
  sessionInfo: Record<string, unknown>;
  config: ProxyConfig;
}

/** 验证结果 + 结构化证据。 */
export interface ValidationResult {
  /** exitCode === 0 → pass（validated）；否则 corrected。 */
  pass: boolean;
  runner: string;
  /** 实际执行的命令（{file} 已替换，命令本身可能含路径）。 */
  command: string;
  exitCode: number;
  /** 命令输出摘录（截断，保留失败原因）。 */
  output: string;
  durationMs: number;
}

/** 验证器接口：给定资产上下文，产出真实验证结果。 */
export interface AssetValidator {
  readonly id: string;
  validate(ctx: ValidationContext): Promise<ValidationResult>;
}

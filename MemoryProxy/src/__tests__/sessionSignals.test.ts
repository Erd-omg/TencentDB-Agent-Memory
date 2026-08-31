/**
 * session-signals 测试 —— 会话级结果信号格式化 + 失败率警示。
 */

import { describe, it, expect } from "vitest";
import type { SessionSignals } from "../evidence/session-signals.js";
import { sessionReliability, formatSessionSignals, SESSION_FAIL_RATE_THRESHOLD } from "../evidence/session-signals.js";

const base: SessionSignals = {
  turnCount: 5,
  toolCallCount: 10,
  bridgeFailCount: 0,
  bridgeFailRate: 0,
  avgLatencyMs: 120,
  totalTokens: 5000,
  credit: 2.5,
};

describe("sessionReliability", () => {
  it("失败率低于阈值 → ok", () => {
    const s = { ...base, bridgeFailRate: 0.1, bridgeFailCount: 1 };
    expect(sessionReliability(s)).toEqual({ ok: true });
  });

  it("失败率 ≥30% → 警示", () => {
    const s = { ...base, bridgeFailCount: 3, bridgeFailRate: 0.3 };
    const rel = sessionReliability(s);
    expect(rel.ok).toBe(false);
    expect(rel.warning).toContain("失败率高");
  });

  it("无工具调用 → ok（不误报）", () => {
    const s = { ...base, toolCallCount: 0, bridgeFailRate: 0 };
    expect(sessionReliability(s)).toEqual({ ok: true });
  });

  it("阈值常量为 0.3", () => {
    expect(SESSION_FAIL_RATE_THRESHOLD).toBe(0.3);
  });
});

describe("formatSessionSignals", () => {
  it("null → null（不显示）", () => {
    expect(formatSessionSignals(null)).toBeNull();
  });

  it("有信号 → 会话信号行", () => {
    const line = formatSessionSignals(base);
    expect(line).toContain("5 轮");
    expect(line).toContain("bridge 调用 10 次");
    expect(line).toContain("均耗 120ms");
    expect(line).toContain("token 5000");
    expect(line).toContain("credit 3");
  });

  it("含失败统计", () => {
    const line = formatSessionSignals({ ...base, bridgeFailCount: 2, bridgeFailRate: 0.2 });
    expect(line).toContain("失败 2（20%）");
  });

  it("全空信号 → null", () => {
    const empty: SessionSignals = {
      turnCount: 0, toolCallCount: 0, bridgeFailCount: 0, bridgeFailRate: 0,
      avgLatencyMs: 0, totalTokens: 0, credit: 0,
    };
    expect(formatSessionSignals(empty)).toBeNull();
  });
});

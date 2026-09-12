/**
 * injected 对账测试（P1-1）：验证 (session_key, turn_seq) 对账与孤儿识别。
 */

import { describe, it, expect } from "vitest";
import { reconcileInjected, type InjectedEventRef, type UsageRowRef } from "../evidence/injected-reconcile.js";

const ev = (assetId: string, sessionKey: string, turnSeq: number | undefined, createdAt: number): InjectedEventRef =>
  ({ assetId, sessionKey, turnSeq, createdAt });
const us = (sessionKey: string, turnSeq: number | undefined, timestamp: number): UsageRowRef =>
  ({ sessionKey, turnSeq, timestamp });

describe("reconcileInjected（injected vs usage_logs 对账）", () => {
  it("同 (session, turn) 匹配 → matched", () => {
    const r = reconcileInjected(
      [ev("a", "s1", 1, 1000), ev("b", "s1", 1, 1001)],
      [us("s1", 1, 1500)],
    );
    expect(r.total).toBe(2);
    expect(r.matched).toBe(2);
    expect(r.matchRate).toBe(1);
    expect(r.orphans).toHaveLength(0);
    expect(r.available).toBe(true);
  });

  it("无对应 usage 的 injected → 孤儿", () => {
    const r = reconcileInjected(
      [ev("a", "s1", 1, 1000), ev("ghost", "s1", 99, 1001)],
      [us("s1", 1, 1500)],
    );
    expect(r.matched).toBe(1);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].assetId).toBe("ghost");
    expect(r.matchRate).toBeCloseTo(0.5);
  });

  it("第二数据源为空 → available=false（对账退化）", () => {
    const r = reconcileInjected([ev("a", "s1", 1, 1000)], []);
    expect(r.available).toBe(false);
    expect(r.matched).toBe(0);
    expect(r.orphans).toHaveLength(1);
  });

  it("turnSeq 缺失时的时间窗口兜底", () => {
    const r = reconcileInjected(
      [ev("a", "s1", undefined, 1000)],
      [us("s1", undefined, 1200)],
      500,
    );
    expect(r.matched).toBe(1);
  });

  it("turnSeq 缺失且超出时间窗口 → 孤儿", () => {
    // 事件 turnSeq=1，usage turnSeq=2（key 不匹配）→ 走窗口兜底；时间差超窗 → 孤儿。
    const r = reconcileInjected(
      [ev("a", "s1", 1, 1000)],
      [us("s1", 2, 99999)],
      500,
    );
    expect(r.matched).toBe(0);
    expect(r.orphans).toHaveLength(1);
  });

  it("空事件列表 → 全零、available 取决于 usage", () => {
    const r = reconcileInjected([], [us("s1", 1, 100)]);
    expect(r.total).toBe(0);
    expect(r.matchRate).toBe(0);
    expect(r.orphans).toHaveLength(0);
  });
});

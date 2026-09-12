/**
 * injected 证据完整性哈希链测试（P1-1）。
 *
 * 覆盖：
 *   - computeEventHash 对字段敏感（任一字段变 → 哈希变）。
 *   - chainEvents 串链（首条 genesis，后续 prev=前一条 hash）。
 *   - verifyChain 校验：连续 → ok；篡改/断链/缺 integrity → brokenAt 定位。
 */

import { describe, it, expect } from "vitest";
import { computeEventHash, chainEvents, verifyChain, INTEGRITY_FIELDS } from "../evidence/integrity.js";

const evt = (assetId: string, turnSeq: number, createdAt: number) => ({
  assetId,
  stage: "injected",
  sessionKey: "codebuddy:conv-x",
  turnSeq,
  createdAt,
});

describe("computeEventHash", () => {
  it("字段内容决定哈希：任一字段变 → 哈希变", () => {
    const a = evt("skl-1", 1, 1000);
    const b = evt("skl-1", 1, 1001); // createdAt 变
    const c = evt("skl-2", 1, 1000); // assetId 变
    expect(computeEventHash(a)).not.toBe(computeEventHash(b));
    expect(computeEventHash(a)).not.toBe(computeEventHash(c));
    expect(computeEventHash(a)).toHaveLength(64); // sha256 hex
  });

  it("相同字段 → 相同哈希（确定性）", () => {
    expect(computeEventHash(evt("skl-1", 1, 1000))).toBe(computeEventHash(evt("skl-1", 1, 1000)));
  });
});

describe("chainEvents / verifyChain", () => {
  it("串链：首条 genesis，后续 prev=前一条 hash", () => {
    const chained = chainEvents([evt("a", 1, 1000), evt("b", 2, 2000), evt("c", 3, 3000)]);
    expect(chained[0].integrity.prev).toBe("genesis");
    expect(chained[1].integrity.prev).toBe(chained[0].integrity.hash);
    expect(chained[2].integrity.prev).toBe(chained[1].integrity.hash);
    expect(chained[0].integrity.fields).toEqual([...INTEGRITY_FIELDS]);
  });

  it("连续链 → verifyChain ok", () => {
    const chained = chainEvents([evt("a", 1, 1000), evt("b", 2, 2000)]);
    const res = verifyChain(chained);
    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
  });

  it("篡改字段 → brokenAt 定位", () => {
    const chained = chainEvents([evt("a", 1, 1000), evt("b", 2, 2000)]);
    chained[1].assetId = "tampered";
    const res = verifyChain(chained);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
    expect(res.reason).toContain("哈希不匹配");
  });

  it("链指针断裂 → brokenAt 定位", () => {
    const chained = chainEvents([evt("a", 1, 1000), evt("b", 2, 2000)]);
    chained[1].integrity.prev = "genesis"; // 人为断链
    const res = verifyChain(chained);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
    expect(res.reason).toContain("链指针断裂");
  });

  it("缺 integrity → brokenAt 定位", () => {
    const res = verifyChain([evt("a", 1, 1000) as never]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("缺 integrity");
  });
});

/**
 * turn-tracker 测试 —— 会话级轮次记录 / 查询。
 */

import { describe, it, expect, afterEach } from "vitest";
import { recordChatTurn, currentChatTurn, __resetTurnTracker } from "../evidence/turn-tracker.js";

afterEach(() => __resetTurnTracker());

describe("turn-tracker", () => {
  it("record 后可查", () => {
    recordChatTurn("sess-a", 3);
    expect(currentChatTurn("sess-a")).toBe(3);
  });

  it("同会话覆盖为最新", () => {
    recordChatTurn("sess-a", 2);
    recordChatTurn("sess-a", 5);
    expect(currentChatTurn("sess-a")).toBe(5);
  });

  it("未记录 → undefined（调用方容忍）", () => {
    expect(currentChatTurn("sess-nope")).toBeUndefined();
  });
});

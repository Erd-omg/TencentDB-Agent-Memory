/**
 * 任务二 检索词构建 —— 单测。
 */

import { describe, it, expect } from "vitest";
import { buildTask2Query, hasWeakSearchSignal, signalsFromPrewarm } from "../retrieval/query.js";
import type { PrewarmInput } from "../injection/types.js";

describe("hasWeakSearchSignal", () => {
  it("≥3 个长度≥3 的 distinct token → 有效", () => {
    expect(hasWeakSearchSignal("修复 NTFS ACL 校验失败 bug")).toBe(true);
  });

  it("弱信号（token 少 / 太短）→ false", () => {
    expect(hasWeakSearchSignal("ab")).toBe(false);
    expect(hasWeakSearchSignal("testagent1")).toBe(false);
  });
});

describe("buildTask2Query", () => {
  it("任务名优先，task 描述/goal 补充", () => {
    const q = buildTask2Query({
      taskName: "云主机迁移工具 Bug Fix",
      taskDescription: "修复 ACL 校验失败问题",
    });
    expect(q).toBeTruthy();
    expect(q!.startsWith("云主机迁移工具 Bug Fix")).toBe(true);
    expect(q).toContain("修复 ACL 校验失败问题");
  });

  it("只有 task 名也算有效信号", () => {
    const q = buildTask2Query({ taskName: "云主机迁移工具 Bug Fix" });
    expect(q).toBeTruthy();
  });

  it("空信号 → undefined", () => {
    expect(buildTask2Query({})).toBeUndefined();
  });

  it("弱信号（placeholder 命名）→ undefined", () => {
    expect(buildTask2Query({ taskName: "testagent1", taskDescription: "testagent1" })).toBeUndefined();
  });
});

describe("signalsFromPrewarm", () => {
  it("从 PrewarmInput 提取扁平信号", () => {
    const input = {
      keyId: "k",
      userId: "u",
      agentSource: "codebuddy",
      sessionInfo: { session_id: "s", team_id: "t", agent_id: "a", user_id: "u" },
      agentDetail: { id: "a", name: "agn", description: "agent desc", prompt: "prompt" },
      taskDetail: { id: "t1", name: "任务名", description: "任务描述", goal: "目标" },
    } as unknown as PrewarmInput;
    const s = signalsFromPrewarm(input);
    expect(s.taskName).toBe("任务名");
    expect(s.agentDescription).toBe("agent desc");
  });

  it("agentDetail/taskDetail 为 null 时容错", () => {
    const input = {
      keyId: "k",
      userId: "u",
      agentSource: "codebuddy",
      sessionInfo: { session_id: "s", team_id: "t", agent_id: "a", user_id: "u" },
      agentDetail: null,
      taskDetail: null,
    } as unknown as PrewarmInput;
    const s = signalsFromPrewarm(input);
    expect(s.taskName).toBeUndefined();
    expect(buildTask2Query(s)).toBeUndefined();
  });
});

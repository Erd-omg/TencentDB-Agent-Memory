/**
 * 任务二 任务分类路由 —— 单测。
 */

import { describe, it, expect } from "vitest";
import { classifyTask, assetPriorityForTask } from "../retrieval/task-router.js";

const RULES = {
  bug_fix: "修复,bug,失败,报错,error,fail",
  feature: "新增,开发,feature,implement",
  review: "评审,review,检查",
};

describe("classifyTask", () => {
  it("中文关键词命中 → 对应任务类型", () => {
    expect(classifyTask({ name: "修复 NTFS ACL 校验失败" }, RULES)).toBe("bug_fix");
  });

  it("英文关键词命中 → 对应任务类型", () => {
    expect(classifyTask({ description: "implement a new feature endpoint" }, RULES)).toBe("feature");
  });

  it("多规则命中取命中数最多者", () => {
    // "修复"+"bug" 2 命中 > review 1 命中
    expect(classifyTask({ name: "修复 bug 并评审", goal: "review" }, RULES)).toBe("bug_fix");
  });

  it("query 信号参与分类（execute 自 heal 路径）", () => {
    expect(classifyTask({ query: "修复这个问题" }, RULES)).toBe("bug_fix");
  });

  it("无信号 / 无命中 → general", () => {
    expect(classifyTask({}, RULES)).toBe("general");
    expect(classifyTask({ name: "随便写点什么" }, RULES)).toBe("general");
  });

  it("未知规则键被忽略（不参与分类、不产生命中）", () => {
    const rules = { ...RULES, nonsense: "zzz,qqq" };
    expect(classifyTask({ name: "zzz 修复" }, rules)).toBe("bug_fix");
  });
});

describe("assetPriorityForTask", () => {
  it("bug_fix → 失败经验优先", () => {
    const prio = assetPriorityForTask("bug_fix");
    expect(prio[0]).toBe("失败经验");
    expect(prio).toHaveLength(6);
  });

  it("未知类型回退 general", () => {
    expect(assetPriorityForTask("general")[0]).toBe("历史方案");
  });
});

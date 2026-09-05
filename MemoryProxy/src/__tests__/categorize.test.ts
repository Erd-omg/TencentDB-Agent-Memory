/**
 * 任务二 资产内容类型桶 —— 单测。
 */

import { describe, it, expect } from "vitest";
import { categorizeSkill } from "../retrieval/categorize.js";

describe("categorizeSkill", () => {
  it("历史方案：名称含 方案/SOP/guide", () => {
    expect(categorizeSkill({ name: "云主机迁移一键迁移 SOP" })).toBe("历史方案");
    expect(categorizeSkill({ name: "memory-hub-asset-guide" })).toBe("历史方案");
  });

  it("失败经验：含 失败/复盘/postmortem", () => {
    expect(categorizeSkill({ name: "cloud-migration-postmortems" })).toBe("失败经验");
    expect(categorizeSkill({ description: "上次 ACL 校验失败的教训" })).toBe("失败经验");
  });

  it("代码知识：含 调用/接口/影响路径", () => {
    expect(categorizeSkill({ name: "acl_migrate 调用关系与影响路径" })).toBe("代码知识");
    expect(categorizeSkill({ description: "API 调用接口说明" })).toBe("代码知识");
  });

  it("项目约定：含 规范/标准/standards", () => {
    expect(categorizeSkill({ name: "team-coding-standards" })).toBe("项目约定");
  });

  it("无命中 → Skill 兜底", () => {
    expect(categorizeSkill({ name: "random-notes" })).toBe("Skill");
  });
});

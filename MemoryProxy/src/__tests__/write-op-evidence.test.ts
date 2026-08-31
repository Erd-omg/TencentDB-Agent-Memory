/**
 * P1 #6 测试 —— 写操作 code_diff/outcome 证据（赛题 F2 决策/变更归因闭环）。
 *
 * 写操作（update/patch/files/write/files/remove）从请求体提取真实变更片段作为
 * code_diff + outcome；读操作（get/get-by-name）无本地 diff 源 → 返回空（诚实边界）。
 */

import { describe, it, expect } from "vitest";
import { writeOpEvidence } from "../skill/skill-bridge.js";

describe("writeOpEvidence（P1 #6）", () => {
  it("update 带 old_string/new_string → code_diff + outcome", () => {
    const r = writeOpEvidence("update", {
      skill_id: "skl-x",
      old_string: "旧命令",
      new_string: "新命令",
    }, 200);
    expect(r.code_diff).toContain("old→new: 旧命令 → 新命令");
    expect(r.outcome).toBe("applied (http 200)");
  });

  it("files/write 带 files[] → 列出写入路径与字节数", () => {
    const r = writeOpEvidence("files/write", {
      skill_id: "skl-x",
      files: [{ path: "scripts/run.sh", content: "#!/bin/sh", is_executable: true }],
    }, 200);
    expect(r.code_diff).toContain("write scripts/run.sh (9B)");
  });

  it("files/remove 带 paths[] → 列出删除路径", () => {
    const r = writeOpEvidence("files/remove", { skill_id: "skl-x", paths: ["old.sh"] }, 200);
    expect(r.code_diff).toContain("remove old.sh");
  });

  it("create/delete 无内容变更字段 → 仍记录动作本身 + outcome", () => {
    const r = writeOpEvidence("delete", { skill_id: "skl-x" }, 204);
    expect(r.code_diff).toBe("content change: delete skill"); // 删除动作本身是变更证据
    expect(r.outcome).toBe("applied (http 204)");
  });

  it("读操作（get-by-name）→ 空（诚实边界，不编造 diff）", () => {
    const r = writeOpEvidence("get-by-name", { skill_name: "x" }, 200);
    expect(r).toEqual({});
  });
});

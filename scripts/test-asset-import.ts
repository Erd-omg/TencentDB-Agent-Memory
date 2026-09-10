#!/usr/bin/env tsx
/**
 * asset-import.ts 的纯函数单测（零依赖，复用项目已有的 tsx）。
 *
 * 覆盖 toExtractMessage 的 extractMessageSchema 契约：
 *   - timestamp：ms 数字 → ISO 8601 datetime 字符串
 *   - ts 缺失（undefined）时省略 timestamp 字段（core 兜底，避免归一化）
 *   - tool_call_id / tool_name 非空透传、空值省略
 *
 * 用法：
 *   tsx scripts/test-asset-import.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toExtractMessage } from "../agents/asset-import.ts";

test("timestamp：毫秒数字转 ISO 8601 datetime 字符串", () => {
  const out = toExtractMessage({ role: "user", content: "hi", ts: 0 });
  assert.equal(out.role, "user");
  assert.equal(out.content, "hi");
  assert.equal(out.timestamp, "1970-01-01T00:00:00.000Z");
});

test("timestamp：真实毫秒值转换正确", () => {
  const ts = Date.parse("2026-09-10T08:00:00.000Z");
  const out = toExtractMessage({ role: "assistant", content: "ok", ts });
  assert.equal(out.timestamp, "2026-09-10T08:00:00.000Z");
});

test("ts 缺失（undefined）时省略 timestamp 字段", () => {
  const out = toExtractMessage({ role: "assistant", content: "no ts" });
  assert.ok(!("timestamp" in out), "ts 缺失时不应输出 timestamp 字段");
});

test("ts 为 null/0 边界：0 是合法毫秒值，应转换而非省略", () => {
  // 注意：契约是 ts !== undefined 才转换，ts=0 是合法值（epoch），不能丢
  const out = toExtractMessage({ role: "user", content: "epoch", ts: 0 });
  assert.equal(out.timestamp, "1970-01-01T00:00:00.000Z");
});

test("tool_call_id / tool_name 非空透传", () => {
  const out = toExtractMessage({
    role: "tool",
    content: "result",
    tool_call_id: "tc_123",
    tool_name: "skill_create",
  });
  assert.equal(out.tool_call_id, "tc_123");
  assert.equal(out.tool_name, "skill_create");
});

test("tool_call_id / tool_name 为空字符串时省略", () => {
  const out = toExtractMessage({ role: "tool", content: "x", tool_call_id: "", tool_name: "" });
  assert.ok(!("tool_call_id" in out), "空 tool_call_id 应省略");
  assert.ok(!("tool_name" in out), "空 tool_name 应省略");
});

test("tool_call_id / tool_name 未提供时省略", () => {
  const out = toExtractMessage({ role: "assistant", content: "plain" });
  assert.ok(!("tool_call_id" in out));
  assert.ok(!("tool_name" in out));
});

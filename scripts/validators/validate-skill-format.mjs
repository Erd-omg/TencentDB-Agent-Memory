#!/usr/bin/env node
/**
 * validate-skill-format.mjs — 真实 SKILL.md 校验器（任务三 validated/corrected 证据）。
 *
 * 用法：
 *   node scripts/validators/validate-skill-format.mjs --file /path/to/SKILL.md
 *
 * 检查（全部真实可执行，exit code 即结果）：
 *   1. YAML frontmatter 存在且可解析
 *   2. frontmatter 含非空 name / description
 *   3. 正文含至少一个二级标题（## 章节）
 *   4. 正文长度在 [80, 32000] 区间
 *
 * 全部通过 → exit 0（validated）；任一不通过 → exit 1 并输出原因（corrected）。
 * 无依赖、纯 Node 标准库。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

function usage() {
  process.stderr.write("usage: node validate-skill-format.mjs --file <path>\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const fileIdx = args.indexOf("--file");
const file = fileIdx >= 0 && args[fileIdx + 1] ? args[fileIdx + 1] : null;
if (!file) usage();

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch (err) {
  process.stderr.write(`FAIL: cannot read ${basename(file)}: ${err.message}\n`);
  process.exit(1);
}

/** 极简 frontmatter 解析：取第一个 `---` 与第二个 `---` 之间内容。 */
function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (!lines[0].trim().startsWith("---")) return null;
  const end = lines.slice(1).findIndex((l) => l.trim().startsWith("---"));
  if (end < 0) return null;
  const body = lines.slice(1, 1 + end).join("\n");
  const meta = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  }
  return { meta, bodyEndLine: 1 + end + 1 };
}

const problems = [];

const fm = parseFrontmatter(raw);
if (!fm) {
  problems.push("missing valid `---` YAML frontmatter");
} else {
  if (!fm.meta.name || fm.meta.name.trim() === "") {
    problems.push("frontmatter `name` is empty");
  } else if (fm.meta.name.length > 64) {
    problems.push(`frontmatter 'name' too long (${fm.meta.name.length} > 64)`);
  }
  if (!fm.meta.description || fm.meta.description.trim() === "") {
    problems.push("frontmatter `description` is empty");
  }
}

const body = fm ? raw.split("\n").slice(fm.bodyEndLine).join("\n") : raw;
if (!/^##\s+/m.test(body)) {
  problems.push("body has no `##` section (expected structured skill instructions)");
}

if (raw.length < 80) problems.push(`content too short (${raw.length} chars < 80)`);
if (raw.length > 32_000) problems.push(`content too long (${raw.length} chars > 32000)`);

if (problems.length === 0) {
  process.stdout.write(`PASS ${basename(file)}: frontmatter + ${body.split("\n").filter((l) => l.trim()).length} lines of body\n`);
  process.exit(0);
} else {
  process.stderr.write(`FAIL ${basename(file)}: ${problems.join("; ")}\n`);
  process.exit(1);
}

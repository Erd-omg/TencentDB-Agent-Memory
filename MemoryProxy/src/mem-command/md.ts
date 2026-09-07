/**
 * mem: 命令的 Markdown 排版助手（统一可读性）。
 *
 * 背景：mem:validate / mem:finalize / mem:correct 等命令原输出是**无格式文本**
 * （每行两个空格缩进），在 CodeBuddy 里可读性差。此处提供与 mem:receipt 一致的
 * 轻量 Markdown 版式：`## 📋/🔬 …` 标题 + `**…**` 分节 + `-` bullets +
 * 结尾 `> （数据来自 …，非模型自述）` 脚注。
 *
 * 只影响 messageText 展示；命令的 `data` 结构保持原样（脚本 / --json 消费者不受影响）。
 * 关键 token（`exit 0`、`🔬 资产验证（N 项）`、`拒绝校验`、`hits=[…]` 等）保留，
 * 保证 scripts/verify-* 的行内 grep 断言不破。
 */

/** 统一命令标题行。icon → 🔬(validate)/⚙️(finalize)/✏️(correct)/🔄(sync) 等。 */
export function mdHeader(icon: string, title: string): string {
  return `## ${icon} ${title}`;
}

/** 一个 `**…**` 分节（无描述直接给空行）。 */
export function mdSection(label: string): string {
  return `**${label}**`;
}

/** 一条 bullet（自动加 "- " 前缀）。 */
export function mdBullet(text: string): string {
  return `- ${text}`;
}

/** 空行。 */
export function mdBlank(): string {
  return "";
}

/** 结尾脚注（可选）。 */
export function mdFootnote(text: string): string {
  return `> ${text}`;
}

/** 拼装：把若干行（mdHeader/mdSection/mdBullet/mdBlank/mdFootnote）join 成一段 Markdown。 */
export function mdJoin(lines: Array<string | undefined>): string {
  return lines.filter((l): l is string => typeof l === "string" && l.length > 0).join("\n");
}

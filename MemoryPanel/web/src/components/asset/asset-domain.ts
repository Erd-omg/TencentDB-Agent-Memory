/**
 * asset-domain — 资产领域展示映射（共享）。
 *
 * 从 EvidencePage 的 EvidenceDetail 提取，供各资产页复用（避免任务六再出一套）：
 *   - effMeta：资产有效性（已通过测试验证 / 已标记验证(缺使用) / 已采用待验证 / 仅背景参考 / …）
 *     → 「图标 + 译文案 + StatusTag 主题」。
 *   - RISK_THEME：风险等级（low/medium/high）→ StatusTag/Tea Tag 主题。
 *   - typeLabel：asset_type → 显示名（Skill / Chat-Memory / Profile / Wiki / …）。
 *   - stageLabel：证据链阶段 → 显示名（召回 / 选中 / 注入 / 使用 / 已验证 / …）。
 *   - fmtTime：时间戳 → zh-CN 本地时间。
 *
 * 仅依赖 i18n `t`（evidence.* 命名空间）与 StatusTheme 类型，无 React / 无 tea 组件耦合。
 */
import type { StatusTheme } from '../StatusTag';

export type TFunc = (key: string) => string;

/** 资产有效性 → 展示（图标 + 译文案 + 主题）。label 走 i18n。 */
export function effMeta(t: TFunc): Record<string, { icon: string; label: string; theme: StatusTheme }> {
  return {
    corrected: { icon: '❌', label: t('evidence.eff.corrected'), theme: 'error' },
    validated: { icon: '✅', label: t('evidence.eff.validated'), theme: 'success' },
    validated_no_use: { icon: '⚠️', label: t('evidence.eff.validated_no_use'), theme: 'warning' },
    reused: { icon: '🔄', label: t('evidence.eff.reused'), theme: 'success' },
    adopted: { icon: '⏳', label: t('evidence.eff.adopted'), theme: 'default' },
    selected: { icon: '⏳', label: t('evidence.eff.selected'), theme: 'default' },
    reference_only: { icon: '💤', label: t('evidence.eff.reference_only'), theme: 'default' },
  };
}

/** 风险等级 → Tea Tag 主题。 */
export const RISK_THEME: Record<string, StatusTheme> = { low: 'default', medium: 'warning', high: 'error' };

/** asset_type → 显示名。 */
export function typeLabel(t: TFunc): Record<string, string> {
  return {
    skill: 'Skill', 'chat-memory': 'Chat-Memory', profile: 'Profile',
    wiki: 'Wiki', 'code-graph': 'CodeGraph', 'product-knowledge': t('evidence.type.product_knowledge'),
  };
}

/** 证据链阶段 → 显示名。 */
export function stageLabel(t: TFunc): Record<string, string> {
  return {
    recalled: t('evidence.stage.recalled'), selected: t('evidence.stage.selected'),
    injected: t('evidence.stage.injected'), used: t('evidence.stage.used'),
    validated: t('evidence.stage.validated'), corrected: t('evidence.stage.corrected'),
    contributed: t('evidence.stage.contributed'),
  };
}

/** 时间戳 → zh-CN 本地时间。 */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 自然断点字符：中文标点 + ASCII 标点 + 空格（技术内容用）。齐 CodeBuddy CN 回执 naturalTrunc。 */
const NATURAL_BREAK = "，。；、！？：,.!?;: )\"'";

/** 自然截断：在整个字符预算内从末尾向前找最后一个自然断点（中文/ASCII 标点、空格），
 *  在那里截断加 …，避免硬切在词语中间；找不到断点才回退按 max 硬切。 */
export function naturalTrunc(text: string, max = 40): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  for (let i = max - 1; i >= Math.floor(max * 0.5); i--) {
    if (NATURAL_BREAK.includes(head[i])) return `${head.slice(0, i + 1)}…`;
  }
  return `${head}…`;
}

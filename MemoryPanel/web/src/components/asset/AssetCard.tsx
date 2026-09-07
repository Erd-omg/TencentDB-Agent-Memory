/**
 * AssetCard — 共享「资产卡」组件（任务四 Evidence 页 + 未来任务六等复用）。
 *
 * 把 EvidencePage 之前内联的 `_evidence-card` 收敛成一套可复用的领域卡：
 *   - 头部：有效性徽标（StatusTag）+ 名称/版本/来源 + 右侧类型 Tag
 *   - 可选：阶段 chips（证据链）、风险 Tags、`<details>` 展开区（证据事件/决策列表）
 *
 * 复用 tea `Card`/`Tag` + `StatusTag` + tea 令牌；避免各页再手写一套卡片样式。
 * 领域映射（effectiveness/risk/type/stage→文案+主题）见 `./asset-domain.ts`。
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Tag } from 'tea-component';
import { StatusTag, type StatusTheme } from '../StatusTag';
import { RISK_THEME, naturalTrunc } from './asset-domain';
import './asset-card-base.css';

export interface AssetCardProps {
  /** 资产名 / id。 */
  name: string;
  /** 版本（可选，显示为 vX）。 */
  version?: string | number;
  /** 来源（可选，显示为 · 来源 X）。 */
  source?: string;
  /** 右侧类型 Tag 文案（如 Skill / Wiki）。 */
  typeLabel?: string;
  /** 有效性徽标（图标 + 文案 + 主题）；不传则不显示徽标。 */
  status?: { icon: string; label: string; theme: StatusTheme };
  /** 证据链阶段 chips（如 召回→选中→注入→使用→已验证）。 */
  stages?: string[];
  /** 风险 Tags（[{level,messageKey,label?,detail}]，level 决定主题，文案走 i18n messageKey）。 */
  risks?: Array<{ level: string; messageKey?: string; label?: string; detail?: string }>;
  /** `<details>` 折叠 summary 文案（如「证据/决策（N 条事件）」）；不传则不渲染展开区。 */
  expandSummary?: string;
  /** 展开区内容（证据事件行等）。 */
  children?: ReactNode;
  /** 额外的卡 className。 */
  className?: string;
}

export function AssetCard({
  name,
  version,
  source,
  typeLabel,
  status,
  stages,
  risks,
  expandSummary,
  children,
  className,
}: AssetCardProps) {
  const { t } = useTranslation();
  const [titleExpanded, setTitleExpanded] = useState(false);
  const title = `${name}${version != null ? ` v${version}` : ''}`;
  // 长标题默认 naturalTrunc 在自然断点截断（不在词语中间断），可点「展开/收起」看全文。
  const TITLE_MAX = 40;
  const titleTruncated = title.length > TITLE_MAX;
  const shownTitle = titleTruncated && !titleExpanded ? naturalTrunc(title, TITLE_MAX) : title;
  return (
    <Card className={`_asset-card${className ? ` ${className}` : ''}`}>
      <Card.Body>
        {/* 头部：标题独占一行，右侧仅类型 Tag。长标题在自然断点截断 + 可展开，不在词语中断。 */}
        <div className="_asset-card-head">
          <span className="_asset-card-title" title={titleTruncated ? title : undefined}>
            {shownTitle}
            {titleTruncated && (
              <button
                type="button"
                className="_asset-card-title-toggle"
                onClick={() => setTitleExpanded((v) => !v)}
              >
                {titleExpanded ? t('evidence.label.collapse') : t('evidence.label.expand')}
              </button>
            )}
          </span>
          {typeLabel && (
            <Tag theme="default" variant="outlined" size="sm">
              {typeLabel}
            </Tag>
          )}
        </div>
        {/* meta 行：有效性徽章 + 来源（团队池/Agent 自有/借调）。与标题分层，避免窄屏遮挡。 */}
        <div className="_asset-card-meta">
          {status && <StatusTag label={`${status.icon} ${status.label}`} theme={status.theme} />}
          {source && <span className="_asset-card-source">{source}</span>}
        </div>
        {stages && stages.length > 0 && (
          <div className="_asset-card-stages">
            <span className="_asset-card-label">{t('evidence.label.stage')}：</span>
            {stages.map((s, i) => (
              <span key={s} className="_asset-stage-chip">
                {s}
                {i < stages.length - 1 && <span className="_asset-stage-arrow">→</span>}
              </span>
            ))}
          </div>
        )}
        {risks && risks.length > 0 && (
          <div className="_asset-card-risks">
            <span className="_asset-card-label">{t('evidence.label.risk')}：</span>
            {risks.map((r, i) => (
              <Tag
                key={`${r.level}-${r.messageKey ?? r.label ?? i}`}
                theme={RISK_THEME[r.level] ?? 'default'}
                variant="outlined"
                size="sm"
                className="tea-tag--unlimited-width"
              >
                {r.messageKey ? t(r.messageKey) : r.label}
                {r.detail ? `（${r.detail}）` : ''}
              </Tag>
            ))}
          </div>
        )}
        {expandSummary && (
          <details className="_asset-card-details">
            <summary className="_asset-card-details-summary">{expandSummary}</summary>
            <div className="_asset-card-details-body">{children}</div>
          </details>
        )}
      </Card.Body>
    </Card>
  );
}

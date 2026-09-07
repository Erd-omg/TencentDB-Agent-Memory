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
import { Card, Tag } from 'tea-component';
import { StatusTag, type StatusTheme } from '../StatusTag';
import './asset-card.css';

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
  /** 风险 Tags（[{level,label,detail}]，level 决定主题）。 */
  risks?: Array<{ level: string; label: string; detail?: string }>;
  /** `<details>` 折叠 summary 文案（如「证据/决策（N 条事件）」）；不传则不渲染展开区。 */
  expandSummary?: string;
  /** 展开区内容（证据事件行等）。 */
  children?: ReactNode;
  /** 额外的卡 className。 */
  className?: string;
}

/** 风险等级 → Tea Tag 主题（与 asset-domain RISK_THEME 对齐，供卡内标签直接使用）。 */
const RISK_THEME: Record<string, StatusTheme> = { low: 'default', medium: 'warning', high: 'error' };

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
  const title = `${name}${version != null ? ` v${version}` : ''}${source ? ` · ${source}` : ''}`;
  return (
    <Card className={`_asset-card${className ? ` ${className}` : ''}`}>
      <Card.Body>
        <div className="_asset-card-head">
          <span className="_asset-card-name">
            {status && <StatusTag label={`${status.icon} ${status.label}`} theme={status.theme} />}
            <span className="_asset-card-title">{title}</span>
          </span>
          {typeLabel && (
            <Tag theme="default" variant="outlined" size="sm">
              {typeLabel}
            </Tag>
          )}
        </div>
        {stages && stages.length > 0 && (
          <div className="_asset-card-stages">
            <span className="_asset-card-label">阶段：</span>
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
            <span className="_asset-card-label">风险：</span>
            {risks.map((r) => (
              <Tag key={r.label} theme={RISK_THEME[r.level] ?? 'default'} variant="outlined" size="sm">
                [{r.level}] {r.label}
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

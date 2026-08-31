/**
 * EvidenceDetail — 回执详情区（左侧会话列表选中后显示）。
 *
 * 结构：有效性汇总条 → 证据链完整性提醒（F4）→ 按类型分组的资产卡（可展开证据）。
 * 复用 _asset-* 设计系统 + tea 令牌色（无硬编码 hex），与 Skills/ChatMemory 页对齐。
 */

import { useTranslation } from 'react-i18next';
import { Alert, Card, StatusTip, Tag, Text } from 'tea-component';
import { StatusTag, type StatusTheme } from '@/components/StatusTag';
import type { EvidenceEvent, ReceiptAsset, ReceiptData } from '@/lib/api/evidence';
import '../styles/evidence.css';

/** 有效性 → 展示（图标 + 语义 + Tea Tag 主题）。label 走 i18n（P1 #7b 本地化）。 */
function effMeta(t: (k: string) => string): Record<string, { icon: string; label: string; theme: StatusTheme }> {
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
const RISK_THEME: Record<string, StatusTheme> = { low: 'default', medium: 'warning', high: 'error' };

function typeLabel(t: (k: string) => string): Record<string, string> {
  return {
    skill: 'Skill', 'chat-memory': 'Chat-Memory', profile: 'Profile',
    wiki: 'Wiki', 'code-graph': 'CodeGraph', 'product-knowledge': t('evidence.type.product_knowledge'),
  };
}

function stageLabel(t: (k: string) => string): Record<string, string> {
  return {
    recalled: t('evidence.stage.recalled'), selected: t('evidence.stage.selected'),
    injected: t('evidence.stage.injected'), used: t('evidence.stage.used'),
    validated: t('evidence.stage.validated'), corrected: t('evidence.stage.corrected'),
    contributed: t('evidence.stage.contributed'),
  };
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 有效性汇总条（彩色徽章）。 */
function SummaryStrip({ eff }: { eff: Record<string, number> }) {
  const { t } = useTranslation();
  const meta = effMeta(t);
  const buckets: Array<{ key: string; count: number }> = [
    { key: 'validated', count: eff.validated ?? 0 },
    { key: 'reused', count: eff.reused ?? 0 },
    { key: 'adopted', count: (eff.adopted ?? 0) + (eff.selected ?? 0) },
    { key: 'validated_no_use', count: eff.validated_no_use ?? 0 },
    { key: 'reference_only', count: eff.reference_only ?? 0 },
    { key: 'corrected', count: eff.corrected ?? 0 },
  ];
  const shown = buckets.filter((b) => b.count > 0);
  if (shown.length === 0) return null;
  return (
    <div className="_evidence-summary">
      {shown.map((b) => {
        const m = meta[b.key];
        return (
          <StatusTag key={b.key} label={`${m.icon} ${m.label} ${b.count}`} theme={m.theme} />
        );
      })}
    </div>
  );
}

/** 证据链完整性提醒（F4）。 */
function ChainWarning({ issues }: { issues: ReceiptData['chain_issues'] }) {
  const { t } = useTranslation();
  const hasError = issues.some((i) => i.level === 'error');
  return (
    <Alert type={hasError ? 'error' : 'warning'} className="_evidence-chain-alert">
      <Text theme={hasError ? 'danger' : 'warning'} className="_evidence-chain-title">
        {t('evidence.chain_warning_count', { count: issues.length })}
      </Text>
      {issues.map((ci) => (
        <div key={ci.asset_id + ci.missing} className="_evidence-chain-row">
          {ci.level === 'error' ? '🔴' : '🟡'} [{ci.level}] {ci.message}
        </div>
      ))}
    </Alert>
  );
}

/** 单条证据事件行（展开区）。 */
function EvidenceRow({ ev }: { ev: EvidenceEvent }) {
  const { t } = useTranslation();
  const stages = stageLabel(t);
  const tc = ev.evidence?.tool_call;
  const tr = ev.evidence?.test_result;
  let desc = t('evidence.label.no_evidence');
  if (tr) desc = `[${tr.runner}] exit=${tr.exitCode} ${(tr.output ?? '').slice(0, 100)}`;
  else if (tc) desc = `${tc.bridge}/${tc.endpoint}${tc.query ? ` · query="${tc.query.slice(0, 50)}"` : ''}`;
  return (
    <div className="_evidence-row">
      <span className="_evidence-row-stage">[{stages[ev.stage] ?? ev.stage}]</span>
      <span className="_evidence-row-time">{fmtTime(ev.created_at)}</span>
      {typeof ev.turn_seq === 'number' && <span className="_evidence-row-turn">{t('evidence.label.turn', { n: ev.turn_seq })}</span>}
      <span className="_evidence-row-desc">{desc}</span>
    </div>
  );
}

/** 单张资产卡。 */
function AssetCard({ asset }: { asset: ReceiptAsset }) {
  const { t } = useTranslation();
  const eff = effMeta(t);
  const types = typeLabel(t);
  const stages = stageLabel(t);
  const m = eff[asset.effectiveness] ?? eff.reference_only;
  const ver = asset.version ? ` v${asset.version}` : '';
  const src = asset.source ? ` · ${t('evidence.label.source')} ${asset.source}` : '';
  return (
    <Card className="_evidence-card">
      <Card.Body>
        <div className="_evidence-card-head">
          <span className="_evidence-card-name">
            <Tag theme={m.theme} variant="soft" size="sm">{m.icon} {m.label}</Tag>
            <span className="_evidence-card-title">{asset.name || asset.asset_id}{ver}{src}</span>
          </span>
          <Tag theme="default" variant="outlined" size="sm">
            {types[asset.asset_type] ?? asset.asset_type}
          </Tag>
        </div>
        <div className="_evidence-card-stages">
          <span className="_evidence-label">{t('evidence.label.stage')}：</span>
          {asset.stages.map((s, i) => (
            <span key={s} className="_evidence-stage-chip">
              {stages[s] ?? s}
              {i < asset.stages.length - 1 && <span className="_evidence-stage-arrow">→</span>}
            </span>
          ))}
        </div>
        {asset.risks.length > 0 && (
          <div className="_evidence-card-risks">
            <span className="_evidence-label">{t('evidence.label.risk')}：</span>
            {asset.risks.map((r) => (
              <Tag key={r.label} theme={RISK_THEME[r.level] ?? 'default'} variant="outlined" size="sm">
                [{r.level}] {r.label}
                {r.detail ? `（${r.detail}）` : ''}
              </Tag>
            ))}
          </div>
        )}
        <details className="_evidence-details">
          <summary className="_evidence-details-summary">
            {t('evidence.label.evidence_decision')}（{asset.events.length} 条事件）
          </summary>
          <div className="_evidence-details-body">
            {asset.events.map((ev) => <EvidenceRow key={ev.id} ev={ev} />)}
          </div>
        </details>
      </Card.Body>
    </Card>
  );
}

export interface EvidenceDetailProps {
  receipt: ReceiptData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function EvidenceDetail({ receipt, loading, error, onRetry }: EvidenceDetailProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="_evidence-detail-pane">
        <StatusTip status="loading" loadingText={t('evidence.loading')} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="_evidence-detail-pane">
        <StatusTip status="error" errorText={error} retryText={t('evidence.retry')} onRetry={onRetry} />
      </div>
    );
  }
  if (!receipt) {
    return (
      <div className="_evidence-detail-pane">
        <StatusTip status="empty" emptyText={t('evidence.detail.empty')} />
      </div>
    );
  }

  // 按类型分组，组内 reference_only 排最后。
  const types = typeLabel(t);
  const groups = new Map<string, ReceiptAsset[]>();
  for (const a of receipt.assets) {
    const k = types[a.asset_type] ?? a.asset_type;
    const arr = groups.get(k) ?? [];
    arr.push(a);
    groups.set(k, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const pa = a.effectiveness === 'reference_only' ? 1 : 0;
      const pb = b.effectiveness === 'reference_only' ? 1 : 0;
      return pa - pb;
    });
  }

  return (
    <div className="_evidence-detail-pane">
      <SummaryStrip eff={receipt.effectiveness} />
      {receipt.chain_issues.length > 0 && <ChainWarning issues={receipt.chain_issues} />}

      {[...groups.entries()].map(([type, assets]) => (
        <div key={type} className="_evidence-group">
          <Text theme="label" className="_evidence-group-title">{t('evidence.group_count', { type, count: assets.length })}</Text>
          {assets.map((a) => <AssetCard key={a.asset_id} asset={a} />)}
        </div>
      ))}
    </div>
  );
}

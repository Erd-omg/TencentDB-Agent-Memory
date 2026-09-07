/**
 * EvidenceDetail — 回执详情区（左侧会话列表选中后显示）。
 *
 * 结构：有效性汇总条 → 证据链完整性提醒（F4）→ 按类型分组的资产卡（可展开证据）。
 * 卡片复用共享 AssetCard（components/asset/AssetCard）＋ 领域映射 asset-domain，
 * 不再自建 `_evidence-card` 一套（防任务六第三套卡片）。
 */

import { useTranslation } from 'react-i18next';
import { Alert, StatusTip, Text } from 'tea-component';
import { StatusTag, type StatusTheme } from '@/components/StatusTag';
import { AssetCard } from '@/components/asset/AssetCard';
import { effMeta, typeLabel, stageLabel, fmtTime, type TFunc } from '@/components/asset/asset-domain';
import type { EvidenceEvent, ReceiptAsset, ReceiptData } from '@/lib/api/evidence';
import '../styles/evidence.css';

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
        return <StatusTag key={b.key} label={`${m.icon} ${m.label} ${b.count}`} theme={m.theme} />;
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
      {issues.map((ci) => {
        // 把「问题句」加粗、后段解释句保持常规：后端 message 形如
        // "资产 X 标记为「已验证」但没有 used 事件——仅注入/召回不能支撑「验证有效」。"
        const sep = ci.message.indexOf('——');
        const head = sep >= 0 ? ci.message.slice(0, sep) : ci.message;
        const tail = sep >= 0 ? ci.message.slice(sep) : '';
        return (
          <div key={ci.asset_id + ci.missing} className="_evidence-chain-row">
            {ci.level === 'error' ? '🔴' : '🟡'} [{ci.level}]{' '}
            <strong>{head}</strong>{tail}
          </div>
        );
      })}
    </Alert>
  );
}

/** 单条证据事件行（展开区）。默认只给一行摘要；含 outcome/code_diff/correlation 时再包一层内层展开，避免默认铺开。 */
function EvidenceRow({ ev }: { ev: EvidenceEvent }) {
  const { t } = useTranslation();
  const stages = stageLabel(t);
  const evd = ev.evidence;
  const tc = evd?.tool_call;
  const tr = evd?.test_result;
  let desc = t('evidence.label.no_evidence');
  if (tr) desc = `[${tr.runner}] exit=${tr.exitCode} ${(tr.output ?? '').slice(0, 60)}`;
  else if (tc) desc = `${tc.bridge}/${tc.endpoint}${tc.query ? ` · query="${tc.query.slice(0, 50)}"` : ''}`;
  // 多行证据（结果/变更/归因）默认折叠：只在用户点开这一行时展示。
  const detail = [evd?.outcome && `结果: ${evd.outcome}`, evd?.code_diff && `diff: ${(evd.code_diff as string).slice(0, 120)}`]
    .filter(Boolean)
    .join('\n');
  const corr = evd?.correlation as { heuristic?: boolean; hits?: string[] } | undefined;
  const corrLine = corr?.heuristic && corr.hits
    ? `归因:token-overlap[${corr.hits.slice(0, 6).join(',')}]${corr.hits.length > 6 ? ',…' : ''}（启发式非因果）`
    : '';
  const hasNest = Boolean(detail || corrLine);
  return (
    <div className="_evidence-row">
      <span className="_evidence-row-stage">[{stages[ev.stage] ?? ev.stage}]</span>
      <span className="_evidence-row-time">{fmtTime(ev.created_at)}</span>
      {typeof ev.turn_seq === 'number' && <span className="_evidence-row-turn">{t('evidence.label.turn', { n: ev.turn_seq })}</span>}
      {hasNest ? (
        <details className="_evidence-details _evidence-row-desc">
          <summary className="_evidence-row-summary">{desc}</summary>
          <div className="_evidence-row-detail">
            {detail && <div className="_evidence-row-detail-line">{detail}</div>}
            {corrLine && <div className="_evidence-row-detail-line">{corrLine}</div>}
          </div>
        </details>
      ) : (
        <span className="_evidence-row-desc">{desc}</span>
      )}
    </div>
  );
}

/** 把 ReceiptAsset 映射为共享 AssetCard 的 props（领域映射走 asset-domain）。 */
function assetToCardProps(asset: ReceiptAsset, t: TFunc) {
  const eff = effMeta(t);
  const types = typeLabel(t);
  const stages = stageLabel(t);
  const m = eff[asset.effectiveness] ?? eff.reference_only;
  const stagePath = asset.stages.map((s) => stages[s] ?? s);
  return {
    name: asset.name || asset.asset_id,
    version: asset.version,
    source: asset.source,
    typeLabel: types[asset.asset_type] ?? asset.asset_type,
    status: { icon: m.icon, label: m.label, theme: m.theme as StatusTheme },
    stages: stagePath,
    risks: asset.risks,
  };
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
          {assets.map((a) => (
            <AssetCard key={a.asset_id} {...assetToCardProps(a, t)} expandSummary={`${t('evidence.label.evidence_decision')}（${a.events.length} 条事件）`}>
              {a.events.map((ev) => <EvidenceRow key={ev.id} ev={ev} />)}
            </AssetCard>
          ))}
        </div>
      ))}
    </div>
  );
}

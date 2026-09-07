/**
 * EvidenceDetail — 回执详情区（左侧会话列表选中后显示）。
 *
 * 结构：有效性汇总条 → 证据链完整性提醒（F4）→ 按类型分组的资产卡（可展开证据）。
 * 卡片复用共享 AssetCard（components/asset/AssetCard）＋ 领域映射 asset-domain，
 * 不再自建 `_evidence-card` 一套（防任务六第三套卡片）。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StatusTip, Text } from 'tea-component';
import { StatusTag, type StatusTheme } from '@/components/StatusTag';
import { AssetCard } from '@/components/asset/AssetCard';
import { effMeta, typeLabel, stageLabel, fmtTime, naturalTrunc, type TFunc } from '@/components/asset/asset-domain';
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

/** 可展开的长文本：默认折叠成首段 + 自然截断（尾部不切词），点「展开/收起」切换显示全文（而非硬切丢内容）。 */
function ExpandableText({ text, limit, className }: { text: string; limit: number; className?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > limit;
  const shown = truncated && !expanded ? naturalTrunc(text, limit) : text;
  return (
    <span className={className}>
      {shown}
      {truncated && (
        <button type="button" className="_evidence-expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('evidence.label.collapse') : t('evidence.label.expand')}
        </button>
      )}
    </span>
  );
}

/** 单条证据事件行（展开区）。默认只给一行摘要；含 outcome/code_diff/correlation 时再包一层内层展开，避免默认铺开。 */
function EvidenceRow({ ev }: { ev: EvidenceEvent }) {
  const { t } = useTranslation();
  const stages = stageLabel(t);
  const evd = ev.evidence;
  const tc = evd?.tool_call;
  const tr = evd?.test_result;
  const hasContent = Boolean(evd && Object.keys(evd).length > 0);
  let desc = t('evidence.label.no_evidence');
  if (tr) desc = `[${tr.runner}] exit=${tr.exitCode} ${naturalTrunc(tr.output ?? '', 60)}`;
  else if (tc) desc = `${tc.bridge}/${tc.endpoint}${tc.query ? ` · query="${naturalTrunc(tc.query ?? '', 50)}"` : ''}`;
  // 桥接事件只有 tool_call 而无正文/结果/变更/归因 → 显式标注"无正文"，避免证据量超实际可审计内容。
  const noBody = Boolean(tc) && !evd?.outcome && !evd?.code_diff && !evd?.correlation && !tr;
  // 多行证据（结果/变更/归因）默认折叠：只在用户点开这一行时展示。
  const detail = [evd?.outcome && `结果: ${evd.outcome}`, evd?.code_diff && `diff: ${evd.code_diff as string}`]
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
      {typeof ev.turn_seq === 'number'
        ? <span className="_evidence-row-turn">{t('evidence.label.turn', { n: ev.turn_seq })}</span>
        : hasContent && <span className="_evidence-row-missing">{t('evidence.label.no_turn')}</span>}
      {hasNest ? (
        <details className="_evidence-details _evidence-row-desc">
          <summary className="_evidence-row-summary">{desc}</summary>
          <div className="_evidence-row-detail">
            {detail && (
              <div className="_evidence-row-detail-line">
                <ExpandableText text={detail} limit={140} />
              </div>
            )}
            {corrLine && <div className="_evidence-row-detail-line">{corrLine}</div>}
          </div>
        </details>
      ) : (
        <span className="_evidence-row-desc">
          {desc}{noBody && <span className="_evidence-row-missing">{t('evidence.label.no_body')}</span>}
        </span>
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

/** 回执资产按来源归属的池子：团队池（team / 借调来源）vs Agent 自有（self）。 */
export type ReceiptScope = 'team' | 'self';

export const RECEIPT_SCOPE_TAB: Record<ReceiptScope, string> = {
  team: 'evidence.scope.team',
  self: 'evidence.scope.self',
};

/** 来源池 → 展示徽标文案键（团队池 / Agent 自有）；借调来源另附 source 原始值。 */
function poolBadge(a: ReceiptAsset): ReceiptScope {
  return a.source === 'self' ? 'self' : 'team';
}

/** 资产来源徽标文案：团队池 / Agent 自有；若为具体借调 agent_id 则附上，便于溯源。 */
function poolLabel(a: ReceiptAsset, t: TFunc): string {
  const base = t(RECEIPT_SCOPE_TAB[poolBadge(a)]);
  return a.source && a.source !== 'self' && a.source !== 'team' ? `${base} · ${a.source}` : base;
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

  // 按类型分组（全会话资产，不按来源池过滤），组内 reference_only 排最后。
  // 资产「团队池 / Agent 自有」以每卡上的来源徽标呈现（poolLabel），不做切换过滤。
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
            <AssetCard
              key={a.asset_id}
              {...assetToCardProps(a, t)}
              source={poolLabel(a, t)}
              expandSummary={`${t('evidence.label.evidence_decision')}（${a.events.length} 条事件）`}
            >
              {a.events.map((ev) => <EvidenceRow key={ev.id} ev={ev} />)}
            </AssetCard>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 把回执渲染为 Markdown（供「导出回执」下载）。
 * 复用 asset-domain 的阶段/有效性/类型映射与来源池徽标，结构与 mem:receipt 对齐。
 */
export function renderReceiptMarkdown(receipt: ReceiptData, t: TFunc): string {
  const eff = effMeta(t);
  const types = typeLabel(t);
  const stages = stageLabel(t);
  const effLabel = (k: string): string => eff[k]?.label ?? k;
  // 有效性汇总（按资产去重）。
  const counts: Record<string, number> = {};
  for (const a of receipt.assets) counts[a.effectiveness] = (counts[a.effectiveness] ?? 0) + 1;
  const effLine = Object.entries(counts)
    .map(([k, n]) => `${effLabel(k)} ${n}`)
    .join(' · ');

  const lines: string[] = [];
  lines.push(`## 📋 资产使用回执（${receipt.session_key}）`, '');
  lines.push(`本次应用 ${receipt.assets.length} 项团队资产`);
  if (effLine) lines.push(`**有效性：** ${effLine}`, '');

  for (const a of receipt.assets) {
    const type = types[a.asset_type] ?? a.asset_type;
    lines.push(`### ${a.name || a.asset_id}（${type}） · ${poolLabel(a, t)}`, '');
    const stagePath = a.stages.map((s) => stages[s] ?? s).join(' → ');
    lines.push(`- 阶段：${stagePath || '—'}`);
    if (a.risks.length > 0) {
      const riskLine = a.risks.map((r) => `[${r.level}] ${r.messageKey ? t(r.messageKey) : r.detail ?? r.messageKey}`).join('；');
      lines.push(`- 风险：${riskLine}`);
    }
    lines.push(`- 证据（${a.events.length} 条）：`);
    for (const ev of a.events) {
      const evd = ev.evidence;
      const tc = evd?.tool_call;
      const tr = evd?.test_result;
      let desc = '（无证据）';
      if (tr) desc = `[${tr.runner}] exit=${tr.exitCode}`;
      else if (tc) desc = `${tc.bridge}/${tc.endpoint}${tc.query ? ` · query="${tc.query}"` : ''}`;
      else if (evd?.outcome) desc = `结果: ${evd.outcome}`;
      else if (evd?.code_diff) desc = `diff: ${evd.code_diff}`;
      const turn = typeof ev.turn_seq === 'number' ? ` · 第 ${ev.turn_seq} 轮` : '';
      lines.push(`  - [${stages[ev.stage] ?? ev.stage}] ${fmtTime(ev.created_at)}${turn} · ${desc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * ReviewPanel — 候选资产审核页（任务六「候选资产生命周期」可视化）。
 *
 * 布局对齐 Evidence/Skills 页：AssetPageHeader（标题+刷新）
 * → AssetSplitLayout（左侧候选列表 / 右侧详情 + 批准/拒绝）。
 *
 * 数据来自 meta asset/list?status=candidate（审核专用，与 proxy mem:review CLI 同源）。
 * 批准 = status→approved + （skill 且含正文时）落地 skill 域；拒绝 = status→failed 保留审计。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip, Text } from 'tea-component';
import { useTeams } from '@/stores/backend';
import { reviewApi, parseCandidateMeta, type CandidateMeta } from '@/lib/api/review';
import type { Asset } from '@/lib/api/types';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemBadges,
  AssetBadge,
  AssetItemMeta,
} from '@/components/asset/AssetListPanel';
import i18n from '@/i18n';
import './review.css';

function fmtTime(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(i18n.language, { hour12: false });
}

/** 风险徽章前缀（纯文本徽章，用 emoji 区分等级）。 */
function riskIcon(risk?: string): string {
  if (risk === 'high') return '🔴';
  if (risk === 'medium') return '🟡';
  if (risk === 'low') return '🟢';
  return '⚪';
}

export default function ReviewPanel() {
  const { t } = useTranslation();
  const { activeTeamId } = useTeams();

  const [candidates, setCandidates] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  // error 与 notice 分离（P1-2）：error 渲染 StatusTip status="error"，
  // notice 渲染 StatusTip status="success"，避免成功消息用错误样式展示。
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadCandidates = useCallback(() => {
    if (!activeTeamId) return;
    setLoading(true);
    setError(null);
    reviewApi
      .listCandidates(activeTeamId)
      .then((items) => {
        setCandidates(items);
        setSelectedId((prev) => (prev && items.some((a) => a.asset_id === prev) ? prev : (items[0]?.asset_id ?? '')));
      })
      .catch(() => setError(t('review.load_error')))
      .finally(() => setLoading(false));
  }, [activeTeamId, t]);

  useEffect(() => {
    if (activeTeamId) loadCandidates();
  }, [activeTeamId, loadCandidates]);

  const selected = candidates.find((a) => a.asset_id === selectedId) ?? null;
  const meta: CandidateMeta = selected ? parseCandidateMeta(selected) : {};

  const approve = useCallback(async () => {
    if (!activeTeamId || !selected) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const r = await reviewApi.approve(activeTeamId, selected);
      // 根据落地结果走 success 通道（P1-3：未落地 skill 域时明确提示，不静默）。
      if (r.landing === 'created') setNotice(t('review.approved_with_skill', { id: r.skill_id ?? '' }));
      else if (r.landing === 'reused') setNotice(t('review.approved_reused', { id: r.skill_id ?? '' }));
      else setNotice(t('review.approved_skipped'));
      await loadCandidates();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }, [activeTeamId, selected, loadCandidates, t]);

  const reject = useCallback(async () => {
    if (!activeTeamId || !selected) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      await reviewApi.reject(selected, rejectReason.trim() || undefined);
      setRejectReason('');
      setNotice(t('review.rejected'));
      await loadCandidates();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }, [selected, rejectReason, loadCandidates, t]);

  return (
    <div className="_review-body">
      <AssetPageHeader
        title={t('review.title')}
        scope={undefined}
        subtitle={candidates.length > 0 ? t('review.subtitle', { count: candidates.length }) : undefined}
        actions={
          <Button type="primary" onClick={loadCandidates} loading={loading}>
            {t('review.refresh')}
          </Button>
        }
      />

      <AssetSplitLayout
        storageKey="review:assetSplitWidth"
        sidebar={
          <AssetListPanel
            title={t('review.list.title')}
            count={candidates.length > 0 ? `${candidates.length}` : undefined}
            loading={loading}
            items={candidates}
            selectedId={selectedId || null}
            getItemId={(a) => a.asset_id}
            onSelect={(a) => setSelectedId(a.asset_id)}
            emptyText={t('review.list.empty')}
            renderItem={(a) => {
              const m = parseCandidateMeta(a);
              return (
                <>
                  <AssetItemHeader>
                    <AssetItemName title={a.name}>{a.name}</AssetItemName>
                  </AssetItemHeader>
                  <AssetItemBadges>
                    {m.bucket && <AssetBadge>{m.bucket}</AssetBadge>}
                    {m.risk && (
                      <AssetBadge title={`risk: ${m.risk}`}>{riskIcon(m.risk)} {m.risk}</AssetBadge>
                    )}
                    <AssetBadge>{a.asset_type}</AssetBadge>
                    {a.status === 'draft' && <AssetBadge title="draft">📝 draft</AssetBadge>}
                  </AssetItemBadges>
                  <AssetItemMeta>
                    <span className="_review-item-meta">{a.owner_user_id}</span>
                  </AssetItemMeta>
                </>
              );
            }}
          />
        }
        detail={
          <div className="_review-detail">
            {notice && (
              <Alert type="success" className="_review-notice">{notice}</Alert>
            )}
            {loading ? (
              <StatusTip status="loading" loadingText={t('review.loading')} />
            ) : error ? (
              <StatusTip status="error" errorText={error} retryText={t('review.retry')} onRetry={loadCandidates} />
            ) : !selected ? (
              <StatusTip status="empty" emptyText={t('review.detail.empty')} />
            ) : (
              <div className="_review-detail-card">
                <div className="_review-detail-title">{selected.name}</div>
                <div className="_review-detail-meta">
                  <Text theme="label">asset_id：</Text>
                  <span className="_review-mono">{selected.asset_id}</span>
                </div>

                <div className="_review-detail-section">
                  <Text theme="label">{t('review.field.source')}</Text>
                  <div className="_review-detail-value">
                    {meta.source ? `${meta.source.kind}: ${meta.source.ref}` : (selected.source_ref ?? '—')}
                  </div>
                </div>

                <div className="_review-detail-section">
                  <Text theme="label">{t('review.field.bucket')} / {t('review.field.risk')}</Text>
                  <div className="_review-detail-value">
                    {meta.bucket ?? '—'} · {meta.risk ?? '—'}
                    {selected.description ? ` · ${selected.description}` : ''}
                  </div>
                </div>

                {meta.evidence && (
                  <div className="_review-detail-section">
                    <Text theme="label">{t('review.field.evidence')}</Text>
                    <div className="_review-detail-value">
                      validated={meta.evidence.validated ? 'true' : 'false'}
                      {meta.evidence.resultRef ? ` · ${meta.evidence.resultRef}` : ''}
                      {meta.evidence.at ? ` · ${fmtTime(meta.evidence.at)}` : ''}
                    </div>
                  </div>
                )}

                {meta.reject_reason && (
                  <div className="_review-detail-section _review-reject-info">
                    <Text theme="label">{t('review.field.reject_reason')}</Text>
                    <div className="_review-detail-value">
                      {meta.reject_reason}{meta.rejected_by ? `（by ${meta.rejected_by}）` : ''}
                    </div>
                  </div>
                )}

                <div className="_review-detail-section">
                  <Text theme="label">{t('review.field.content')}</Text>
                  <pre className="_review-content">{meta.content ?? t('review.no_content')}</pre>
                </div>

                <div className="_review-actions">
                  <input
                    className="_review-reject-input"
                    placeholder={t('review.reject_placeholder')}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <Button type="weak" onClick={reject} disabled={acting || !['candidate', 'draft'].includes(selected.status)}>
                    {t('review.reject')}
                  </Button>
                  <Button type="primary" onClick={approve} disabled={acting || !['candidate', 'draft'].includes(selected.status)}>
                    {t('review.approve')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        }
      />
    </div>
  );
}

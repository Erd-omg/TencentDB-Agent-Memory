/**
 * EvidencePanel — 资产使用回执面板（任务四 可视化页）。
 *
 * 布局与 Skills/ChatMemory 页对齐：AssetPageHeader（标题 + 刷新）
 * → AssetSplitLayout（左侧会话列表 / 右侧回执详情）。
 *
 * 数据来自 proxy asset_event 表（与 mem:receipt 同源，非 LLM 自述）：
 *   - 左侧：/evidence/sessions → 最近有证据的会话（session_key + 事件数 + 最近活动）
 *   - 右侧：/evidence/receipt → 结构化回执（汇总条 / 完整性提醒 / 分组资产卡 / 可展开证据）
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { useSearchParams } from 'react-router-dom';

import {
  listEvidenceSessions,
  getReceipt,
  type EvidenceSession,
  type ReceiptData,
} from '@/lib/api/evidence';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemBadges,
  AssetBadge,
  AssetItemMeta,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import EvidenceDetail, { renderReceiptMarkdown } from './EvidenceDetail';
import '../styles/evidence.css';

function shortKey(key: string): string {
  if (key.length <= 24) return key;
  return `${key.slice(0, 12)}…${key.slice(-8)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export default function EvidencePanel() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [sessions, setSessions] = useState<EvidenceSession[]>([]);
  const [selected, setSelected] = useState('');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingReceipt, setLoadingReceipt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ⑨ 深链预选：#/evidence?session=<session_key> → 打开即定位该会话（mem:receipt 输出）。
  useEffect(() => {
    const urlSession = searchParams.get('session');
    if (urlSession) setSelected(urlSession);
  }, [searchParams]);

  const loadSessions = useCallback(() => {
    setLoadingSessions(true);
    setError(null);
    listEvidenceSessions()
      .then((s) => {
        setSessions(s);
        // 首次加载自动选中最近会话；刷新时保留当前选中。
        setSelected((prev) => (prev ? prev : (s[0]?.sessionKey ?? '')));
      })
      .catch(() => setError(t('evidence.load_sessions_error')))
      .finally(() => setLoadingSessions(false));
  }, [t]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!selected) {
      setReceipt(null);
      return;
    }
    let cancelled = false;
    setLoadingReceipt(true);
    setError(null);
    getReceipt(selected)
      .then((r) => {
        if (!cancelled) setReceipt(r);
      })
      .catch(() => {
        if (!cancelled) setError(t('evidence.load_receipt_error'));
      })
      .finally(() => {
        if (!cancelled) setLoadingReceipt(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, t]);

  const reloadReceipt = useCallback(() => {
    if (!selected) return;
    setLoadingReceipt(true);
    setError(null);
    getReceipt(selected)
      .then(setReceipt)
      .catch(() => setError(t('evidence.load_receipt_error')))
      .finally(() => setLoadingReceipt(false));
  }, [selected, t]);

  // 导出回执：把结构化 ReceiptData 渲染成 Markdown 并下载 .md 文件。
  const exportReceipt = useCallback(() => {
    if (!receipt) return;
    const md = renderReceiptMarkdown(receipt, t);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asset-receipt-${receipt.session_key}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [receipt, t]);

  return (
    <div className="_memory-evidence-body">
      <AssetPageHeader
        title={t('evidence.title')}
        scope={undefined}
        subtitle={sessions.length > 0 ? t('evidence.subtitle', { count: sessions.length }) : undefined}
        actions={
          <>
            <Button onClick={exportReceipt} disabled={!receipt} tooltip={!receipt ? t('evidence.export.noReceipt') : undefined}>
              {t('evidence.export')}
            </Button>
            <Button type="primary" onClick={loadSessions}>
              {t('evidence.refresh')}
            </Button>
          </>
        }
      />

      <AssetSplitLayout
        storageKey="evidence:assetSplitWidth"
        sidebar={
          <AssetListPanel
            title={t('evidence.sessions.title')}
            count={sessions.length > 0 ? `${sessions.length}` : undefined}
            loading={loadingSessions}
            items={sessions}
            selectedId={selected || null}
            getItemId={(s) => s.sessionKey}
            onSelect={(s) => setSelected(s.sessionKey)}
            emptyText={t('evidence.sessions.empty')}
            renderItem={(s) => (
              <>
                <AssetItemHeader>
                  <AssetItemName title={s.sessionKey}>{shortKey(s.sessionKey)}</AssetItemName>
                </AssetItemHeader>
                <AssetItemBadges>
                  <AssetBadge>{s.eventCount} 事件</AssetBadge>
                </AssetItemBadges>
                <AssetItemMeta>
                  <AssetItemTime>{fmtTime(s.lastActivity)}</AssetItemTime>
                </AssetItemMeta>
              </>
            )}
          />
        }
        detail={
          <EvidenceDetail
            receipt={receipt}
            loading={loadingReceipt}
            error={error}
            onRetry={reloadReceipt}
          />
        }
      />
    </div>
  );
}

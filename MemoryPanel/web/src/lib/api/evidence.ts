/**
 * api/evidence.ts — 资产证据链回执（任务四）前端 API。
 *
 * 数据来自 proxy 本地 asset_event 表（非 LLM 自述），Panel 后端 /api/v1/evidence/*
 * 只读转发到 proxy /v3/evidence/*。GET 请求注入 X-Tdai-Service-Id / X-Tdai-User-Key
 * 会话头（与其它面板 API 一致）。
 */

import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';

/** 有证据事件的会话（/evidence/sessions 返回）。 */
export interface EvidenceSession {
  sessionKey: string;
  sessionId?: string | null;
  eventCount: number;
  lastActivity: number;
  stageCounts: Record<string, number>;
}

/** 单条 asset_event（/evidence/events 返回，证据展开用）。 */
export interface EvidenceEvent {
  id: string;
  stage: string;
  session_id?: string;
  task_id?: string;
  turn_seq?: number;
  evidence?: {
    tool_call?: { bridge?: string; endpoint?: string; query?: string; httpStatus?: number };
    test_result?: { runner?: string; exitCode?: number; output?: string; durationMs?: number };
    [k: string]: unknown;
  };
  created_at: number;
}

/** 回执资产卡（/evidence/receipt 返回）。 */
export interface ReceiptAsset {
  asset_id: string;
  asset_type: string;
  name?: string;
  version?: string | number;
  source?: string;
  score?: number;
  stages: string[];
  last_stage_at: Record<string, number>;
  effectiveness: string;
  risks: Array<{ level: string; label: string; detail?: string }>;
  events: EvidenceEvent[];
}

/** 结构化回执数据。 */
export interface ReceiptData {
  session_key: string;
  asset_count: number;
  /** 事件口径阶段计数（每轮缓存重打会累加，如 injected）。 */
  stage_counts: Record<string, number>;
  /** 按资产去重口径阶段计数（= 回执正文「证据链（按资产去重）」；与 stage_counts 两口径并存）。 */
  distinct_stage_counts?: Record<string, number>;
  effectiveness: Record<string, number>;
  chain_issues: Array<{ level: string; asset_id: string; missing: string; message: string }>;
  assets: ReceiptAsset[];
}

interface Envelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

function sessionHeaders(): Record<string, string> {
  const s = getPanelSession();
  return s ? { 'X-Tdai-Service-Id': s.instanceId, 'X-Tdai-User-Key': s.userKey } : {};
}

/** 最近有证据的会话列表。 */
export async function listEvidenceSessions(): Promise<EvidenceSession[]> {
  const res = await request<Envelope<EvidenceSession[]>>(
    'GET',
    '/api/v1/evidence/sessions?limit=30',
    undefined,
    sessionHeaders(),
  );
  return res.data ?? [];
}

/** 某会话的结构化回执；无证据（404）→ null，其它错误（500/502/401）向上抛给 UI 错误态。 */
export async function getReceipt(sessionKey: string): Promise<ReceiptData | null> {
  try {
    const res = await request<Envelope<ReceiptData>>(
      'GET',
      `/api/v1/evidence/receipt?session_key=${encodeURIComponent(sessionKey)}`,
      undefined,
      sessionHeaders(),
    );
    return res.data ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null; // 该会话无证据 = 合法空态
    throw err; // 其它错误（proxy 不可用/401/5xx）→ 让页面显示错误而非静默空态
  }
}

/**
 * /v3/evidence/* — 资产证据链只读 HTTP API（任务四 回执可视化 + Panel 集成）。
 *
 * 数据来自 proxy 本地 asset_event 表（非 LLM 自述），聚合逻辑与 mem:receipt 共享
 * （evidence/receipt-data.ts）。只读 GET；鉴权走 config.admin.apiKey（空则公开，
 * 与 /v3/session/* 现语义一致）。加 CORS 头支持浏览器直连演示 / Panel 直连。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getAssetEventRepo } from "../db/assetEventRepo.js";
import { buildReceiptData, buildReceiptJson } from "../evidence/receipt-data.js";
import { checkAdminAuth, adminAuthError } from "./admin-auth.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Tdai-Service-Id, X-Tdai-User-Key, Content-Type",
};

function envelope(code: number, message: string, data?: unknown, requestId = `evidence-${Date.now()}`): Record<string, unknown> {
  return { code, message, request_id: requestId, ...(data === undefined ? {} : { data }) };
}

/** 原始事件的安全序列化（与 buildReceiptJson 里的 eventJson 对齐）。 */
function eventJson(e: {
  id: string; stage: string; sessionId?: string; taskId?: string; turnSeq?: number;
  evidence?: unknown; createdAt: number;
}): Record<string, unknown> {
  return {
    id: e.id,
    stage: e.stage,
    session_id: e.sessionId,
    task_id: e.taskId,
    turn_seq: e.turnSeq,
    evidence: e.evidence,
    created_at: e.createdAt,
  };
}

function requireAuth(c: Context, config: ProxyConfig): Response | null {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);
  return null;
}

export function createEvidenceHandlers(config: ProxyConfig): {
  sessions(c: Context): Response;
  receipt(c: Context): Response;
  events(c: Context): Response;
} {
  /** GET /v3/evidence/sessions?limit=20 — 最近有证据的会话列表。 */
  const sessions = (c: Context): Response => {
    const denied = requireAuth(c, config);
    if (denied) return denied;
    const repo = getAssetEventRepo();
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    const data = repo ? repo.recentSessions(limit) : [];
    return c.json(envelope(0, "ok", data), 200, CORS_HEADERS);
  };

  /** GET /v3/evidence/receipt?session_key=… — 结构化回执 JSON。 */
  const receipt = (c: Context): Response => {
    const denied = requireAuth(c, config);
    if (denied) return denied;
    const sessionKey = c.req.query("session_key");
    if (!sessionKey || !sessionKey.trim()) {
      return c.json(envelope(40001, "missing session_key"), 400, CORS_HEADERS);
    }
    const data = buildReceiptData(sessionKey);
    if (!data) {
      return c.json(envelope(40401, `no asset evidence for session ${sessionKey}`), 404, CORS_HEADERS);
    }
    return c.json(envelope(0, "ok", buildReceiptJson(data)), 200, CORS_HEADERS);
  };

  /** GET /v3/evidence/events?session_key=… — 原始事件流。 */
  const events = (c: Context): Response => {
    const denied = requireAuth(c, config);
    if (denied) return denied;
    const sessionKey = c.req.query("session_key");
    if (!sessionKey || !sessionKey.trim()) {
      return c.json(envelope(40001, "missing session_key"), 400, CORS_HEADERS);
    }
    const repo = getAssetEventRepo();
    const data = repo ? repo.bySessionKey(sessionKey).map(eventJson) : [];
    return c.json(envelope(0, "ok", data), 200, CORS_HEADERS);
  };

  return { sessions, receipt, events };
}

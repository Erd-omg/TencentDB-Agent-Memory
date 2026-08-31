/**
 * 资产证据链回执只读代理（任务四）：GET /api/v1/evidence/* → proxy GET /v3/evidence/*。
 *
 * 数据在 proxy 本地 asset_event 表，聚合与 mem:receipt 同源（evidence/receipt-data.ts）。
 * 只读透传：保留 proxy 的 {code,message,request_id,data} 信封，非 2xx 映射到同状态。
 *
 * 目标 base：优先按 X-Tdai-Service-Id 查实例 proxy_endpoint（本地开源部署 core 与
 * proxy 分开跑时显式填），回退 config.evidence.proxyBaseUrl。adminKey 非空时带
 * Authorization: Bearer（对应 proxy config.admin.apiKey；proxy 侧 key 为空则开放只读）。
 */

import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { META_HEADER_USER_KEY } from '../../kernel/headers.js';
import { respondControlError } from '../envelope.js';

const EVIDENCE_KINDS = new Set(['sessions', 'receipt', 'events']);

/** 解析目标 proxy base：实例 proxy_endpoint 优先，回退全局配置。 */
function resolveProxyBase(deps: PanelDeps, serviceId: string): string {
  if (serviceId) {
    try {
      const instance = deps.instanceRegistry.resolve(serviceId);
      if (instance.proxy_endpoint) return instance.proxy_endpoint.replace(/\/$/, '');
    } catch {
      // 未知实例 → 回退全局配置
    }
  }
  return deps.config.evidence.proxyBaseUrl.replace(/\/$/, '');
}

export function registerEvidenceRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/evidence/:kind', async (c) => {
    // 登录门（P1-3）：证据数据面要求面板登录会话头（X-Tdai-User-Key），
    // 与其它面板 API（validatePanelMetaHeaders）口径一致，阻断未登录 curl。
    // 注：service-id 保持可选（本地部署无实例时回退 EVIDENCE_PROXY_BASE_URL）。
    if (!c.req.header(META_HEADER_USER_KEY)?.trim()) {
      return respondControlError(c, 401, 'MISSING_USER_KEY');
    }

    const kind = c.req.param('kind');
    if (!EVIDENCE_KINDS.has(kind)) {
      return respondControlError(c, 404, 'UNKNOWN_EVIDENCE_PATH');
    }

    const serviceId = c.req.header('x-tdai-service-id') ?? '';
    const base = resolveProxyBase(deps, serviceId);
    const qs = c.req.raw.url.includes('?') ? c.req.raw.url.split('?')[1] : '';
    const url = `${base}/v3/evidence/${kind}${qs ? `?${qs}` : ''}`;

    const headers: Record<string, string> = { accept: 'application/json' };
    if (deps.config.evidence.adminKey) headers.authorization = `Bearer ${deps.config.evidence.adminKey}`;

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      deps.logger.error('evidence proxy upstream unavailable', {
        err: err instanceof Error ? err.message : String(err),
        kind,
        url,
      });
      return respondControlError(c, 502, 'EVIDENCE_PROXY_UNAVAILABLE');
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}

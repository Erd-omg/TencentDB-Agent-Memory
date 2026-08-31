/**
 * EvidenceTracingObserver — 注入管线证据跟踪观察者（任务三 `injected` 证据）。
 *
 * 职责：在管线 onHookDone 时，读取每个产出块上 injector 打的 assets 标记
 * （见 evidence.ts），逐资产落一条 `injected` asset_event。它是现有观察者
 * （Langfuse / Logging / Noop）的**包装器**——所有方法先处理后转发给内层，
 * 因此不会改变既有观察语义。
 *
 * 原则（与 observer.ts 一致）：
 *   - fire-and-forget：内部异常绝不传播到管线（safeCall 包裹）。
 *   - 静默降级：DB 不可用（getAssetEventRepo()=null）或没有可归因的
 *     sessionKey 时直接跳过。
 *   - 会话内缓存块（session_init）同样带 assets 标记 → 每轮注入都留证据，
 *     这是正确的（资产确实每轮都进了 prompt）。
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import type { InjectionObserver, HookResult } from "./observer.js";
import { getAssetEventRepo } from "../db/assetEventRepo.js";
import type { AssetRef } from "../db/asset-event.js";
import { evidenceContextFromMeta, getBlockAssets } from "./evidence.js";

/** 安全调用：任何异常静默吞掉，绝不影响管线。 */
function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    /* observer must never throw */
  }
}

export class EvidenceTracingObserver implements InjectionObserver {
  private meta: AgentContextMetadata | null = null;

  constructor(private inner: InjectionObserver) {}

  onPipelineStart(meta: AgentContextMetadata): void {
    this.meta = meta;
    safeCall(() => this.inner.onPipelineStart(meta));
  }

  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void {
    safeCall(() => this.inner.onPipelineEnd(meta, durationMs, results));
    this.meta = null;
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    safeCall(() => this.inner.onPipelineError(meta, error));
    this.meta = null;
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    safeCall(() => this.inner.onHookStart(hook, point));
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    this.traceInjected(blocks, hook, point);
    safeCall(() => this.inner.onHookDone(hook, point, blocks, durationMs, cacheStrategy));
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    safeCall(() => this.inner.onHookError(hook, point, error, durationMs));
  }

  /** 从产出块读 assets 标记 → 逐资产写 `injected` 事件。 */
  private traceInjected(
    blocks: ContextBlock[],
    hook: InjectionHook,
    point: InjectionPoint,
  ): void {
    try {
      if (!this.meta) return;
      const ctx = evidenceContextFromMeta(this.meta);
      if (!ctx) return; // 无可归因会话 → 跳过

      const repo = getAssetEventRepo();
      if (!repo) return; // DB 不可用 → 持久化降级

      for (const block of blocks) {
        const assets = getBlockAssets(block);
        if (assets.length === 0) continue;
        for (const asset of assets) {
          const evt = repo.newEvent({
            stage: "injected",
            // 缺 source 时默认 self（注入列表通常是 agent 自有的）。
            asset: asset.source ? asset : { ...asset, source: "self" },
            ...ctx,
            evidence: {
              decision: `injected by ${hook.id} at ${point}`,
            },
          });
          repo.insert(evt);
        }
      }
    } catch {
      /* 证据跟踪失败绝不阻塞管线 */
    }
  }
}

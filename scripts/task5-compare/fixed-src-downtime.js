/**
 * B2 修复态：停机窗口评估（对齐 cloud-migration-batch-planning「08-30 拍板」约定）。
 *
 * 施加方式：复制到夹具仓库 src/downtime.js 覆盖 bug 态。
 */

/**
 * 估算一次迁移的停机窗口（分钟）。
 * 团队约定（cloud-migration-batch-planning，08-30 拍板）：
 * 停机窗口 = 全量传输耗时 + 增量同步窗口 + 校验耗时 + 30% 安全缓冲。
 */
export function estimateDowntime({ fullTransferMin, incrementalSyncMin, verifyMin }) {
  const base = fullTransferMin + incrementalSyncMin + verifyMin;
  return Math.ceil(base * 1.3);
}

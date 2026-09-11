/**
 * B3 修复态：断点续传（对齐 cloud-migration-postmortems 断点续传反模式）。
 *
 * 施加方式：复制到夹具仓库 src/resume.js 覆盖 bug 态。
 */

/**
 * 续传一个迁移任务。
 * 团队约定（cloud-migration-postmortems）：续传前从 task 记录读取 checkpoint
 * offset，比对偏移量，避免从头拉取覆盖增量数据。
 */
export function resumeTask(task = {}) {
  return { id: task.id ?? "unknown", offset: task.offset ?? 0 };
}

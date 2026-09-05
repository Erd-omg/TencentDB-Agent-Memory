/**
 * Windows 主机一键迁移编排（云主机迁移平台 v1）。
 *
 * 期望步骤顺序（与团队 skill「cloud-migration-postmortems」的 Windows 迁移反模式一致）：
 *   precheck → vss-snapshot → copy-data → apply-acl → verify → done
 * 不变式：**VSS 快照必须先于任何数据变更（尤其 ACL）**。因为失败回滚靠快照恢复源端，
 * 若在快照之前就改了 ACL，快照会把"半路写入的 ACL"也拍进去，回滚后 ACL 残留/状态与
 * 迁移前不一致（评审/验收即失败）。
 *
 * 本文件 = bug 修复后的规范实现（供 verify-task4-realfix.mjs 施加，代表按
 * cloud-migration-postmortems 修正的顺序：先拍快照 → 复制 → 再改 ACL）。
 */

export const STEP = Object.freeze({
  PRECHECK: "precheck",
  VSS_SNAPSHOT: "vss-snapshot",
  COPY_DATA: "copy-data",
  APPLY_ACL: "apply-acl",
  VERIFY: "verify",
  DONE: "done",
  ROLLBACK: "rollback",
});

/** 记录一步。 */
function step(host, name) {
  (host.steps ||= []).push(name);
  return host;
}

/** 预检：目标标识必须存在。 */
export function precheck(host) {
  if (!host || typeof host.dst !== "string" || host.dst.length === 0) {
    throw new Error("precheck 失败：缺少目标标识 host.dst");
  }
  step(host, STEP.PRECHECK);
  return host;
}

/** 打 VSS 快照：深拷贝当前数据作为回滚基线。 */
export function captureVssSnapshot(host) {
  host.snapshot = { data: structuredClone(host.data ?? {}) };
  step(host, STEP.VSS_SNAPSHOT);
  return host;
}

/** 复制数据（源端文件 → host.data.files）。 */
export function copyData(host) {
  host.data.files = { ...(host.data.files ?? {}), ...(host.files ?? {}) };
  step(host, STEP.COPY_DATA);
  return host;
}

/** 应用 ACL（合并进 data.acl）。 */
export function applyAcl(host, acl = {}) {
  host.data.acl = { ...(host.data.acl ?? {}), ...acl };
  step(host, STEP.APPLY_ACL);
  return host;
}

/** verify：复制完成且回滚基线存在。 */
export function verify(host) {
  const ok = host.data.files && Object.keys(host.data.files).length > 0;
  step(host, STEP.VERIFY);
  return ok;
}

/** 回滚：用快照恢复源端数据。 */
export function rollback(host) {
  if (!host.snapshot) {
    throw new Error("rollback 失败：无可用 VSS 快照");
  }
  host.data = structuredClone(host.snapshot.data);
  step(host, STEP.ROLLBACK);
  return host;
}

/**
 * 执行一次 Windows 迁移。
 *
 * @param {object} host { data, files, dst }  源端主机（会被变更）
 * @param {object} opts { acl, failVerify }
 * @returns {{ ok: boolean, steps: string[] }}
 */
export function migrateWindowsHost(host, { acl = {}, failVerify = false } = {}) {
  precheck(host);

  // ① 先打 VSS 快照（回滚基线）——必须在任何数据变更之前
  captureVssSnapshot(host);

  copyData(host);

  // ② 再应用 ACL
  applyAcl(host, acl);

  if (failVerify) {
    rollback(host);
    return { ok: false, steps: host.steps };
  }

  const ok = verify(host);
  if (ok) step(host, STEP.DONE);
  return { ok, steps: host.steps };
}

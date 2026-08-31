/**
 * 简短回执摘要（任务四 B 自动收尾用）—— 从 asset_event 聚合 2-3 行。
 *
 * 与完整 `mem:receipt` 的区别：自动追加的摘要要短（不刷屏），只给
 * "应用了几项资产 + 有效性概览 + 关键采用 + 查看入口"。完整回执仍由
 * `mem:receipt` 命令产出。
 */

import { getAssetEventRepo } from "../db/assetEventRepo.js";
import { effectivenessCounts } from "./effectiveness.js";

/** 生成会话的简短回执摘要；无可回溯证据时返回 null（不追加）。 */
export function renderReceiptSummary(sessionKey: string): string | null {
  const repo = getAssetEventRepo();
  if (!repo) return null;
  const events = repo.bySessionKey(sessionKey);
  if (events.length === 0) return null;

  const summaries = repo.distinctAssets(sessionKey);
  const eff = effectivenessCounts(summaries, events);
  const usedAssets = summaries
    .filter((s) => s.stages.includes("used"))
    .map((s) => s.asset.name || s.asset.assetId);

  const lines: string[] = [];
  lines.push("📋 资产使用回执（自动）");
  lines.push(
    `本次应用资产 ${summaries.length} 项 · 有效性：`
    + `已验证 ${eff.validated} / 复用 ${eff.reused} / 待验证 ${eff.adopted + eff.selected}`
    + `${eff.validated_no_use > 0 ? ` / ⚠️验证缺使用 ${eff.validated_no_use}` : ""}`
    + ` / 参考 ${eff.reference_only}${eff.corrected > 0 ? ` / 需修正 ${eff.corrected}` : ""}`,
  );
  if (usedAssets.length > 0) {
    lines.push(`关键采用：${usedAssets.slice(0, 3).join("、")}`);
  }
  lines.push("（输入 `mem:receipt` 查看完整回执）");
  return lines.join("\n");
}

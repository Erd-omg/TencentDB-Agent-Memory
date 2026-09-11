/**
 * api/review.ts — 候选资产审核（任务六「候选资产生命周期」Panel 审核页）。
 *
 * 数据来源与 proxy 侧 `mem:review` CLI 一致（design-156.md §8.6）：
 *   - 列表：meta `asset/list`（审核专用，不过滤 candidate/draft）+ status 过滤；
 *     draft 与 candidate 一并纳入审核列表（§4.3 二者同属「审核前不可见」）。
 *   - 批准：meta `asset/update` status→approved；skill 类候选 apply 后落地
 *     skill 域（幂等：按 name 命中唯一索引则复用）。Panel 走 meta 直连
 *     （不经 proxy mem 命令），故「落地 skill 域」在此显式组合，且与 CLI
 *     `resolveLandingAgentId` 对齐：统一用 team 首个 active agent 兜底。
 *   - 拒绝：meta `asset/update` status→failed + metadata_json 追加 reject 信息。
 *
 * 复用 assetsApi（meta）与 skill-api（listSkills/createSkill），不新造底层请求。
 */

import { assetsApi } from './assets';
import { agentsApi } from './agents';
import { createSkill, listSkills } from './skill-api';
import { getCurrentUser } from './base';
import type { Asset, AssetStatus } from './types';

/** 候选资产的 metadata_json 解析结果（对齐 proxy propose.ts 的 §6.4 契约）。 */
export interface CandidateMeta {
  /** 六桶语义分类（失败经验/历史方案/代码知识/项目约定/Skill/产品知识）。 */
  bucket?: string;
  /** 风险等级 low/medium/high。 */
  risk?: string;
  /** 结构化来源 { kind, ref }。 */
  source?: { kind: string; ref: string };
  /** 结构化证据 { validated, resultRef, at }。 */
  evidence?: { validated?: boolean; resultRef?: string; at?: string };
  /** 草稿正文（Markdown，apply 落地 skill 域的内容源）。 */
  content?: string;
  /** 拒绝信息（reject 后追加）。 */
  reject_reason?: string;
  rejected_by?: string;
}

/** 解析 metadata_json（容错：解析失败返回空对象）。 */
export function parseCandidateMeta(asset: Asset): CandidateMeta {
  try {
    if (asset.metadata_json) return JSON.parse(asset.metadata_json) as CandidateMeta;
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * 确保 content 符合 SKILL.md 契约（与 proxy mem:review apply 的
 * ensureSkillFrontmatter 对齐）：必须 `---\nname: xxx\ndescription: xxx\n---\n`
 * 开头，否则 skill/create 报 SKILL_FRONTMATTER_INVALID。propose 生成的
 * content 是纯正文，此处兜底补全 frontmatter（不覆盖已有 frontmatter）。
 */
export function ensureSkillFrontmatter(content: string, name: string, description: string): string {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimStart();
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) return content;
  const safeName = name.replace(/[^a-z0-9-]/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'skill';
  const safeDesc = (description || 'candidate skill').replace(/\n/g, ' ').slice(0, 1024);
  return `---\nname: ${safeName}\ndescription: ${safeDesc}\n---\n\n${content}`;
}

/**
 * approve 的落地结果（供 UI 区分「已落地 / 幂等复用 / 未落地 / 非 skill」，
 * 避免把成功与否都塞进 error state —— design 审查 P1-2 / P1-3）。
 */
export interface ApproveResult {
  /** skill 域落地状态：created=新建 / reused=幂等复用 / skipped=非 skill 或无正文。 */
  landing: 'created' | 'reused' | 'skipped';
  skill_id?: string;
}

export const reviewApi = {
  /**
   * 列出候选资产。
   * §4.3 门控明确 candidate/draft 均属「审核前不可见」，故审核页一并纳入
   * （缺省两者都拉；传 `status` 可覆盖为单一状态）。走 `asset/list`（审核专用，
   * 不过滤，与消费侧 `list-accessible` 门控分离）。
   */
  listCandidates: (teamId: string, status?: AssetStatus) => {
    // 缺省：candidate 与 draft 都要（审核页应看到全部待审候选）。
    if (status) return assetsApi.list(teamId, { status });
    // 分两次拉取后合并去重（asset/list 单次只能传一个 status）。
    return Promise.all([
      assetsApi.list(teamId, { status: 'candidate' }),
      assetsApi.list(teamId, { status: 'draft' }),
    ]).then(([cands, drafts]) => {
      const seen = new Set<string>();
      const merged: Asset[] = [];
      for (const a of [...cands, ...drafts]) {
        if (seen.has(a.asset_id)) continue;
        seen.add(a.asset_id);
        merged.push(a);
      }
      return merged;
    });
  },

  /** 详情：复用 assetsApi.get（单点查询，避免拉全量再 find）。 */
  getCandidate: (assetId: string) => assetsApi.get(assetId),

  /**
   * 批准候选：meta status→approved；skill 类且含正文时，落地 skill 域（幂等）。
   *
   * 说明：Panel 走 meta 直连（不经 proxy mem:review apply），故「落地 skill 域」
   * 在此显式组合。agent 兜底与 CLI `resolveLandingAgentId` 对齐（design-156.md
   * §8.6）：candidate 不绑定 agent，统一用 team 首个 active agent（保证双通道
   * 落到同一 owner_agent，幂等去重能命中 skill 唯一索引 (team_id, owner_agent_id, name)）。
   */
  approve: async (teamId: string, asset: Asset): Promise<ApproveResult> => {
    await assetsApi.update(asset.asset_id, { status: 'approved' });
    const meta = parseCandidateMeta(asset);
    if (asset.asset_type !== 'skill' || !meta.content) {
      return { landing: 'skipped' };
    }
    const me = await getCurrentUser();
    const agents = await agentsApi.list(teamId);
    const agentId = agents[0]?.agent_id ?? 'default';

    // 幂等保护（P0-1）：先按 name 查是否已存在（skill 唯一索引含 name），
    // 命中则复用，避免 CLI 与 Panel 交叉 apply 产生重复孤儿 skill。
    const existing = await listSkills({
      team_id: teamId,
      agent_id: agentId,
      filters: { name_prefix: asset.name },
      pagination: { limit: 50, offset: 0 },
    });
    const hit = existing.items.find((s) => s.name === asset.name);
    if (hit) {
      return { landing: 'reused', skill_id: hit.skill_id };
    }

    const created = await createSkill({
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: asset.name,
      content: ensureSkillFrontmatter(meta.content, asset.name, asset.description ?? ''),
      metadata: { description: asset.description ?? '' },
    });
    return { landing: 'created', skill_id: created.skill_id };
  },

  /** 拒绝候选：status→failed + metadata_json 追加 reject 信息（保留审计）。 */
  reject: async (asset: Asset, reason?: string) => {
    const me = await getCurrentUser();
    const meta = parseCandidateMeta(asset);
    const merged = { ...meta, rejected_by: me.user_id };
    if (reason) merged.reject_reason = reason;
    await assetsApi.update(asset.asset_id, {
      status: 'failed',
      metadata_json: JSON.stringify(merged),
    });
  },
};

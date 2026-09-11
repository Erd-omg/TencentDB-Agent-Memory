/**
 * reviewApi 单测（Panel 审核页，与 proxy mem:review CLI 双通道同源）。
 *
 * 覆盖（design 审查 P0-1 / P1-1 / P1-3 / P2-2）：
 *   - approve 幂等：skill 已存在 → landing=reused，不重复 createSkill
 *   - approve agent 兜底：team 首个 active agent；无 agent → 'default'
 *   - approve 落地：无正文 / 非 skill → landing=skipped（未落地 skill 域）
 *   - listCandidates 默认合并 candidate + draft（去重）
 *   - getCandidate 复用 assetsApi.get
 *   - reject 追加 reject_reason / rejected_by（保留审计）
 *   - ensureSkillFrontmatter（纯正文补 frontmatter / 已有不重复补）
 *   - parseCandidateMeta 容错
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 底层模块（只测 review.ts 自身逻辑）
vi.mock('../assets', () => ({
  assetsApi: {
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('../agents', () => ({
  agentsApi: { list: vi.fn() },
}));
vi.mock('../skill-api', () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
}));
vi.mock('../base', () => ({
  getCurrentUser: vi.fn(),
}));

import { assetsApi } from '../assets';
import { agentsApi } from '../agents';
import { listSkills, createSkill } from '../skill-api';
import { getCurrentUser } from '../base';
import {
  reviewApi,
  parseCandidateMeta,
  ensureSkillFrontmatter,
} from '../review';

const listMock = vi.mocked(assetsApi.list);
const getMock = vi.mocked(assetsApi.get);
const updateMock = vi.mocked(assetsApi.update);
const agentsListMock = vi.mocked(agentsApi.list);
const listSkillsMock = vi.mocked(listSkills);
const createSkillMock = vi.mocked(createSkill);
const getCurrentUserMock = vi.mocked(getCurrentUser);

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    asset_id: 'cand-1',
    name: 'reuse-migration-expert-tips',
    asset_type: 'skill',
    status: 'candidate',
    owner_user_id: 'usr-1',
    description: 'desc',
    metadata_json: JSON.stringify({ content: '# 正文', bucket: 'Skill', risk: 'low' }),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUserMock.mockResolvedValue({ user_id: 'usr-1' } as never);
  agentsListMock.mockResolvedValue([{ agent_id: 'agt-first' }] as never);
});

describe('ensureSkillFrontmatter', () => {
  it('纯正文 → 补 frontmatter', () => {
    const out = ensureSkillFrontmatter('# x', 'My Skill', 'd');
    expect(out).toContain('---\nname: my-skill\n');
    expect(out).toContain('# x');
  });

  it('已有 frontmatter → 原样保留', () => {
    const src = '---\nname: a\ndescription: b\n---\n\nbody';
    expect(ensureSkillFrontmatter(src, 'x', 'y')).toBe(src);
  });
});

describe('parseCandidateMeta', () => {
  it('正常解析', () => {
    const m = parseCandidateMeta(makeAsset());
    expect(m.content).toBe('# 正文');
    expect(m.bucket).toBe('Skill');
  });

  it('metadata_json 非法 → 空对象容错', () => {
    const m = parseCandidateMeta(makeAsset({ metadata_json: 'not-json' }));
    expect(m).toEqual({});
  });

  it('无 metadata_json → 空对象', () => {
    const m = parseCandidateMeta(makeAsset({ metadata_json: undefined }));
    expect(m).toEqual({});
  });
});

describe('reviewApi.listCandidates', () => {
  it('默认合并 candidate + draft（去重）', async () => {
    listMock
      .mockResolvedValueOnce([{ asset_id: 'a', status: 'candidate' }] as never)
      .mockResolvedValueOnce([{ asset_id: 'b', status: 'draft' }] as never);
    const out = await reviewApi.listCandidates('team-1');
    expect(out.map((a) => a.asset_id)).toEqual(['a', 'b']);
    expect(listMock).toHaveBeenCalledWith('team-1', { status: 'candidate' });
    expect(listMock).toHaveBeenCalledWith('team-1', { status: 'draft' });
  });

  it('指定 status 时单次过滤', async () => {
    listMock.mockResolvedValueOnce([{ asset_id: 'a' }] as never);
    const out = await reviewApi.listCandidates('team-1', 'candidate');
    expect(out.length).toBe(1);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe('reviewApi.getCandidate', () => {
  it('复用 assetsApi.get', async () => {
    getMock.mockResolvedValue({ asset_id: 'x' } as never);
    const out = await reviewApi.getCandidate('x');
    expect(out).toEqual({ asset_id: 'x' });
    expect(getMock).toHaveBeenCalledWith('x');
  });
});

describe('reviewApi.approve', () => {
  it('skill 已存在 → landing=reused，不重复 createSkill（幂等）', async () => {
    const asset = makeAsset();
    listSkillsMock.mockResolvedValue({
      items: [{ name: 'reuse-migration-expert-tips', skill_id: 'skl-existing' }],
    } as never);
    const r = await reviewApi.approve('team-1', asset);
    expect(r.landing).toBe('reused');
    expect(r.skill_id).toBe('skl-existing');
    expect(createSkillMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith('cand-1', { status: 'approved' });
  });

  it('skill 不存在 → landing=created，createSkill 带 frontmatter', async () => {
    const asset = makeAsset();
    listSkillsMock.mockResolvedValue({ items: [] } as never);
    createSkillMock.mockResolvedValue({ skill_id: 'skl-new' } as never);
    const r = await reviewApi.approve('team-1', asset);
    expect(r.landing).toBe('created');
    expect(r.skill_id).toBe('skl-new');
    expect(createSkillMock).toHaveBeenCalledTimes(1);
    const arg = createSkillMock.mock.calls[0][0] as { agent_id: string; content: string };
    expect(arg.agent_id).toBe('agt-first');
    expect(arg.content).toContain('---\nname: reuse-migration-expert-tips\n');
  });

  it('无 agent → agent_id 兜底 default', async () => {
    const asset = makeAsset();
    agentsListMock.mockResolvedValue([] as never);
    listSkillsMock.mockResolvedValue({ items: [] } as never);
    createSkillMock.mockResolvedValue({ skill_id: 'skl-new' } as never);
    await reviewApi.approve('team-1', asset);
    const arg = createSkillMock.mock.calls[0][0] as { agent_id: string };
    expect(arg.agent_id).toBe('default');
  });

  it('非 skill 类型 → landing=skipped（不落地 skill 域）', async () => {
    const asset = makeAsset({ asset_type: 'history' });
    const r = await reviewApi.approve('team-1', asset);
    expect(r.landing).toBe('skipped');
    expect(createSkillMock).not.toHaveBeenCalled();
  });

  it('skill 但无正文 → landing=skipped', async () => {
    const asset = makeAsset({ metadata_json: JSON.stringify({ bucket: 'Skill' }) });
    const r = await reviewApi.approve('team-1', asset);
    expect(r.landing).toBe('skipped');
    expect(createSkillMock).not.toHaveBeenCalled();
  });
});

describe('reviewApi.reject', () => {
  it('status→failed + metadata_json 追加 reject 信息（保留审计）', async () => {
    const asset = makeAsset();
    await reviewApi.reject(asset, '理由');
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [id, data] = updateMock.mock.calls[0] as unknown as [string, { status: string; metadata_json: string }];
    expect(id).toBe('cand-1');
    expect(data.status).toBe('failed');
    const meta = JSON.parse(data.metadata_json);
    expect(meta.reject_reason).toBe('理由');
    expect(meta.rejected_by).toBe('usr-1');
    // 原有字段保留（不覆盖）
    expect(meta.content).toBe('# 正文');
    expect(meta.bucket).toBe('Skill');
  });

  it('无 reason 时仍追加 rejected_by', async () => {
    const asset = makeAsset();
    await reviewApi.reject(asset);
    const [, data] = updateMock.mock.calls[0] as unknown as [string, { metadata_json: string }];
    const meta = JSON.parse(data.metadata_json);
    expect(meta.reject_reason).toBeUndefined();
    expect(meta.rejected_by).toBe('usr-1');
  });
});

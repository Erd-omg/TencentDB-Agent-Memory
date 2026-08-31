---
name: memory-hub-asset-guide
description: MemoryHub 团队资产的使用与沉淀约定：何时召回记忆、何时将经验沉淀为 skill、如何编写规范的 SKILL.md。
---

# MemoryHub 团队资产 · 使用与沉淀约定

> 本团队通过 MemoryHub 做 AI Coding 记忆与团队资产复用。本 skill 说明 agent 应如何使用
> 记忆工具、何时把经验沉淀为 skill，以及如何写出能被 BM25 检索到的高质量 SKILL.md。

## 1. 何时召回记忆
- 开始新任务前，先召集团队近期会话记忆（scenario/atomic）判断是否已有类似经验。
- 迁移类任务务必先查 cloud-migration-tool-guide 与 cloud-migration-postmortems。

## 2. 何时沉淀 skill
- 一段完整、可复用的流程被验证跑通后，用 skill_create 沉淀（默认 candidate 待评审）。
- 遇到反模式/踩坑 -> 沉淀到 cloud-migration-postmortems 或用 skill_patch 补充。
- 沉淀时附带来源：会话 id、验证结果，避免把单次推断直接发布为权威资产。

## 3. 如何编写可检索的 SKILL.md
- frontmatter 必填 `name`（kebab-case 小写）与 `description`（<=1024，含目标检索关键词）。
- 正文 <=50_000 字符；把「适用场景/核心步骤/命令/反模式」写成结构化清单。
- description 是第一检索入口：用业务原词（迁移/规范/复盘/资产），别用生造缩写。

## 4. 记忆工具使用
- `mem:sync`：刷新当前会话的资产注入（新装 skill 后调用）。
- `mem:help`：查看可用记忆命令。
- 资产注入的 `<available_skills>` 块列出本 agent 可用的云端 skill；用 skill_view 打开全文。

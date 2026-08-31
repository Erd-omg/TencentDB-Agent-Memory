---
name: cloud-migration-tool-guide
description: 云主机迁移-一键迁移工具的开发指南：整体架构、目录结构、核心命令、构建与测试、发布流程。实现迁移相关功能前先按本 skill 的约定组织代码。
---

# 云主机迁移-一键迁移工具 · 开发指南

> 本 skill 面向在「云主机迁移-一键迁移工具」仓库内做迁移功能开发的 AI Coding agent 与工程师。
> 动手编码前先阅读，保证新代码与既有架构、命令、测试约定一致。

## 1. 适用场景
- 新增/修改云主机迁移功能（源端采集、目标端预检、迁移执行、回滚）。
- 排查迁移任务失败、扩展迁移类型（如整机迁移、增量迁移、指定盘迁移）。

## 2. 整体架构
- 控制面 + 执行面分层：控制面管任务编排/状态机，执行面管单台主机的迁移步骤。
- 迁移任务状态机：`pending -> precheck -> migrating -> verifying -> done`，失败态 `failed` 可 `rollback`。
- 插件式迁移适配器：`openstack` / `vmware` / `tencent-cloud` 各自实现统一适配接口。

## 3. 目录结构约定
- `src/task/`：迁移任务定义与状态机
- `src/adapters/`：云厂商迁移适配器
- `src/commands/`：CLI 子命令（一键迁移入口）
- `tests/`：与 src 一一对应的单测/集成测试

## 4. 核心命令
- `pnpm build`：构建
- `pnpm test`：全量单测
- `pnpm run cli migrate --src=<id> --dst=<id>`：一键发起迁移
- `pnpm run cli task status --id=<taskId>`：查询迁移任务状态

## 5. 编码要求
- 新增适配器必须实现迁移预检（precheck）与回滚（rollback），否则不能合入。
- 迁移步骤必须可重入：中断后可恢复，不做不可逆操作。
- 关键路径打结构化日志（task_id 贯穿），便于迁移故障复盘（见 cloud-migration-postmortems）。

## 6. 构建与测试
- 合并前必须 `pnpm test` 全绿，并补一条覆盖新迁移路径的集成测试。
- 迁移到生产前先跑 dry-run 迁移验证目标端与网络连通性。

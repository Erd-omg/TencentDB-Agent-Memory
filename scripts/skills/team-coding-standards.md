---
name: team-coding-standards
description: 团队编码规范：命名约定、错误处理、提交信息、代码评审与 PR 要求。提交任何代码前先阅读本 skill。
---

# 团队编码规范

> 适用仓库：云主机迁移-一键迁移工具 及本团队全部后端/前端项目。
> 提交代码前必须阅读；评审 PR 时按本规范逐项检查。

## 1. 命名约定
- 变量/函数：camelCase；类/类型：PascalCase；常量：UPPER_SNAKE_CASE。
- 目录：kebab-case；组件文件：PascalCase.tsx。
- 领域术语统一：迁移任务用 `MigrationTask`，源端用 `source`，目标端用 `target`，不要混用 `src/dst` 与 `from/to`。

## 2. 错误处理
- 统一错误信封：`{ code, message, request_id, data }`，`code=0` 成功，非 0 为业务错。
- 业务错误码集中在 `errors.ts`，禁止魔法数字。
- 迁移失败必须抛出可恢复错误（带 task_id 与失败阶段），禁止吞异常。

## 3. 提交信息
- 格式：`<type>(<scope>): <subject>`，type ∈ feat|fix|refactor|test|docs|chore。
- 例：`fix(migration): 修复增量迁移断点续传后目标端重复写入`。
- 一个提交只做一件事；迁移相关改动要能追溯到对应迁移任务 id。

## 4. 代码评审与 PR 要求
- PR 描述必须写清：背景、改动点、验证方式（附测试与 dry-run 结果）。
- 评审重点：迁移可重入性、回滚完备性、日志可观测性。
- 静态检查与单测必须通过；禁止关闭 lint 检查绕过。

## 5. 测试要求
- 新功能必须补单测；迁移适配器必须补集成测试（mock 云厂商 API）。
- 涉及状态机的改动必须覆盖失败/回滚路径。

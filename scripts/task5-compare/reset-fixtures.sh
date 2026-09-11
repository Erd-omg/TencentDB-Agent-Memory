#!/bin/bash
# 复位夹具仓库到 3 个 bug 位点的 bug 态（on/off 对照实验的基线）。
#
# 用法：
#   FIXTURE_DIR=/path/to/migration-tool-v1 bash scripts/task5-compare/reset-fixtures.sh
#
# 3 个 bug 位点：
#   B1  windows-migration.js   ACL 在 VSS 快照前应用（对应 cloud-migration-postmortems / windows-vss-acl-sequence-acceptance）
#   B2  downtime.js            停机窗口缺 30% 缓冲（对应 cloud-migration-batch-planning，08-30 拍板）
#   B3  resume.js              断点续传 offset 硬编码 0（对应 cloud-migration-postmortems）
set -euo pipefail

FIXTURE_DIR="${FIXTURE_DIR:-$HOME/Desktop/Agent-Memory/migration-tool-v1}"
cd "$FIXTURE_DIR"

# 3 个位点统一复位到 git HEAD（seed 时的 bug 态，均已提交进 HEAD）：
#   B1 windows-migration.js  ACL 在 VSS 前
#   B2 downtime.js           停机窗口缺 30% 缓冲
#   B3 resume.js             续传 offset 硬编码 0
git checkout -- src/windows-migration.js src/downtime.js src/resume.js 2>/dev/null || true

echo "[reset-fixtures] 已复位到 3 个 bug 位点的 bug 态：$FIXTURE_DIR"

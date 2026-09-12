#!/usr/bin/env bash
# toggle-injection.sh — 一键切换对照实验 on/off/meta 三开关，并重启 proxy。
#
# on   = injection.enabled=true  + retrieval.enabled=true  + tdai.memory.inject=true  (+ injectL2L3=true)
# off  = injection.enabled=false + retrieval.enabled=false + tdai.memory.inject=false (+ injectL2L3=false)
# meta = injection.enabled=false + retrieval.enabled=true  + tdai.memory.inject=true  (+ injectL2L3=true)
#        （P1-2 三组对齐：「被告知资产存在 + 可主动检索」但**不自动注入内容**）
#        off vs meta 隔离「被告知存在 + 可检索」增益；meta vs on 隔离「自动注入内容」增益。
#
# 用法：
#   bash scripts/task5-compare/toggle-injection.sh on
#   bash scripts/task5-compare/toggle-injection.sh off
#   bash scripts/task5-compare/toggle-injection.sh meta
#
# 注意：直接改 MemoryProxy/config.yaml 的对应段（精确到段，避免误伤其它 enabled）。

set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "on" && "$MODE" != "off" && "$MODE" != "meta" ]]; then
  echo "用法：bash scripts/task5-compare/toggle-injection.sh on|off|meta" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG="$ROOT/MemoryProxy/config.yaml"

if [[ "$MODE" == "on" ]]; then
  INJ=true; RET=true; MEM_INJ=true; L2L3=true
elif [[ "$MODE" == "meta" ]]; then
  INJ=false; RET=true; MEM_INJ=true; L2L3=true
else
  INJ=false; RET=false; MEM_INJ=false; L2L3=false
fi

# 用 node 做精确段内替换（比 sed 跨段匹配更可靠）
node -e '
const fs = require("fs");
const cfg = process.argv[1];
const m = process.argv[2];
const text = fs.readFileSync(cfg, "utf8");
const v = (b) => (b ? "true" : "false");

// injection.enabled（injection: 段内第一处 enabled）——仅 on 组开，meta/off 关
let out = text.replace(/(injection:\s*\n\s*enabled:\s*)(true|false)/, "$1" + v(m === "on"));

// retrieval.enabled（retrieval: 段内第一处 enabled）——on/meta 开，off 关
out = out.replace(/(retrieval:\s*\n\s*enabled:\s*)(true|false)/, "$1" + v(m === "on" || m === "meta"));

// tdai.memory 段内的 inject 与 injectL2L3 —— on/meta 开，off 关
out = out.replace(/(memory:\s*\n\s*enabled:\s*true\s*\n\s*inject:\s*)(true|false)/, "$1" + v(m === "on" || m === "meta"));
out = out.replace(/(injectL2L3:\s*)(true|false)/, "$1" + v(m === "on" || m === "meta"));

fs.writeFileSync(cfg, out, "utf8");
console.log("switched to:", m);
' "$CFG" "$MODE"

# 重启 proxy
bash "$ROOT/MemoryProxy/scripts/proxy.sh" restart

echo "=== 当前三开关状态 ==="
grep -n -A1 '^injection:' "$CFG" | head -2
grep -n -A1 '^retrieval:' "$CFG" | head -2
grep -n 'inject:\|injectL2L3:' "$CFG" | head -4

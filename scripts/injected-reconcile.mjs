#!/usr/bin/env node
/**
 * injected-reconcile.mjs —— injected 事件独立对账（P1-1 补强）。
 *
 * 问题：injected asset_event 由 proxy 自己落库（自报）。哈希链只防落库后篡改，
 * 不防"写库那一刻就造假"。本脚本用**第二数据源**（ClickHouse usage_logs 或本地
 * JSONL logs/YYYY-MM-DD.jsonl）做交叉核验：每条 injected 事件应能找到同
 * `(session_key, turn_seq)` 的真实 LLM 请求 usage 行。
 *
 * 输出：results/injected-reconcile/report.json（含匹配率 + 孤儿注入清单）。
 *
 * 用法：
 *   node scripts/injected-reconcile.mjs                 # 全部 session
 *   node scripts/injected-reconcile.mjs --session <key> # 单 session
 *   node scripts/injected-reconcile.mjs --window 60000  # turnSeq 缺失时时间窗口兜底(ms)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "results", "injected-reconcile");
const DB_PATH = process.env.PROXY_DB_PATH || join(homedir(), ".tdai-memory-proxy", "proxy.db");
const LOG_DIR = process.env.PROXY_LOG_DIR || join(homedir(), ".tdai-memory-proxy", "logs");
const CH_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CH_DB = process.env.CLICKHOUSE_DB || "context_proxy";

/** 从 MemoryProxy/config.yaml 读 ClickHouse 凭据（user/password/url/database）。 */
function loadChConfig() {
  const out = { user: process.env.CLICKHOUSE_USER || "default", password: process.env.CLICKHOUSE_PASSWORD || "", db: CH_DB, url: CH_URL };
  try {
    const cfg = readFileSync(join(ROOT, "MemoryProxy", "config.yaml"), "utf8");
    const seg = cfg.slice(cfg.indexOf("clickhouse:"));
    const grab = (k) => { const m = seg.match(new RegExp(`${k}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m")); return m ? m[1].trim() : ""; };
    if (!process.env.CLICKHOUSE_USER) out.user = grab("user") || out.user;
    if (!process.env.CLICKHOUSE_PASSWORD) out.password = grab("password") || out.password;
    if (!process.env.CLICKHOUSE_DB) out.db = grab("database") || out.db;
    if (!process.env.CLICKHOUSE_URL) out.url = grab("url") || out.url;
  } catch { /* 用默认 */ }
  return out;
}
const CH = loadChConfig();

const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SESSION = argVal("--session", "");
const WINDOW = Number(argVal("--window", "0"));

const require = createRequire(join(ROOT, "MemoryProxy", "package.json"));

/** 从 sqlite 读 injected 事件（最小投影）。 */
function readInjectedEvents() {
  if (!existsSync(DB_PATH)) { console.error(`❌ proxy.db 不存在: ${DB_PATH}`); return []; }
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true });
  const sql = SESSION
    ? "SELECT asset_id, session_key, turn_seq, created_at FROM asset_event WHERE stage='injected' AND session_key=? ORDER BY created_at"
    : "SELECT asset_id, session_key, turn_seq, created_at FROM asset_event WHERE stage='injected' ORDER BY created_at";
  const rows = SESSION ? db.prepare(sql).all(SESSION) : db.prepare(sql).all();
  db.close();
  return rows.map((r) => ({ assetId: r.asset_id, sessionKey: r.session_key, turnSeq: r.turn_seq ?? undefined, createdAt: Number(r.created_at) }));
}

/** 从 ClickHouse usage_logs 读真实请求行；失败则回退本地 JSONL。 */
async function readUsageRows(sessionKeys) {
  const rows = [];
  // 首选 ClickHouse
  try {
    const q = SESSION
      ? `SELECT session_key, turn_seq, toUnixTimestamp64Milli(timestamp) AS ts FROM ${CH.db}.usage_logs WHERE session_key='${SESSION}' FORMAT JSON`
      : `SELECT session_key, turn_seq, toUnixTimestamp64Milli(timestamp) AS ts FROM ${CH.db}.usage_logs FORMAT JSON`;
    const url = `${CH.url}/?${new URLSearchParams({ query: q, user: CH.user, password: CH.password })}`;
    const resp = await fetch(url, { method: "GET" });
    if (resp.ok) {
      const j = await resp.json();
      for (const r of j.data ?? []) rows.push({ sessionKey: r.session_key, turnSeq: r.turn_seq ?? undefined, timestamp: Number(r.ts) });
      if (rows.length > 0) return { rows, source: `clickhouse:${CH.db}.usage_logs` };
    } else {
      console.error(`  ⚠️ ClickHouse HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    }
  } catch (e) { console.error(`  ⚠️ ClickHouse 读取失败，回退 JSONL: ${e?.message ?? e}`); }

  // 回退：本地 JSONL logs/*.jsonl
  try {
    if (existsSync(LOG_DIR)) {
      for (const f of readdirSync(LOG_DIR)) {
        if (!f.endsWith(".jsonl")) continue;
        const lines = readFileSync(join(LOG_DIR, f), "utf8").split("\n").filter(Boolean);
        for (const ln of lines) {
          let r; try { r = JSON.parse(ln); } catch { continue; }
          const isUsage = r.event === "usage" || r.event_type === "usage" || r.type === "usage";
          const sk = r.sessionKey ?? r.session_key;
          if (!isUsage || !sk) continue;
          if (sessionKeys && !sessionKeys.has(sk)) continue;
          const ts = Date.parse(r.timestamp ?? r.ts ?? "") || 0;
          rows.push({ sessionKey: sk, turnSeq: r.turnSeq ?? r.turn_seq ?? undefined, timestamp: ts });
        }
      }
    }
  } catch (e) { console.error(`  ⚠️ JSONL 回退失败: ${e?.message ?? e}`); }
  return { rows, source: rows.length ? "jsonl:logs" : "none" };
}

/** 纯函数对账（与 MemoryProxy/src/evidence/injected-reconcile.ts 同逻辑，脚本内联以便独立运行）。 */
function reconcile(events, usage, windowMs) {
  const key = (s, t) => `${s}\u0000${t ?? ""}`;
  const usageKeys = new Set(usage.map((u) => key(u.sessionKey, u.turnSeq)));
  const bySession = new Map();
  for (const u of usage) { if (!bySession.has(u.sessionKey)) bySession.set(u.sessionKey, []); bySession.get(u.sessionKey).push(u.timestamp); }
  const orphans = [];
  let matched = 0;
  for (const e of events) {
    let ok = usageKeys.has(key(e.sessionKey, e.turnSeq));
    if (!ok && windowMs > 0) {
      const times = bySession.get(e.sessionKey) ?? [];
      ok = times.some((t) => Math.abs(t - e.createdAt) <= windowMs);
    }
    if (ok) matched++; else orphans.push(e);
  }
  return { total: events.length, matched, orphans, matchRate: events.length ? matched / events.length : 0, available: usage.length > 0 };
}

async function main() {
  console.log("═".repeat(64));
  console.log("  injected 事件独立对账（P1-1）");
  console.log("═".repeat(64));
  const events = readInjectedEvents();
  console.log(`injected 事件: ${events.length}（session=${SESSION || "全部"}）`);
  if (events.length === 0) { console.log("无 injected 事件，退出。"); return; }

  const sessionKeys = new Set(events.map((e) => e.sessionKey));
  const { rows: usage, source } = await readUsageRows(sessionKeys);
  console.log(`第二数据源: ${source} | usage 行: ${usage.length}`);

  const result = reconcile(events, usage, WINDOW);
  report(result, source);
}

function report(result, source) {
  const bySession = {};
  for (const o of result.orphans) bySession[o.sessionKey] = (bySession[o.sessionKey] ?? 0) + 1;
  const reportObj = {
    generated_at: new Date().toISOString(),
    second_source: source,
    reconciliation_key: "(session_key, turn_seq)" + (WINDOW ? ` + window ${WINDOW}ms` : ""),
    total_injected: result.total,
    matched: result.matched,
    orphans: result.orphans.length,
    match_rate: Number(result.matchRate.toFixed(4)),
    available: result.available,
    orphan_by_session: bySession,
    orphan_sample: result.orphans.slice(0, 20),
    interpretation: {
      matched_meaning: "注入事件有独立的真实 LLM 请求（usage_logs）佐证。",
      orphan_meaning: "注入事件自报，但无对应 (session,turn) 的真实请求 usage 行——需人工复核"
        + "（可能被 abort/403/在无 usage 路径注入，故孤儿不必然造假）。",
      limitation: "粒度是 (session,turn) 窗口非 1:1；usage_logs 仅在上游成功拿到 usage 后写；"
        + "第二数据源不可用时对账退化（available=false）。",
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(reportObj, null, 2) + "\n");
  console.log("\n" + "─".repeat(64));
  console.log(`匹配: ${result.matched}/${result.total}（${(result.matchRate * 100).toFixed(1)}%）`);
  console.log(`孤儿注入: ${result.orphans.length}`);
  console.log(`对账可用: ${result.available}`);
  console.log(`报告 → ${join(OUT_DIR, "report.json")}`);
  console.log("─".repeat(64));
}

main().catch((e) => { console.error(e); process.exit(1); });

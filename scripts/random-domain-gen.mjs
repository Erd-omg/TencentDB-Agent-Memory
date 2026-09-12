#!/usr/bin/env node
/**
 * random-domain-gen.mjs —— 随机独立域语料生成器（P0-2 / D3 压力测试）。
 *
 * 目的：证明「抽取-检索管线不依赖作者预设短语」。用**可复现的种子随机**生成
 * 与 migration-tool-v1 / 本项目**完全无关**的独立业务域语料（术语随机拼造，
 * 不与任何已有资产撞词），供 real-corpus-e2e 类脚本做压力测试。
 *
 * 设计要点（抗过拟合）：
 *   - 每个域的主题、实体名、文件路径、命令**由种子的 PRNG 生成**，与作者直觉无关；
 *   - 域内共享术语（同域 session 用同批术语）→ 应能抽出并互相命中；
 *   - 域间术语互斥（不同域用不同词表）→ 域外语不应命中本域（负样本对照）。
 *
 * 输出：demo-corpus/random-domains/sessions/rnd-<domain>-<n>.jsonl + manifest.json
 *
 * 用法：
 *   node scripts/random-domain-gen.mjs                 # 默认 3 域 × 3 session，seed=20260912
 *   node scripts/random-domain-gen.mjs --domains 4 --per 3 --seed 42
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N_DOMAINS = Number(argVal("--domains", "3"));
const PER_DOMAIN = Number(argVal("--per", "3"));
const SEED = Number(argVal("--seed", "20260912"));
const OUT = argVal("--out", join(homedir(), "Desktop", "Agent-Memory", "demo-corpus", "random-domains"));

// ── 可复现 PRNG（mulberry32）──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const pickN = (rng, arr, n) => { const c = [...arr]; const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rng() * c.length), 1)[0]); return out; };

// ── 造词素材：合成「听起来真实但不指向任何已知项目」的域术语 ──
const SYL_A = ["quo", "vex", "lyr", "num", "zel", "dra", "fen", "gor", "hal", "ivo", "jax", "kel", "mor", "nyx", "orb", "pyx"];
const SYL_B = ["tari", "vane", "silo", "dara", "meko", "ruxa", "lith", "pavo", "seka", "zuna", "brix", "coro"];
const SYL_C = ["flux", "core", "sync", "mesh", "gate", "lens", "path", "beam", "dock", "node", "ring", "vault"];
const lang = (rng) => `${pick(rng, SYL_A)}${pick(rng, SYL_B)}${rng() < 0.5 ? pick(rng, SYL_C) : ""}`;

const ACTIONS = ["reconcile", "rehydrate", "backfill", "throttle", "quarantine", "reindex", "compensate", "snapshot", "shard", "evict"];
const FILES = ["handler", "scheduler", "resolver", "adapter", "serializer", "dispatcher", "collector", "validator"];
const EXTS = [".ts", ".py", ".go", ".rs"];

// 每个域：生成一批专属术语 + 一个专属主题句 + 一组会话场景
function genDomain(rng, idx) {
  const brand = lang(rng);                      // 域品牌名（域专属）
  const coreConcept = lang(rng);                // 域核心概念
  const entities = Array.from({ length: 6 }, () => lang(rng));  // 域内实体（域专属）
  const files = Array.from({ length: 4 }, () => `${pick(rng, FILES)}_${lang(rng)}${pick(rng, EXTS)}`);
  const verb = pick(rng, ACTIONS);
  return {
    id: `rnd-dom-${idx + 1}`,
    brand, coreConcept, entities, files, verb,
    topic: `${brand} ${coreConcept} ${verb} pipeline`,
    // 会话场景：围绕该域术语自然展开（含用户诉求 + 工具调用 + 结论）
    scenes: [
      `用户要求修复 ${brand} 的 ${coreConcept} ${verb} 逻辑，涉及 ${entities[0]} 与 ${entities[1]} 的对账。`,
      `在 ${files[0]} 中发现 ${entities[2]} 状态未随 ${coreConcept} 更新，怀疑 ${verb} 时序问题。`,
      `为 ${brand} 增加 ${entities[3]} 的兜底：当 ${coreConcept} 超时则触发 ${verb}。`,
      `复盘 ${brand} 事故：${entities[4]} 与 ${entities[5]} 不一致，根因是 ${verb} 未幂等。`,
      `给 ${brand} 写测试覆盖 ${coreConcept} 的边界：空 ${entities[0]}、重复 ${entities[1]}。`,
    ],
  };
}

/** 生成一个域的若干 session jsonl（同域共享术语，跨域互斥）。 */
function genSessions(rng, domain, per) {
  const out = [];
  for (let n = 0; n < per; n++) {
    const lines = [];
    lines.push(JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: `${domain.id}-s${n + 1}`,
        cwd: `/workspace/${domain.brand}-${domain.coreConcept}`,
        ts: `2026-01-0${(n % 9) + 1}T0${n}:00:00Z`,
        agent: "rand-gen",
        task_type: "synthetic-independent",
        source: "random-domain",
      },
    }));
    // 交替 user/assistant/tool_call/tool_result，内容围绕域术语
    const scenes = pickN(rng, domain.scenes, Math.min(per + 1, domain.scenes.length));
    for (const sc of scenes) {
      lines.push(JSON.stringify({ role: "user", content: [{ type: "text", text: sc }] }));
      lines.push(JSON.stringify({ role: "assistant", content: [{ type: "text", text: `分析 ${domain.coreConcept}：需要检查 ${domain.files[0]} 的 ${domain.verb} 实现，并核对 ${domain.entities[0]}。` }] }));
      lines.push(JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Read", input: { path: `/workspace/${domain.brand}/src/${domain.files[0]}` } }] }));
      lines.push(JSON.stringify({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `// ${domain.brand} ${domain.files[0]}\nexport function ${domain.verb}(inp){ /* ${domain.coreConcept} ${domain.entities[1]} */ }` }] }));
      lines.push(JSON.stringify({ role: "assistant", content: [{ type: "text", text: `结论：${domain.brand} 的 ${domain.coreConcept} 需在 ${domain.verb} 前校验 ${domain.entities[2]}；已更新 ${domain.files[1]}。` }] }));
    }
    out.push({ file: `sessions/${domain.id}-s${n + 1}.jsonl`, content: lines.join("\n") + "\n" });
  }
  return out;
}

function main() {
  const rng = mulberry32(SEED);
  mkdirSync(join(OUT, "sessions"), { recursive: true });
  const domains = Array.from({ length: N_DOMAINS }, (_, i) => genDomain(rng, i));
  const manifestSessions = [];
  for (const d of domains) {
    const sess = genSessions(rng, d, PER_DOMAIN);
    for (const s of sess) {
      writeFileSync(join(OUT, s.file), s.content, "utf8");
      manifestSessions.push({
        id: s.file.replace(/^sessions\//, "").replace(/\.jsonl$/, ""),
        file: s.file,
        title: `合成独立域 ${d.id}（${d.topic}）`,
        task_type: "synthetic-independent",
        agent: "rand-gen",
        project: d.id,
        source: "random-domain",
        // 域专属术语（供检索区分度判定：域内 query 应命中本域，域外语不应命中）
        domain_terms: [d.brand, d.coreConcept, d.verb, ...d.entities, ...d.files.map((f) => f.replace(/\.[a-z]+$/, ""))],
        expected_assets: null,
      });
    }
  }
  const manifest = {
    corpus_id: "random-domains-2026",
    title: "随机独立域压力测试语料",
    description: "由 random-domain-gen.mjs 用种子 PRNG 生成的独立业务域语料，术语随机拼造、"
      + "与 migration-tool-v1 / 本项目完全无关。用于验证抽取-检索管线不依赖作者预设短语。",
    business_domain: "合成域（非真实业务）",
    authorization: "本脚本生成，无版权/隐私问题",
    created_at: "2026-09-12",
    provenance: "synthetic-random (seed=" + SEED + ")",
    seed: SEED,
    redaction: { rule: "N/A（合成数据无敏感信息）" },
    ground_truth: null,
    ground_truth_note: "合成语料无人工标注资产；用「域内术语命中本域」近似验证，"
      + "并配「域外语不应命中本域」的负样本对照。",
    domains: domains.map((d) => ({ id: d.id, brand: d.brand, core_concept: d.coreConcept, verb: d.verb, entities: d.entities })),
    sessions: manifestSessions,
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`生成 ${N_DOMAINS} 个独立域 × ${PER_DOMAIN} session → ${OUT}`);
  for (const d of domains) console.log(`  ${d.id}: brand=${d.brand} concept=${d.coreConcept} verb=${d.verb} entities=[${d.entities.slice(0, 3).join(",")}...]`);
  console.log(`manifest → ${join(OUT, "manifest.json")}`);
}

main();

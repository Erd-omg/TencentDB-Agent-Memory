#!/usr/bin/env node
/**
 * capture-evidence-shots.mjs — 任务四 Panel「资产回执」页（EvidencePage）截图。
 *
 * 复用 capture-panel-shots.mjs 的 CDP + localStorage 会话注入模式，但只截证据页：
 *   #/evidence 默认视图（会话自动选中 → 汇总条 + 资产卡）→ r2-08-panel-evidence.png
 *   展开「证据 / 决策」details（tool_call / test_result）→ r2-08-panel-evidence-expanded.png
 *
 * 用法：
 *   node scripts/capture-evidence-shots.mjs [--out results/codebuddy-live-4]
 * 依赖：Panel :8125（源码版，含 evidence 代理）+ proxy :8097 + core :8420。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const USER_DATA_DIR = "/tmp/chrome-evidence-profile";
const PANEL = process.env.PANEL_BASE || "http://localhost:8125";
const KEY = process.env.USER_KEY || readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const OUT_DIR = process.env.OUT_DIR || join(ROOT, "results", "codebuddy-live-4");
const WAIT_MS = Number(process.env.WAIT_MS || 3500);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page") ?? list[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("ws error")), { once: true }); });
      return new CDP(ws);
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("Chrome CDP 端口未就绪");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaljs(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
}

async function shot(cdp, name) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT_DIR, name), Buffer.from(s.data, "base64"));
  console.log(`[evidence-shots] ✓ ${name} ${(s.data.length / 1024).toFixed(0)}KB`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, "--window-size=1500,950", "about:blank"], { stdio: "ignore" });
  const cdp = await connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 会话注入：auth/verify → localStorage → reload
  const vres = await fetch(`${PANEL}/api/v1/meta/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tdai-Service-Id": "default" }, body: JSON.stringify({ user_key: KEY }) }).then((r) => r.json());
  if (!vres?.data?.valid) throw new Error(`auth/verify 失败: ${JSON.stringify(vres).slice(0, 200)}`);
  const session = { instanceId: "default", userKey: KEY, user: vres.data.user };
  await cdp.send("Page.navigate", { url: PANEL + "/" });
  await sleep(1200);
  const uid = vres.data.user?.user_id || vres.data.user?.id || "anonymous";
  await evaljs(cdp, `localStorage.setItem('tdai-panel.session', JSON.stringify(${JSON.stringify(session)})); localStorage.setItem('tdai-panel.onboarded.${uid}', '1'); 'ok'`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(2500);
  console.log(`[evidence-shots] session injected user=${uid}`);

  // 打开资产回执页
  await cdp.send("Page.navigate", { url: PANEL + "/#/evidence" });
  await sleep(WAIT_MS);
  await sleep(1200);

  // DOM 校验：确认页面真的渲染了回执数据（非空白/登录页）
  const pageText = await evaljs(cdp, `document.body.innerText.slice(0, 1500)`);
  const markers = (pageText || "").split("\n").filter((l) => l.trim()).slice(0, 8).join(" | ");
  console.log(`[evidence-shots] evidence page DOM: 「${markers.slice(0, 200)}」`);
  if (!/(证据|回执|已通过测试验证|仅背景参考|会话|Skill)/.test(pageText || "")) {
    console.error("[evidence-shots] ❌ 页面未渲染回执内容（可能未登录或证据页无数据）");
  }

  // 截图 1：默认视图（汇总条 + 资产卡）
  await shot(cdp, "r2-08-panel-evidence.png");

  // 展开所有资产卡的「证据 / 决策」details，截图 2
  const opened = await evaljs(cdp, `(() => { const ds = [...document.querySelectorAll('details')]; ds.forEach(d => d.open = true); return ds.length; })()`);
  console.log(`[evidence-shots] 展开 details×${opened}`);
  await sleep(1200);
  await shot(cdp, "r2-08-panel-evidence-expanded.png");

  // 截图 3：整页截图（完整回执：汇总条 + 全部分组资产卡 + 展开详情）
  const fs = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(OUT_DIR, "r2-08-panel-evidence-full.png"), Buffer.from(fs.data, "base64"));
  console.log(`[evidence-shots] ✓ r2-08-panel-evidence-full.png ${(fs.data.length / 1024).toFixed(0)}KB`);

  cdp.close();
  chrome.kill();
  console.log(`[evidence-shots] done → ${OUT_DIR}`);
}

main().catch((e) => { console.error("[evidence-shots] FAIL:", e.message); process.exit(1); });

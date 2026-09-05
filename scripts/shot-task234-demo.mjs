#!/usr/bin/env node
// 任务二/三/四 交互演示截图 —— 复用 capture-panel-shots.mjs 的极简 CDP 客户端
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9344;
const USER_DATA_DIR = "/tmp/chrome-task234-demo";
const URL = "file://" + join(ROOT, "results/archive/task234-demo/index.html");
const OUT = join(ROOT, "results/archive/task234-demo");

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page") ?? list[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      });
      return new CDP(ws);
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("Chrome CDP 端口未就绪");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(cdp, name, clickText, theme) {
  if (theme) {
    await cdp.send("Runtime.evaluate", { expression: `document.documentElement.setAttribute('data-theme','${theme}')` });
    await sleep(200);
  } else {
    await cdp.send("Runtime.evaluate", { expression: `document.documentElement.removeAttribute('data-theme')` });
  }
  if (clickText) {
    await cdp.send("Runtime.evaluate", { expression: `(() => { const b=[...document.querySelectorAll('.tab')].find(e=>(e.innerText||'').includes(${JSON.stringify(clickText)})); if(b){b.click();} return !!b; })()` });
    await sleep(350);
  }
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
  console.log(`✓ ${name}`);
}

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DATA_DIR}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1240,1600", URL,
], { stdio: "ignore" });

try {
  mkdirSync(OUT, { recursive: true });
  const cdp = await connect();
  await sleep(1200);
  await shot(cdp, "panel1-retrieve-trim.png", "任务二");
  await shot(cdp, "panel2-evidence-chain.png", "任务三");
  await shot(cdp, "panel3-receipt.png", "任务四");
  await shot(cdp, "panel3-receipt-dark.png", "任务四", "dark");
  // 报告 JS 错误
  const err = await cdp.send("Runtime.evaluate", { expression: `window.__errs||[]`, returnByValue: true });
  console.log("JS errors:", JSON.stringify(err?.result?.value));
  cdp.close();
} finally {
  chrome.kill("SIGTERM");
}

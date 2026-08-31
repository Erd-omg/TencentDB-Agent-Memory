#!/usr/bin/env node
/**
 * Panel(Memory Hub) 截图工具 —— 用 CDP 驱动 headless Chrome，
 * 注入 tdai-panel.session 会话后截取关键页面。
 *
 * 为什么不用 `chrome --screenshot`：Panel 前端从 localStorage 读 user_key，
 * 无会话时 API 全 401/400，页面空白。本脚本通过 CDP 先写 localStorage 再加载。
 *
 * 截哪些页（HashRouter）：
 *   #/            工作台
 *   #/memory      聊天记忆（L0/L1/L2/L3）
 *   #/skills      Skill 资产
 *   #/team/agents Agent 列表
 *
 * 用法：
 *   node scripts/capture-panel-shots.mjs [--out results/panelshots] [--wait 2500]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const USER_DATA_DIR = "/tmp/chrome-panel-profile";
const PANEL = process.env.PANEL_BASE || "http://localhost:8125";
const KEY =
  process.env.USER_KEY ||
  readFileSync(join(ROOT, "deploy/global-images/.admin-key"), "utf8").trim();
const OUT_DIR = process.argv[2] === "--out" ? process.argv[3] : join(ROOT, "results/panelshots");
const WAIT_MS = Number(process.argv[2] === "--wait" ? process.argv[3] : 2500);

const PAGES = [
  ["workbench", "#/"],
  ["chat-memory", "#/memory"],
  ["skills", "#/skills"],
  ["agents", "#/team/agents"],
];

// ── 极简 CDP 客户端 ────────────────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function connect() {
  // 等调试端口就绪
  for (let i = 0; i < 40; i++) {
    try {
      // 从 /json/list 取 page target（browser-level socket 不支持 Page.*）
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page") ?? list[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      // 等待 socket open
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      });
      return new CDP(ws);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("Chrome CDP 端口未就绪");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 按可见文本点击第一个匹配元素。
 *
 * 注意：用合成 el.click() 无法触发本项目的 React onSelect（点击载体是
 * button._alp-item-btn，onClick 在 React 根部委托），必须用 CDP Input 域
 * 发「真实」鼠标事件才能选中列表项。详见 /tmp/diag-block-click.mjs 的验证。
 */
async function clickByText(cdp, text) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const want = ${JSON.stringify(text)};
      // 优先：可交互控件（button / [role=tab]）精确或包含匹配 —— 记忆块点击载体是 button._alp-item-btn
      const controls = [...document.querySelectorAll('button,[role=tab],[role=button]')]
        .filter(e => e.offsetParent!==null);
      const el =
        controls.find(e => (e.innerText||'').trim() === want)
        || controls.find(e => (e.innerText||'').includes(want))
        || [...document.querySelectorAll('div,span,li')].find(e => e.offsetParent!==null && (e.innerText||'').trim() === want)
        || [...document.querySelectorAll('div,span,li')].find(e => e.offsetParent!==null && (e.innerText||'').includes(want));
      if (!el) return 'not-found';
      const rect = el.getBoundingClientRect();
      return JSON.stringify({x: rect.x + rect.width/2, y: rect.y + rect.height/2});
    })()`,
  });
  const v = r?.result?.value;
  if (!v || v === "not-found") {
    console.log(`[panel-shots] click 「${text}」 → ${v ?? "?"}`);
    return;
  }
  const { x, y } = JSON.parse(v);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  console.log(`[panel-shots] click 「${text}」 → dispatchMouseEvent@(${x|0},${y|0})`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. 启动 headless Chrome
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`,
    "--window-size=1500,950", "about:blank",
  ], { stdio: "ignore" });
  console.log(`[panel-shots] chrome pid=${chrome.pid} → ${OUT_DIR}`);

  const cdp = await connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 2. 先调 auth/verify 拿真实 user，注入完整会话，再 reload 让 SPA 读到
  const vres = await fetch(`${PANEL}/api/v1/meta/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tdai-Service-Id": "default" },
    body: JSON.stringify({ user_key: KEY }),
  }).then((r) => r.json());
  if (!vres?.data?.valid) throw new Error(`auth/verify 失败: ${JSON.stringify(vres).slice(0, 200)}`);
  const session = { instanceId: "default", userKey: KEY, user: vres.data.user };
  await cdp.send("Page.navigate", { url: PANEL + "/" });
  await sleep(1200);
  const uid = vres.data.user?.user_id || vres.data.user?.id || "anonymous";
  const inj = await cdp.send("Runtime.evaluate", {
    expression: `localStorage.setItem('tdai-panel.session', JSON.stringify(${JSON.stringify(session)}));
                 localStorage.setItem('tdai-panel.onboarded.${uid}', '1'); 'ok'`,
  });
  console.log(`[panel-shots] inject session user=${uid} → ${inj.result?.value ?? inj.result?.type}`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(WAIT_MS);

  // 3. 逐页截图 + DOM 校验（避免截到空白/登录页）
  for (const [name, hash] of PAGES) {
    await cdp.send("Page.navigate", { url: PANEL + "/" + hash });
    await sleep(WAIT_MS);
    await sleep(600);

    // chat-memory：点开第一个记忆块，展示 L0-L3 详情
    if (name === "chat-memory") {
      await clickByText(cdp, "Memory of default-agent-admin");
      await sleep(2500);

      // 1) L1 原子记忆视图（默认层）——展示抽取出的原子事实 + 各层计数
      const l1shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const l1out = join(OUT_DIR, "chat-memory-l1.png");
      writeFileSync(l1out, Buffer.from(l1shot.data, "base64"));
      console.log(`[panel-shots] ✓ chat-memory-l1.png (L1 原子记忆) ${(l1shot.data.length / 1024).toFixed(0)}KB`);

      // 2) 切到 L0「对话」层，展示真实会话的 L0 消息（记忆生成证据最强）
      await clickByText(cdp, "L0");
      await sleep(2500);
    }

    const dom = await cdp.send("Runtime.evaluate", {
      expression: `document.body.innerText.slice(0, 2000)`,
    });
    const text = dom?.result?.value ?? "";
    const markers = text.split("\n").filter((l) => l.trim()).slice(0, 6).join(" | ");
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const out = join(OUT_DIR, `${name}.png`);
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`[panel-shots] ✓ ${name}.png (${hash}) ${(shot.data.length / 1024).toFixed(0)}KB  「${markers.slice(0, 120)}」`);
  }

  cdp.close();
  chrome.kill();
  console.log(`[panel-shots] done → ls ${OUT_DIR}`);
}

main().catch((e) => { console.error("[panel-shots] FAIL:", e.message); process.exit(1); });

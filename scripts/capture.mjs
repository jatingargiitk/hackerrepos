// Capture docs/screenshot.png and the frames of docs/demo.gif from the real
// site in headless Chrome over the DevTools protocol.
//
//   node scripts/capture.mjs <out-dir> [width] [height]
//   scripts/demo-gif.sh            # frames -> docs/demo.gif (needs ffmpeg)
//
// Serves docs/ on a random local port, so it uses the committed dataset.
// Needs Chrome/Chromium on PATH (or CHROME=/path/to/chrome) and Node 22+.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [outDir, width = "1280", height = "800"] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: node scripts/capture.mjs <out-dir> [width] [height]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const root = resolve(import.meta.dirname, "../docs");
const types = { ".html": "text/html", ".json": "application/json", ".png": "image/png", ".gif": "image/gif" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = readFileSync(join(root, path.endsWith("/") ? path + "index.html" : path));
    res.writeHead(200, { "content-type": types[extname(path) || ".html"] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}/`;

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  process.env.CHROME ?? "google-chrome",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(outDir, ".chrome")}`, "about:blank"],
  { stdio: "ignore" },
);

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => undefined);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.THEME ?? "light" }] });
await send("Page.navigate", { url: site });
for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector("li.repo")`)); i++) await sleep(100);
await sleep(300);

let frame = 0;
async function shot(name, hold = 1) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  for (let i = 0; i < hold; i++) {
    const file = join(outDir, `${String(++frame).padStart(3, "0")}-${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
  }
  console.log(name);
}
async function click(expr) {
  const p = await evaluate(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!p) throw new Error(`nothing to click: ${expr}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  await sleep(250);
}
async function type(text) {
  for (const ch of text) {
    await send("Input.insertText", { text: ch });
    await sleep(90);
    await shot("typing");
  }
}
async function select(id, value) {
  await evaluate(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); })()`);
  await sleep(250);
}
const chip = (w) => `document.querySelector('#win [data-w="${w}"]')`;

await shot("overview", 8);
await click(chip("1y"));
await shot("window-1y", 6);
await click(`document.getElementById("q")`);
await type("terminal");
await sleep(300);
await shot("search", 6);
await click(`document.querySelector("li.repo .more")`);
await shot("why", 12);
await evaluate(`(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input")); })()`);
await click(chip("all"));
await select("lang", "Rust");
await shot("rust", 6);
await click(`document.getElementById("gems").closest("label") || document.getElementById("gems")`);
await shot("gems", 10);

ws.close();
chrome.kill();
server.close();

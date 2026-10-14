// Headless screenshots for verification: node scripts/shoot.mjs <url> <out.png> [actions-json]
// actions: [{"click":[x,y]} | {"wait":ms} | {"key":"f"} | {"sel":"css"}]
import { chromium, firefox } from "../web/node_modules/playwright/index.mjs";
import os from "node:os";
// WSL without sudo: chromium's missing libs (nss, nspr, gbm, asound) unpacked from .debs, see CLAUDE.md
const LIBS = `${os.homedir()}/.local/lib/chromium-deps`;
const [url, out, acts = "[]"] = process.argv.slice(2);
// BROWSER=firefox: its built-in PDF viewer renders iframe'd PDFs (chromium-headless-shell has none).
// Firefox brings its own (newer) NSS: its dir must come before LIBS.
const ff = process.env.BROWSER === "firefox";
const ffDir = ff ? (await import("node:fs")).readdirSync(`${os.homedir()}/.cache/ms-playwright`).filter((d) => d.startsWith("firefox-")).sort().pop() : "";
const libPath = [ff ? `${os.homedir()}/.cache/ms-playwright/${ffDir}/firefox` : "", LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
const browser = ff
  ? await firefox.launch({ env: { ...process.env, LD_LIBRARY_PATH: libPath }, firefoxUserPrefs: { "pdfjs.disabled": false } })
  : await chromium.launch({ env: { ...process.env, LD_LIBRARY_PATH: libPath }, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: process.env.MOBILE ? { width: 390, height: 844 } : { width: 1500, height: 900 }, deviceScaleFactor: process.env.MOBILE ? 2 : 1 });
const logs = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
for (const a of JSON.parse(acts)) {
  if (a.click) await page.mouse.click(...a.click);
  if (a.sel) await page.click(a.sel);
  if (a.key) await page.keyboard.press(a.key);
  if (a.wheel) { await page.mouse.move(a.wheel[0], a.wheel[1]); await page.mouse.wheel(0, a.wheel[2]); }
  await page.waitForTimeout(a.wait ?? 400);
}
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log(logs.join("\n") || "no console errors");
await browser.close();

import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

// WSL without sudo: chromium's missing system libs live here (see CLAUDE.md). Playwright checks
// host deps in-process, so the path has to be on this process's env, not just the browser's.
const libs = `${homedir()}/.local/lib/chromium-deps`;
if (existsSync(libs) && !process.env.LD_LIBRARY_PATH?.includes(libs))
  process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");

// Playwright's Firefox ships its own (newer) NSS: its dir must come first for the browser
const ffDir = (() => {
  try {
    const root = `${homedir()}/.cache/ms-playwright`;
    const d = readdirSync(root).filter((n) => n.startsWith("firefox-")).sort().pop();
    return d ? `${root}/${d}/firefox` : "";
  } catch {
    return "";
  }
})();

const PORT = 5199;
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1500, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // full Chromium (new headless), not the bare headless shell: it has Chrome's popup blocker
        channel: "chromium",
        launchOptions: {
          // the system NSS here is too old for Chromium (crashes on start / on HTTPS): borrow Firefox's
          env: { ...process.env, LD_LIBRARY_PATH: [ffDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
          args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
          // Playwright turns Chrome's popup blocker off by default; users have it on
          ignoreDefaultArgs: ["--disable-popup-blocking"],
        },
      },
    },
    {
      // the datasheet pane behaves differently per browser (sandboxed iframe on Gecko); 3D needs
      // WebGL, which headless Firefox lacks here, so only the datasheet spec runs on Firefox
      name: "firefox",
      testMatch: /datasheet\.spec\.ts/,
      use: {
        browserName: "firefox",
        launchOptions: {
          env: { ...process.env, LD_LIBRARY_PATH: [ffDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
          firefoxUserPrefs: { "pdfjs.disabled": false },
        },
      },
    },
  ],
  // test what gets deployed: the production build + the committed release bundles (link mode)
  webServer: {
    command: `npm run build && rm -rf dist/bundles && cp -r ../bundles dist/bundles && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

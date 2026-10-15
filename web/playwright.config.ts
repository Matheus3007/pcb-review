import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// WSL without sudo: chromium's missing system libs live here (see CLAUDE.md). Playwright checks
// host deps in-process, so the path has to be on this process's env, not just the browser's.
const libs = `${homedir()}/.local/lib/chromium-deps`;
if (existsSync(libs) && !process.env.LD_LIBRARY_PATH?.includes(libs))
  process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");

const PORT = 5199;
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1500, height: 900 },
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  // test what gets deployed: the production build + the committed release bundles (link mode)
  webServer: {
    command: `npm run build && rm -rf dist/bundles && cp -r ../bundles dist/bundles && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

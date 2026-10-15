import { defineConfig } from "vitest/config";

// unit tests only; e2e/*.spec.ts are Playwright's (make e2e)
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });

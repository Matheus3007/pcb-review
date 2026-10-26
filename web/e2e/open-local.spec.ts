// Opening any pcb-lab board from the user's disk (folder or zip), parsed in the browser.
import { test, expect } from "@playwright/test";
import { zipSync } from "fflate";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appState, collectErrors, netTargets, ready, stubDatasheets } from "./helpers";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "fixtures/boards/rebot-ctrl-v2");

async function checkOpened(page: import("@playwright/test").Page) {
  await expect(page.locator(".banner")).toContainText("Nothing was uploaded");
  await expect(page.locator("#board-name")).toContainText("rebot-ctrl-v2 · local");
  const s = await page.evaluate(() => (window as any).pcbReview.bundle);
  // counts from the fixture's own pcb-lab report (the fixture is regenerated as the board evolves)
  const stats = JSON.parse(readFileSync(join(BOARD, "build/reports/checks.json"), "utf8")).stats;
  expect(s.footprints.length).toBe(stats.parts);
  expect(s.tracks.length).toBe(stats.tracks);
  // selection works on the imported board, datasheet from LCSC at the pin's page
  const t = (await netTargets(page)).find((x) => x.ref === "U1")!;
  await page.mouse.click(t.x, t.y);
  expect((await appState(page)).net).toBe(t.net);
  await expect(page.locator(".pdf-frame iframe")).toHaveAttribute("src", /datasheet\.lcsc\.com.*#page=\d+/);
}

test("open a board folder from disk", async ({ page }) => {
  const errors = collectErrors(page);
  await stubDatasheets(page);
  await ready(page);
  await page.getByRole("button", { name: "⬆ Upload board" }).click();
  await expect(page.locator("#open-dialog")).toBeVisible();
  await page.locator("#open-folder").setInputFiles(BOARD);
  await checkOpened(page);
  await expect(page.locator("#open-dialog")).toBeHidden();
  await page.screenshot({ path: "test-results/open-local.png" });
  expect(errors).toEqual([]);
});

test("open a .zip of the board", async ({ page }) => {
  const errors = collectErrors(page);
  await stubDatasheets(page);
  await ready(page);
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[`rebot-ctrl-v2/${relative(BOARD, p).replace(/\\/g, "/")}`] = readFileSync(p);
    }
  };
  walk(BOARD);
  files["rebot-ctrl-v2/build/renders/top.png"] = new Uint8Array(1000); // ignored noise
  await page.getByRole("button", { name: "⬆ Upload board" }).click();
  await page.locator("#open-zip").setInputFiles({ name: "rebot-ctrl-v2.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(files)) });
  await checkOpened(page);
  expect(errors).toEqual([]);
});

test("a folder without a board says so", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "⬆ Upload board" }).click();
  await page.locator("#open-zip").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "readme.md": new TextEncoder().encode("hi") })) });
  await expect(page.locator("#open-dialog .open-status")).toContainText("No .kicad_pcb found");
});

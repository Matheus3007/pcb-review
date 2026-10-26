// 3D picking selects exactly like the 2D view and drives the side pane.
import { test, expect, type Page } from "@playwright/test";
import { collectErrors, ready, stubDatasheets } from "./helpers";

type V3 = { project(x: number, y: number, z?: number): [number, number]; view(k: string): void };
const target = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { pcbReview: { bundle: any } }).pcbReview;
    const b = h.bundle;
    const inside = (x: number, y: number) =>
      b.footprints.some((f: any) => f.courtyard && x > f.courtyard[0] - 0.3 && x < f.courtyard[2] + 0.3 && y > f.courtyard[1] - 0.3 && y < f.courtyard[3] + 0.3);
    // a top-layer track whose middle is in the open (not under a part) and isn't the GND pour
    const t = b.tracks
      .filter((t: any) => t.layer === "F.Cu" && t.net !== "GND" && t.width >= 0.2)
      .map((t: any) => ({ net: t.net, x: (t.start[0] + t.end[0]) / 2, y: (t.start[1] + t.end[1]) / 2, len: Math.hypot(t.end[0] - t.start[0], t.end[1] - t.start[1]) }))
      .filter((t: any) => t.len > 1.5 && !inside(t.x, t.y))
      .sort((a: any, c: any) => c.len - a.len)[0];
    const u1 = b.footprints.find((f: any) => f.ref === "U1");
    return { track: t, u1: { x: u1.at[0], y: u1.at[1] } };
  });

test("clicking a track, a part and empty space in 3D selects like 2D", async ({ page }) => {
  const errors = collectErrors(page);
  await stubDatasheets(page);
  await ready(page, "./#tab=3d");
  await page.waitForFunction(() => (window as any).pcbReview.view3d && document.querySelector("#pane-3d")?.getAttribute("data-view3d") === "ready", null, { timeout: 30_000 });
  await page.evaluate(() => ((window as any).pcbReview.view3d as V3).view("top"));
  await page.waitForTimeout(800);
  const { track, u1 } = await target(page);

  const at = (x: number, y: number, z: number) => page.evaluate(([x, y, z]) => ((window as any).pcbReview.view3d as V3).project(x, y, z), [x, y, z]);

  // parts hidden for the track click: models stream in on (slow, software) WebGL and one landing on
  // the click point would turn it into a part pick (flaky in CI, 2026-10-26)
  await page.locator("[data-t3=parts]").uncheck();
  let [sx, sy] = await at(track.x, track.y, 0.006);
  await page.mouse.click(sx, sy);
  await expect.poll(() => page.evaluate(() => (window as any).pcbReview.state.net)).toBe(track.net);
  await expect(page.locator("#side-info h2")).toContainText(track.net);
  // the net's pads light up too (top face, seen from above), not just its tracks
  const padsLit = await page.evaluate(() => {
    let n = 0;
    (window as any).pcbReview.view3d._debug.scene.traverse((o: any) => { if (o.userData.padFace === "top" && o.visible) n += o.geometry.attributes.position.count; });
    return n;
  });
  expect(padsLit).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/pick3d-net.png" });

  await page.locator("[data-t3=parts]").check();
  [sx, sy] = await at(u1.x, u1.y, 0.6); // top of the QFN body (model or its box fallback)
  await page.mouse.click(sx, sy);
  await expect.poll(() => page.evaluate(() => (window as any).pcbReview.state.ref)).toBe("U1");
  await expect(page.locator("#side-info h2")).toContainText("U1");

  const box = (await page.locator("#pane-3d canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10); // background
  await expect.poll(() => page.evaluate(() => (window as any).pcbReview.state.ref)).toBeNull();

  // a drag (orbit) must not select
  [sx, sy] = await at(track.x, track.y, 0.006);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 60, sy + 40, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).pcbReview.state.net)).toBeNull();
  await page.screenshot({ path: "test-results/pick3d.png" });
  expect(errors).toEqual([]);
});

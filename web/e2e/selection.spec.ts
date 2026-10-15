// Regression: clicking nets one after another must never wedge the 2D viewer
// (stuck drag that pans on plain mouse moves, selection that can't change or clear).
import { test, expect } from "@playwright/test";
import { appState, collectErrors, netTargets, ready, stubDatasheets } from "./helpers";

test("many net clicks in a row, with clears in between, keep the viewer responsive", async ({ page }) => {
  const errors = collectErrors(page);
  await stubDatasheets(page);
  await ready(page);
  const targets = await netTargets(page);
  expect(targets.length).toBeGreaterThan(15);
  const box = (await page.locator("canvas.view2d").boundingBox())!;
  const empty = { x: box.x + 8, y: box.y + 8 }; // canvas corner, off the board

  for (const [i, t] of targets.entries()) {
    await page.mouse.click(t.x, t.y);
    const s = await appState(page);
    expect(s.net, `click ${i} on ${t.ref}.${t.num}`).toBe(t.net);
    await expect(page.locator("#side-info h2")).toContainText(t.net);

    // a plain mouse move (no button) must not pan: catches a drag left armed after the click
    await page.mouse.move(t.x + 120, t.y + 80, { steps: 4 });
    expect((await appState(page)).view).toEqual(s.view);

    if (i % 3 === 2) {
      // clearing the selection (click off the board) and selecting again afterwards
      await page.mouse.click(empty.x, empty.y);
      expect((await appState(page)).net).toBeNull();
    }
  }
  expect(errors).toEqual([]);
});

test("Escape clears, and a lost pointerup does not leave a drag armed", async ({ page }) => {
  const errors = collectErrors(page);
  await stubDatasheets(page);
  await ready(page);
  const [a, b] = await netTargets(page);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press("Escape");
  expect((await appState(page)).net).toBeNull();

  // press on the canvas, then the button is released outside the page (no pointerup reaches us)
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.locator("canvas.view2d").dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
  await page.mouse.up();
  const before = (await appState(page)).view;
  await page.mouse.move(a.x + 100, a.y + 100, { steps: 4 });
  expect((await appState(page)).view).toEqual(before);
  await page.mouse.click(b.x, b.y);
  expect((await appState(page)).net).toBe(b.net);
  expect(errors).toEqual([]);
});

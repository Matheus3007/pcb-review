// Regression (2026-10-15): LCSC's PDF links started answering with
// `<script>window.top.location.href='…'</script>`. In the side pane's iframe that made Firefox ask
// to allow a popup and, if allowed, replaced the whole review page with the PDF.
// Whatever a datasheet URL serves, clicking nets must never navigate the page or open a popup.
import { test, expect } from "@playwright/test";
import { appState, netTargets, ready } from "./helpers";

const HOSTILE = `<!doctype html><p>hostile datasheet stub</p><script>
  try { window.top.location.href = "https://evil.invalid/top"; } catch (e) {}
  try { window.open("https://evil.invalid/popup", "_blank"); } catch (e) {}
  try { const a = document.createElement("a"); a.href = "https://evil.invalid/a"; a.target = "_top"; document.body.append(a); a.click(); } catch (e) {}
</script>`;

test("datasheet frame can't navigate the page or open popups", async ({ page, context, browserName }) => {
  const popups: string[] = [];
  context.on("page", (p) => popups.push(p.url()));
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await context.route(/wmsc\.lcsc\.com|datasheet\.lcsc\.com|jlcpcb\.com\/api\/file/, (r) =>
    r.fulfill({ contentType: "text/html", body: HOSTILE }));
  await context.route(/evil\.invalid/, (r) => r.fulfill({ contentType: "text/html", body: "<h1>navigated away</h1>" }));

  await ready(page);
  // selection writes #net=… into the URL by design; the page itself (origin + path) must not change
  const where = () => { const u = new URL(page.url()); return u.origin + u.pathname + u.search; };
  const home = where();
  const targets = (await netTargets(page)).filter((t) => ["U1", "U4", "U5", "U2", "U3"].includes(t.ref)).slice(0, 4);
  expect(targets.length).toBeGreaterThan(2);
  for (const t of targets) {
    await page.mouse.click(t.x, t.y);
    await expect(page.locator(".pdf-frame iframe")).toHaveAttribute("src", /#page=\d+/);
    await page.waitForTimeout(1200); // let the stub run
    expect(where(), "the review page must stay").toBe(home);
    await expect(page.locator("#side-info h2")).toBeVisible(); // still our DOM, not the stub
    expect((await appState(page)).net).toBe(t.net);
  }
  expect(popups, "no popup windows").toEqual([]);
  expect(dialogs).toEqual([]);

  const sandbox = await page.locator(".pdf-frame iframe").getAttribute("sandbox");
  if (browserName === "firefox") {
    // Gecko renders PDFs in sandboxed frames: the sandbox must deny top navigation and popups
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toMatch(/allow-top-navigation|allow-popups/);
  } else {
    expect(sandbox ?? "").not.toMatch(/allow-top-navigation|allow-popups/);
  }
});

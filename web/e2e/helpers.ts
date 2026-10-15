import type { Page } from "@playwright/test";

/** Remote datasheets (LCSC/JLC) are stubbed: offline, deterministic, and chromium-headless-shell
 *  crashes on real cross-origin PDF iframes. */
export async function stubDatasheets(page: Page) {
  await page.route(/wmsc\.lcsc\.com|datasheet\.lcsc\.com|jlcpcb\.com\/api\/file/, (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>datasheet stub</p>" }));
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

type Hook = {
  bundle: { nets: string[]; footprints: { ref: string; side: string; dnp: boolean; pads: { num: string; net: string; at: [number, number]; size: [number, number]; layers: string[] }[] }[] };
  state: { net: string | null; ref: string | null; pin: string | null };
  view2d: { toScreen(x: number, y: number): [number, number]; viewState(): { scale: number; tx: number; ty: number } };
};

export async function ready(page: Page, url = "./") {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as unknown as { pcbReview?: unknown }).pcbReview);
}

/** One clickable point per net: the centre of its biggest top-side pad, in page coordinates. */
export async function netTargets(page: Page) {
  return page.evaluate(() => {
    const { bundle, view2d } = (window as unknown as { pcbReview: Hook }).pcbReview;
    const canvas = document.querySelector("canvas.view2d")!.getBoundingClientRect();
    const best = new Map<string, { x: number; y: number; area: number; ref: string; num: string }>();
    for (const fp of bundle.footprints) {
      if (fp.side !== "top") continue;
      for (const p of fp.pads) {
        if (!p.net || !p.layers.includes("F.Cu")) continue;
        const area = p.size[0] * p.size[1];
        if ((best.get(p.net)?.area ?? 0) >= area) continue;
        const [sx, sy] = view2d.toScreen(p.at[0], p.at[1]);
        best.set(p.net, { x: canvas.left + sx, y: canvas.top + sy, area, ref: fp.ref, num: p.num });
      }
    }
    return [...best].map(([net, t]) => ({ net, ...t }));
  });
}

export const appState = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { pcbReview: Hook }).pcbReview;
    return { ...h.state, view: h.view2d.viewState() };
  });

// Captures real Styx UI from observer.js and popup.html, running on the demo pages, into parts/.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pages from "./pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const parts = join(here, "parts");
mkdirSync(parts, { recursive: true });

const messages = JSON.parse(readFileSync(join(root, "_locales/en/messages.json"), "utf8"));
const url = (id) => `https://www.amazon.com/hz/wishlist/ls/${id}`;
const lists = [
  { listId: "DEMOWISH01", name: "Wish List", count: 9, kind: "default", access: "editable", url: url("DEMOWISH01") },
  { listId: "DEMOBDAY02", name: "Birthday Cart", count: 7, kind: "custom", access: "editable", url: url("DEMOBDAY02") },
  { listId: "DEMOGROC03", name: "Groceries Cart", count: 12, kind: "custom", access: "editable", url: url("DEMOGROC03") },
  { listId: "DEMOHOME04", name: "Home Project Cart", count: 5, kind: "custom", access: "editable", url: url("DEMOHOME04") },
];
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 3 });
await context.addInitScript(`window.__styxDemo = ${JSON.stringify({ messages, lists })};`);
await context.addInitScript({ path: join(here, "stub.js") });
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === "images.local") return route.fulfill({ contentType: "image/svg+xml", body: pages.bottle });
  if (u.hostname !== "www.amazon.com") return route.abort();
  // Keeps the panel iframe same-origin so it renders at full resolution.
  if (u.pathname.startsWith("/__ext/")) {
    const file = join(root, u.pathname.slice("/__ext/".length));
    return existsSync(file)
      ? route.fulfill({ contentType: types[extname(file)] || "text/plain", body: readFileSync(file) })
      : route.fulfill({ status: 404, body: "" });
  }
  const body = u.pathname.startsWith("/gp/cart") ? pages.cart
    : u.pathname.startsWith("/dp/") ? pages.product
    : u.pathname.startsWith("/hz/wishlist") ? pages.list : pages.search;
  return route.fulfill({ contentType: "text/html", body });
  return route.abort();
});

async function open(path) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR", path, e.message));
  await page.goto("https://www.amazon.com" + path);
  await page.addScriptTag({ content: readFileSync(join(root, "observer.js"), "utf8") });
  await page.waitForTimeout(700);
  // The first-run tip isn't part of any of these moments.
  await page.addStyleTag({ content: "#__styx-guide-tip,#__styx-start-hint{display:none!important}" });
  return page;
}

// Shoots one element on a transparent background, with the rest of the page hidden.
async function shoot(page, selector, name) {
  const tag = await page.addStyleTag({ content: `
    html, body { background: transparent !important; }
    body * { visibility: hidden !important; }
    ${selector}, ${selector} * { visibility: visible !important; }` });
  await page.locator(selector).first().screenshot({ path: join(parts, name + ".png"), omitBackground: true });
  await tag.evaluate((n) => n.remove());
}

const cart = await open("/gp/cart/view.html");
await page_shot(cart, "#sc-buy-box", "cart-buybox");
await cart.click("#styx-clear-cart");
await cart.waitForTimeout(200);
await cart.addStyleTag({ content: "#styx-clear-cart-confirm { background: transparent !important; }" });
await shoot(cart, ".styx-clear-cart-confirm-card", "clear-dialog");
await cart.locator("[data-styx-clear-choice='cancel']").click();
// The real completion toast, using the same message the service worker sends.
const sw = readFileSync(join(root, "src/background/index.js"), "utf8");
const start = sw.indexOf("function pageShowStatus(");
const showStatus = sw.slice(start, sw.indexOf("\n}\n", start) + 2);
await cart.evaluate(`(${showStatus})(${JSON.stringify(messages.bg_cartClearedRemoved.message.replace("$1", "3 items"))}, "done", "light", "bottom")`);
await cart.waitForTimeout(500);
await shoot(cart, "#__styx-status-toast", "toast-done");
await cart.close();

const product = await open("/dp/B0DEMO0001");
await page_shot(product, "#buybox", "product-buybox");
await product.close();

const search = await open("/s?k=water+bottle");
await search.click("#a-autoid-1-announce");
await search.waitForSelector(".styx-pk-modal");
await search.waitForTimeout(300);
await search.addStyleTag({ content: ".styx-pk-backdrop { background: transparent !important; backdrop-filter: none !important; }" });
await shoot(search, ".styx-pk-modal", "picker");
await search.close();

const list = await open("/hz/wishlist/ls/DEMOBDAY02");
await shoot(list, ".styx-brand-btn", "send-all");
await list.click("#__styx-fab");
await list.waitForSelector("#__styx-fab-modal:not([hidden])");
await list.waitForTimeout(1500);
// Only four demo carts, so trim the panel's empty lower half.
await list.addStyleTag({ content: "#__styx-fab-modal { height: 460px !important; }" });
await list.waitForTimeout(200);
await shoot(list, "#__styx-fab-modal", "panel");
await list.close();

await browser.close();

async function page_shot(page, selector, name) {
  await page.locator(selector).screenshot({ path: join(parts, name + ".png") });
}

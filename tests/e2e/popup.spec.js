/**
 * Popup E2E — drives popup.html against a stubbed sendMessage backend so the
 * UI flows are exercised end-to-end without needing a real Amazon tab.
 *
 * What we lock down here is the "popup contract": which buttons exist, what
 * messages they emit, and how the popup re-renders when the backend responds.
 * Real cart scraping / restore is covered by Phase 1+2 unit tests; here we
 * only care that the UI calls the right handlers with the right args and
 * reflects state correctly.
 */

import { test, expect } from "./fixtures.js";

test.describe("popup — empty state", () => {
  test("shows the empty hint and zero count", async ({ popup }) => {
    const page = await popup({ carts: [] });

    await expect(page.locator("#mc-list-count")).toHaveText("0");
    await expect(page.locator("#mc-empty")).toBeVisible();
    await expect(page.locator("#mc-list .mc-item")).toHaveCount(0);
  });

  test("shows a placeholder on the name field but leaves the value empty", async ({
    popup,
  }) => {
    const page = await popup({ carts: [] });
    const input = page.locator("#mc-name");
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", /./);
  });
});

test.describe("popup — saving carts", () => {
  test("Save sends MC_SAVE_CURRENT with the entered name and renders the new row", async ({
    popup,
  }) => {
    const page = await popup({ carts: [] });

    await page.locator("#mc-name").fill("My Birthday Cart");
    await page.locator("#mc-save").click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(1);
    await expect(page.locator("#mc-list .mc-item-name").first()).toHaveText(
      "My Birthday Cart"
    );
    await expect(page.locator("#mc-list-count")).toHaveText("1");

    // Confirm the message that went out had the right shape.
    const log = await page.evaluate(() => window.__mcMessageLog);
    const save = log.find((m) => m.type === "MC_SAVE_CURRENT");
    expect(save).toBeTruthy();
    expect(save.name).toBe("My Birthday Cart");
  });

  test("Save with a blank name falls back to the date-based default", async ({
    popup,
  }) => {
    const page = await popup({ carts: [] });

    await page.locator("#mc-name").fill("");
    await page.locator("#mc-save").click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(1);

    // popup.js's defaultName() returns "Cart · <date>, <time>" — the leading
    // "Cart · " prefix is the stable bit worth pinning.
    const savedName = await page
      .locator("#mc-list .mc-item-name")
      .first()
      .textContent();
    expect(savedName).toMatch(/^Cart · /);

    const log = await page.evaluate(() => window.__mcMessageLog);
    const save = log.find((m) => m.type === "MC_SAVE_CURRENT");
    expect(save).toBeTruthy();
    expect(save.name).toMatch(/^Cart · /);
  });

  test("Create new adds an empty cart row", async ({ popup }) => {
    const page = await popup({ carts: [] });

    await page.locator("#mc-create-new").click();
    await expect(page.locator("#mc-prompt-title")).toHaveText("Create a new cart");
    await page.locator("#mc-prompt-input").fill("Empty Cart Test");
    await page.locator("#mc-prompt-ok").click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(1);
    await expect(page.locator("#mc-list .mc-item-name").first()).toHaveText(
      "Empty Cart Test"
    );

    const log = await page.evaluate(() => window.__mcMessageLog);
    const create = log.find((m) => m.type === "MC_CREATE_EMPTY_CART");
    expect(create).toBeTruthy();
    expect(create.name).toBe("Empty Cart Test");
  });
});

test.describe("popup — managing existing carts", () => {
  const seedCarts = [
    {
      id: "cart-a",
      name: "Cart A",
      savedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      host: "www.amazon.com",
      items: [
        { asin: "B0001", title: "Item 1", quantity: 1, price: "$1", image: "", url: "" },
      ],
    },
    {
      id: "cart-b",
      name: "Cart B",
      savedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      host: "www.amazon.co.uk",
      items: [
        { asin: "B0010", title: "X", quantity: 2, price: "£2", image: "", url: "" },
        { asin: "B0011", title: "Y", quantity: 3, price: "£3", image: "", url: "" },
      ],
    },
  ];

  test("renders seeded carts in order with correct counts and host meta", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    await expect(page.locator("#mc-list-count")).toHaveText("2");
    const names = await page
      .locator("#mc-list .mc-item-name")
      .allTextContents();
    expect(names).toEqual(["Cart A", "Cart B"]);

    // Cart B should report "amazon.co.uk" (host minus leading www.) in its meta.
    const cartBMeta = await page
      .locator('#mc-list .mc-item:has-text("Cart B") .mc-item-meta')
      .first()
      .textContent();
    expect(cartBMeta).toContain("amazon.co.uk");

    // Cart B summary should read "2 items · 5 qty".
    const cartBCount = await page
      .locator('#mc-list .mc-item:has-text("Cart B") .mc-item-count')
      .first()
      .textContent();
    expect(cartBCount).toContain("2 items");
    expect(cartBCount).toContain("5 qty");

    await expect(
      page.locator('#mc-list .mc-item:has-text("Cart A") [data-action="restore"]')
    ).toHaveText("Switch to This Cart");
  });

  test("renders one tile per item (placeholders included), capped behind a +N toggle", async ({
    popup,
  }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-late-image",
          name: "Late Image",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BNOIMG1", title: "No Image 1", quantity: 1, price: "", image: "", url: "" },
            { asin: "BNOIMG2", title: "No Image 2", quantity: 1, price: "", image: "", url: "" },
            { asin: "BNOIMG3", title: "No Image 3", quantity: 1, price: "", image: "", url: "" },
            { asin: "BNOIMG4", title: "No Image 4", quantity: 1, price: "", image: "", url: "" },
            { asin: "BNOIMG5", title: "No Image 5", quantity: 1, price: "", image: "", url: "" },
            { asin: "BNOIMG6", title: "No Image 6", quantity: 1, price: "", image: "", url: "" },
            { asin: "BHASIMG7", title: "Has Image 7", quantity: 1, price: "", image: "icons/icon32.png", url: "" },
          ],
        },
      ],
    });

    const cart = page.locator('#mc-list .mc-item:has-text("Late Image")');
    // 7 items, cap 6 → 6 tiles plus a "+1" toggle. Image-less items still get
    // a (placeholder) tile so they remain manageable.
    await expect(cart.locator(".mc-thumb")).toHaveCount(6);
    await expect(cart.locator(".mc-thumb.mc-thumb-noimg").first()).toBeVisible();
    const more = cart.locator(".mc-item-thumb-more");
    await expect(more).toHaveText("+1");

    // Expanding reveals every item and flips the toggle label.
    await more.click();
    await expect(cart.locator(".mc-thumb")).toHaveCount(7);
    await expect(cart.locator(".mc-item-thumb-more")).toHaveText("Show less");
  });

  test("switch cart confirmation explains that the Amazon cart is replaced", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="restore"]')
      .click();

    await expect(page.locator("#mc-confirm-title")).toHaveText("Switch to this cart?");
    await expect(page.locator("#mc-confirm-body")).toHaveText(
      'This will replace your current Amazon cart with "Cart A".'
    );

    await page.locator("#mc-confirm-ok").click();
    const log = await page.evaluate(() => window.__mcMessageLog);
    const restore = log.find((m) => m.type === "MC_RESTORE_CART");
    expect(restore).toMatchObject({ id: "cart-a" });
  });

  test("rename emits MC_RENAME_CART and updates the row in place", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    // The .mc-item-name button is data-action="rename" — clicking it triggers rename.
    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="rename"]')
      .click();
    await expect(page.locator("#mc-prompt-title")).toHaveText("Rename cart");
    await page.locator("#mc-prompt-input").fill("Cart A Renamed");
    await page.locator("#mc-prompt-ok").click();

    await expect(
      page.locator("#mc-list .mc-item-name").first()
    ).toHaveText("Cart A Renamed");

    const log = await page.evaluate(() => window.__mcMessageLog);
    const rename = log.find((m) => m.type === "MC_RENAME_CART");
    expect(rename).toMatchObject({ id: "cart-a", name: "Cart A Renamed" });
  });

  test("delete prompts for confirmation, then removes the row", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="delete"]')
      .click();
    await expect(page.locator("#mc-confirm-title")).toHaveText("Delete saved cart?");
    await page.locator("#mc-confirm-ok").click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(1);
    await expect(page.locator("#mc-list .mc-item-name").first()).toHaveText(
      "Cart B"
    );

    const log = await page.evaluate(() => window.__mcMessageLog);
    const del = log.find((m) => m.type === "MC_DELETE_CART");
    expect(del).toMatchObject({ id: "cart-a" });
  });

  test("delete is cancelled when the user dismisses the confirm dialog", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    await page.evaluate(() => {
      window.confirm = () => false;
    });
    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="delete"]')
      .click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(2);
    const log = await page.evaluate(() => window.__mcMessageLog);
    expect(log.some((m) => m.type === "MC_DELETE_CART")).toBe(false);
  });

  test("the tile X removes an item instantly (no confirm) when others remain", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-images",
          name: "Cart Images",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BIMG1", title: "First Image", quantity: 1, price: "", image: "icons/icon16.png", url: "" },
            { asin: "BIMG2", title: "Second Image", quantity: 1, price: "", image: "icons/icon32.png", url: "" },
          ],
        },
      ],
    });

    const cart = page.locator('#mc-list .mc-item:has-text("Cart Images")');
    await expect(cart.locator(".mc-thumb")).toHaveCount(2);

    await cart.locator('.mc-thumb[data-asin="BIMG1"] [data-action="thumb-remove"]').click();

    // No confirmation gate for a non-final item.
    await expect(page.locator("#mc-confirm-modal")).toBeHidden();
    await expect(cart.locator(".mc-item-count")).toContainText("1 item");
    await expect(cart.locator(".mc-thumb")).toHaveCount(1);
    await expect(cart.locator('.mc-thumb[data-asin="BIMG2"]')).toHaveCount(1);
  });

  test("removing the last item confirms first, then deletes the cart", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-solo",
          name: "Solo Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BSOLO", title: "Lone Item", quantity: 1, price: "", image: "", url: "" },
          ],
        },
      ],
    });

    const cart = page.locator('#mc-list .mc-item:has-text("Solo Cart")');
    await cart.locator('.mc-thumb[data-asin="BSOLO"] [data-action="thumb-remove"]').click();

    await expect(page.locator("#mc-confirm-title")).toHaveText("Remove last item?");
    await page.locator("#mc-confirm-ok").click();

    await expect(page.locator("#mc-list .mc-item")).toHaveCount(0);
  });

  test("the count badge popover adjusts an item's quantity", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-qty",
          name: "Qty Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BQTY1", title: "Counter", quantity: 1, price: "", image: "icons/icon16.png", url: "" },
          ],
        },
      ],
    });

    const cart = page.locator('#mc-list .mc-item:has-text("Qty Cart")');
    const badge = cart.locator('.mc-thumb[data-asin="BQTY1"] .mc-thumb-qty');
    await expect(badge).toHaveText("1");

    await badge.click();
    await expect(page.locator("#mc-qty-pop")).toBeVisible();
    await page.locator('#mc-qty-pop [data-action="qty-pop-inc"]').click();
    await page.locator('#mc-qty-pop [data-action="qty-pop-inc"]').click();

    await expect(badge).toHaveText("3");
    await expect(cart.locator(".mc-item-count")).toContainText("3 qty");

    const log = await page.evaluate(() => window.__mcMessageLog);
    expect(log.some((m) => m.type === "MC_UPDATE_ITEM_QUANTITY" && m.quantity === 3)).toBe(true);
  });
});

test.describe("popup — moving items between carts", () => {
  const twoCarts = () => ({
    carts: [
      {
        id: "cart-src",
        name: "Source Cart",
        savedAt: new Date().toISOString(),
        host: "www.amazon.com",
        items: [
          { asin: "BMOVE1", title: "Movable Item", quantity: 1, price: "", image: "icons/icon16.png", url: "" },
          { asin: "BMOVE2", title: "Stays Put", quantity: 1, price: "", image: "icons/icon32.png", url: "" },
        ],
      },
      {
        id: "cart-dst",
        name: "Dest Cart",
        savedAt: new Date().toISOString(),
        host: "www.amazon.com",
        items: [],
      },
    ],
  });

  test("clicking an item thumbnail opens the move modal listing other carts", async ({ popup }) => {
    const page = await popup(twoCarts());
    const cart = page.locator('#mc-list .mc-item:has-text("Source Cart")');

    await cart.locator('.mc-thumb[data-asin="BMOVE1"]').click();

    await expect(page.locator("#mc-move-modal")).toBeVisible();
    await expect(page.locator("#mc-move-modal .mc-move-item-name")).toHaveText("Movable Item");
    // Only the OTHER cart is offered as a destination.
    const opts = page.locator("#mc-move-modal .mc-move-option");
    await expect(opts).toHaveCount(1);
    await expect(opts.first().locator(".mc-move-option-name")).toHaveText("Dest Cart");
  });

  test("move modal expands for several destinations and scrolls the rest", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-src",
          name: "Source Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BMOVE1", title: "Movable Item", quantity: 1, price: "", image: "icons/icon16.png", url: "" },
          ],
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `cart-dst-${i + 1}`,
          name: `Dest Cart ${i + 1}`,
          savedAt: new Date().toISOString(),
          // Hostless legacy carts should be treated like the default US cart.
          host: i === 0 ? undefined : "www.amazon.com",
          items: [],
        })),
      ],
    });
    const cart = page.locator('#mc-list .mc-item:has-text("Source Cart")');

    await cart.locator('.mc-thumb[data-asin="BMOVE1"]').click();

    const opts = page.locator("#mc-move-modal .mc-move-option");
    await expect(opts).toHaveCount(5);
    await expect(page.locator("body")).toHaveClass(/mc-move-modal-open/);
    await expect(page.locator("#mc-move-modal .mc-move-list")).toHaveClass(
      /mc-move-list-scrollable/
    );

    const metrics = await page.locator("#mc-move-modal .mc-move-list").evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(metrics.clientHeight).toBeGreaterThanOrEqual(168);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test("picking a destination moves the item and updates both carts", async ({ popup }) => {
    const page = await popup(twoCarts());
    const src = page.locator('#mc-list .mc-item:has-text("Source Cart")');
    const dst = page.locator('#mc-list .mc-item:has-text("Dest Cart")');

    await src.locator('.mc-thumb[data-asin="BMOVE1"]').click();
    await page.locator('#mc-move-modal .mc-move-option[data-target-id="cart-dst"]').click();

    // Modal closes, the right message went out.
    await expect(page.locator("#mc-move-modal")).toBeHidden();
    const log = await page.evaluate(() => window.__mcMessageLog);
    const move = log.find((m) => m.type === "MC_MOVE_ITEM_BETWEEN_CARTS");
    expect(move).toMatchObject({ sourceId: "cart-src", targetId: "cart-dst", asin: "BMOVE1" });

    // Source loses the item, destination gains it.
    await expect(src.locator(".mc-item-count")).toContainText("1 item");
    await expect(dst.locator(".mc-item-count")).toContainText("1 item");
    await expect(src.locator('.mc-thumb[data-asin="BMOVE1"]')).toHaveCount(0);
  });

  test("creating a destination from the move modal creates a same-host cart and moves the item", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-src",
          name: "Source Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.co.uk",
          items: [
            { asin: "BMOVE1", title: "Movable Item", quantity: 1, price: "", image: "icons/icon16.png", url: "" },
            { asin: "BMOVE2", title: "Stays Put", quantity: 1, price: "", image: "icons/icon32.png", url: "" },
          ],
        },
      ],
    });

    await page.locator('#mc-list .mc-item:has-text("Source Cart") .mc-thumb[data-asin="BMOVE1"]').click();
    await page.locator('#mc-move-modal [data-action="move-create"]').click();
    await expect(page.locator("#mc-prompt-title")).toHaveText("Create destination cart");
    await page.locator("#mc-prompt-input").fill("New UK Cart");
    await page.locator("#mc-prompt-ok").click();

    await expect(page.locator("#mc-move-modal")).toBeHidden();
    await expect(page.locator('#mc-list .mc-item:has-text("Source Cart") .mc-item-count')).toContainText("1 item");
    await expect(page.locator('#mc-list .mc-item:has-text("New UK Cart") .mc-item-count')).toContainText("1 item");

    const log = await page.evaluate(() => window.__mcMessageLog);
    const create = log.find((m) => m.type === "MC_CREATE_EMPTY_CART");
    expect(create).toMatchObject({ name: "New UK Cart", host: "www.amazon.co.uk" });
    const createdCart = await page.evaluate(() =>
      window.__mcTestState["mc.carts.v1"].find((c) => c.name === "New UK Cart")
    );
    const move = log.find((m) => m.type === "MC_MOVE_ITEM_BETWEEN_CARTS");
    expect(move).toMatchObject({ sourceId: "cart-src", targetId: createdCart.id, asin: "BMOVE1" });
  });

  test("moving the last item out deletes the now-empty source cart", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "cart-lonely",
          name: "Lonely Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [
            { asin: "BONLY1", title: "Only Item", quantity: 1, price: "", image: "", url: "" },
          ],
        },
        {
          id: "cart-dst2",
          name: "Other Cart",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [],
        },
      ],
    });

    const src = page.locator('#mc-list .mc-item:has-text("Lonely Cart")');
    await src.locator('.mc-thumb[data-asin="BONLY1"]').click();
    await page.locator('#mc-move-modal .mc-move-option[data-target-id="cart-dst2"]').click();

    await expect(page.locator('#mc-list .mc-item:has-text("Lonely Cart")')).toHaveCount(0);
    await expect(page.locator("#mc-list .mc-item")).toHaveCount(1);
    await expect(page.locator('#mc-list .mc-item:has-text("Other Cart") .mc-item-count')).toContainText("1 item");
  });
});

test.describe("popup — settings toggles", () => {
  test("intercept toggle reflects stored setting and persists changes", async ({
    popup,
  }) => {
    const page = await popup({
      carts: [],
      settings: { interceptAtc: false },
    });

    const toggle = page.locator("#mc-intercept-toggle");
    await expect(toggle).not.toBeChecked();

    await toggle.check();

    const log = await page.evaluate(() => window.__mcMessageLog);
    const set = log.find((m) => m.type === "MC_SET_INTERCEPT");
    expect(set).toEqual({ type: "MC_SET_INTERCEPT", enabled: true });

    // And the backing store reflects it for any subsequent reads.
    const stored = await page.evaluate(
      () => window.__mcTestState["mc.settings.v1"].interceptAtc
    );
    expect(stored).toBe(true);
  });

  test("theme toggle flips data-theme and persists into mc.settings.v1", async ({
    popup,
  }) => {
    const page = await popup({ carts: [] });

    // Initial: no data-theme attribute (system default).
    const initial = await page.evaluate(
      () => document.documentElement.dataset.theme || ""
    );
    expect(["", "light", "dark"]).toContain(initial);

    await page.locator("#mc-theme-toggle").click();
    const afterFirst = await page.evaluate(
      () => document.documentElement.dataset.theme
    );
    expect(["light", "dark"]).toContain(afterFirst);

    // A second click should flip to the opposite value.
    await page.locator("#mc-theme-toggle").click();
    const afterSecond = await page.evaluate(
      () => document.documentElement.dataset.theme
    );
    expect(afterSecond).not.toBe(afterFirst);
    expect(["light", "dark"]).toContain(afterSecond);

    // Persisted alongside other settings.
    const persisted = await page.evaluate(
      () => window.__mcTestState["mc.settings.v1"].theme
    );
    expect(persisted).toBe(afterSecond);
  });
});

test.describe("popup — clear cart", () => {
  test("Clear cart prompts and emits MC_CLEAR_CURRENT", async ({ popup }) => {
    const page = await popup({ carts: [] });

    await page.locator("#mc-clear").click();
    await expect(page.locator("#mc-confirm-title")).toHaveText("Clear Amazon cart?");
    await page.locator("#mc-confirm-ok").click();

    // Wait until the popup actually fires the message — the click flow is async.
    await expect
      .poll(async () =>
        page.evaluate(() =>
          window.__mcMessageLog.some((m) => m.type === "MC_CLEAR_CURRENT")
        )
      )
      .toBe(true);
  });
});

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

    // popup.js prompts for a name via window.prompt — stub it.
    await page.evaluate(() => {
      window.prompt = () => "Empty Cart Test";
    });
    await page.locator("#mc-create-new").click();

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
  });

  test("rename emits MC_RENAME_CART and updates the row in place", async ({
    popup,
  }) => {
    const page = await popup({ carts: seedCarts });

    await page.evaluate(() => {
      window.prompt = () => "Cart A Renamed";
    });
    // The .mc-item-name button is data-action="rename" — clicking it triggers rename.
    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="rename"]')
      .click();

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

    // popup.js uses window.confirm to gate deletion.
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page
      .locator('#mc-list .mc-item:has-text("Cart A") [data-action="delete"]')
      .click();

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

    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.locator("#mc-clear").click();

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

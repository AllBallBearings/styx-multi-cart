/**
 * Popup E2E — Amazon-list dashboard contract.
 *
 * Local Styx carts remain in storage for compatibility, but the popup now
 * renders the signed-in user's Amazon wish lists and reads items lazily.
 */

import { test, expect } from "./fixtures.js";

const amazonLists = [
  {
    listId: "LISTONE",
    name: "Birthday Ideas",
    url: "https://www.amazon.com/hz/wishlist/ls/LISTONE",
    host: "www.amazon.com",
    items: [
      {
        asin: "B000LIST01",
        title: "Green headphones",
        quantity: 1,
        image: "icons/icon32.png",
        url: "https://www.amazon.com/dp/B000LIST01",
      },
      {
        asin: "B000LIST02",
        title: "Travel mug",
        quantity: 2,
        image: "",
        url: "https://www.amazon.com/dp/B000LIST02",
      },
      {
        asin: "B000GONE01",
        title: "Discontinued item",
        quantity: 1,
        image: "",
        url: "https://www.amazon.com/dp/B000GONE01",
        unavailable: true,
        unavailableReason: "This item is no longer available",
      },
    ],
  },
  {
    listId: "LISTTWO",
    name: "Office Setup",
    url: "https://www.amazon.com/hz/wishlist/ls/LISTTWO",
    host: "www.amazon.com",
    items: [],
  },
];

test.describe("popup — Amazon list dashboard", () => {
  test("renders Amazon lists instead of local Styx carts", async ({ popup }) => {
    const page = await popup({
      carts: [
        {
          id: "local-cart",
          name: "Should not render",
          savedAt: new Date().toISOString(),
          host: "www.amazon.com",
          items: [{ asin: "BLOCAL0001", title: "Local item", quantity: 1 }],
        },
      ],
      amazonLists,
    });

    await expect(page.locator(".mc-list-header h2")).toHaveText("Amazon Lists");
    await expect(page.locator("#mc-list-count")).toHaveText("2");
    await expect(page.locator("#mc-list .mc-amazon-list-card")).toHaveCount(2);
    await expect(page.locator("#mc-list")).not.toContainText("Should not render");
    await expect(page.locator(".mc-save-block")).toBeHidden();
  });

  test("loads and displays list items only when expanded", async ({ popup }) => {
    const page = await popup({ amazonLists });
    const card = page.locator('.mc-amazon-list-card[data-list-id="LISTONE"]');

    await expect(card.locator(".mc-item-thumbs")).toBeHidden();
    await card.locator('[data-action="toggle-amazon-list"]').click();

    await expect(card.locator(".mc-item-thumbs")).toBeVisible();
    await expect(card.locator(".mc-thumb")).toHaveCount(3);
    await expect(card.locator(".mc-thumb-unavailable")).toHaveCount(1);
    await expect(card.locator(".mc-item-count")).toHaveText(
      "3 items · 4 qty · 1 unavailable"
    );
    await expect(card.locator('[data-action="load-amazon-list-cart"]')).toHaveText(
      "Add 2 Available to Cart"
    );
    await expect(card.locator(".mc-amazon-list-actions")).toBeVisible();

    const log = await page.evaluate(() => window.__mcMessageLog);
    const reads = log.filter((message) => message.type === "MC_GET_AMAZON_LIST");
    expect(reads).toHaveLength(1);
    expect(reads[0].listId).toBe("LISTONE");
  });

  test("collapsing and reopening a list reuses the loaded items", async ({ popup }) => {
    const page = await popup({ amazonLists });
    const card = page.locator('.mc-amazon-list-card[data-list-id="LISTONE"]');
    const toggle = card.locator('[data-action="toggle-amazon-list"]');

    await toggle.click();
    await expect(card.locator(".mc-thumb")).toHaveCount(3);
    await toggle.click();
    await expect(card.locator(".mc-item-thumbs")).toBeHidden();
    await toggle.click();
    await expect(card.locator(".mc-item-thumbs")).toBeVisible();

    const count = await page.evaluate(
      () => window.__mcMessageLog.filter((message) => message.type === "MC_GET_AMAZON_LIST").length
    );
    expect(count).toBe(1);
  });

  test("Add All sends the loaded wishlist items to the cart flow", async ({ popup }) => {
    const page = await popup({ amazonLists });
    const card = page.locator('.mc-amazon-list-card[data-list-id="LISTONE"]');
    await card.locator('[data-action="toggle-amazon-list"]').click();
    await card.locator('[data-action="load-amazon-list-cart"]').click();

    await expect(page.locator("#mc-confirm-title")).toHaveText("Add this list to your cart?");
    await expect(page.locator("#mc-confirm-body")).toContainText(
      "1 unavailable item will be skipped"
    );
    await page.locator("#mc-confirm-ok").click();

    await expect.poll(async () =>
      page.evaluate(() =>
        window.__mcMessageLog.filter((message) => message.type === "MC_WISHLIST_ADD_ALL").length
      )
    ).toBe(1);
    const message = await page.evaluate(() =>
      window.__mcMessageLog.find((entry) => entry.type === "MC_WISHLIST_ADD_ALL")
    );
    expect(message.items).toHaveLength(2);
    expect(message.items.some((item) => item.unavailable)).toBe(false);
    expect(message.host).toBe("www.amazon.com");
  });

  test("shows the signed-out/empty state when no lists are found", async ({ popup }) => {
    const page = await popup({ amazonLists: [] });

    await expect(page.locator("#mc-list-count")).toHaveText("0");
    await expect(page.locator("#mc-empty")).toBeVisible();
    await expect(page.locator("#mc-list .mc-amazon-list-card")).toHaveCount(0);
  });

  test("refresh requests the Amazon list index again", async ({ popup }) => {
    const page = await popup({ amazonLists });
    await page.locator("#mc-amazon-lists-refresh").click();

    await expect.poll(async () =>
      page.evaluate(() =>
        window.__mcMessageLog.filter((message) => message.type === "MC_LIST_AMAZON_LISTS").length
      )
    ).toBe(2);
  });

  test("Clear Amazon Cart remains accessible and sends MC_CLEAR_CURRENT", async ({ popup }) => {
    const page = await popup({ amazonLists });
    const clear = page.locator("#mc-clear");
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator("#mc-confirm-title")).toHaveText("Clear Amazon cart?");
    await page.locator("#mc-confirm-ok").click();

    await expect.poll(async () =>
      page.evaluate(() =>
        window.__mcMessageLog.filter((message) => message.type === "MC_CLEAR_CURRENT").length
      )
    ).toBe(1);
  });
});

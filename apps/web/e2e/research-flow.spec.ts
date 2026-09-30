import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [1440, 375])
  test(`research search and private groups at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/explore/all?q=%40research_whale");
    const results = page.getByRole("region", { name: "Matching traders" });
    await expect(
      results.getByText("Research Whale", { exact: true }),
    ).toBeVisible();
    await expect(results).toContainText("No leaderboard metrics yet");
    await expect(results.getByRole("link")).toHaveAttribute(
      "href",
      "/trader/0x" + "a1".repeat(20),
    );
    // Private favorite groups on the favorites page (CopyDog's watchlist
    // chips; the fixture account starts with two seeded groups).
    await page.goto("/favorites");
    await page.getByRole("button", { name: "Demo login", exact: true }).click();
    const chips = page.getByRole("tablist", { name: "Manage groups" });
    const allChip = chips.getByRole("tab", { name: /^All/ });
    await expect(allChip).toBeVisible();
    const addButtons = page.getByRole("button", { name: "Add to group", exact: true });
    await expect(addButtons.first()).toBeVisible();
    const cards = await addButtons.count();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Group name", { exact: true }).fill("Research");
    await page.keyboard.press("Enter");
    const research = chips.getByRole("tab", { name: /^Research/ });
    await expect(research).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No traders in this group", { exact: true })).toBeVisible();
    await allChip.click();
    // Membership is server-confirmed; wait for the mutation and refetch.
    await addButtons.first().click();
    await page.getByRole("option", { name: "Research", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(research).toContainText("1");
    await research.click();
    await expect(addButtons).toHaveCount(1);
    await page.getByRole("button", { name: "Manage groups", exact: true }).click();
    const manage = page.getByRole("dialog", { name: "Manage groups" });
    await manage.getByRole("button", { name: "Research", exact: true }).click();
    await manage.getByLabel("Rename", { exact: true }).fill("Watch closely");
    await page.keyboard.press("Enter");
    await expect(manage.getByRole("button", { name: "Watch closely", exact: true })).toBeVisible();
    await manage.getByRole("button", { name: "Delete group", exact: true }).last().click();
    const confirm = page.getByRole("dialog", { name: "Delete group" });
    await expect(confirm).toContainText("Traders in the group stay in your watchlist.");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await manage.getByRole("button", { name: "Done", exact: true }).last().click();
    await expect(chips.getByRole("tab", { name: /^Watch closely/ })).toHaveCount(0);
    await allChip.click();
    await expect(addButtons).toHaveCount(cards);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/orbie-research-${width}.png`,
      fullPage: true,
    });
  });

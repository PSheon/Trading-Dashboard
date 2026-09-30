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
    await page.goto("/favorites");
    await page.getByRole("button", { name: "Demo login", exact: true }).click();
    const favoriteRows = page
      .getByRole("table", { name: "Favorite traders" })
      .locator("tbody tr");
    await expect(favoriteRows.first()).toBeVisible();
    const originalRows = await favoriteRows.count();
    await page
      .getByLabel("Group name (up to 40 characters)", { exact: true })
      .fill("Research");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(
      page.getByLabel("Choose favorite group").locator("option"),
    ).toHaveCount(2);
    await page
      .getByLabel("Choose favorite group")
      .selectOption({ label: "Research (0)" });
    await page.getByText("Organize group members", { exact: true }).click();
    // Membership is server-confirmed; wait for the mutation and refetch.
    const member = page.locator("details input[type=checkbox]").first();
    await member.click();
    await expect(member).toBeChecked();
    await expect(
      page.getByLabel("Choose favorite group").locator("option:checked"),
    ).toHaveText("Research (1)");
    await expect(favoriteRows).toHaveCount(1);
    await page
      .getByLabel("Group name (up to 40 characters)", { exact: true })
      .fill("Watch closely");
    await page
      .getByRole("button", { name: "Rename selected group", exact: true })
      .click();
    await expect(
      page.getByLabel("Choose favorite group").locator("option:checked"),
    ).toHaveText("Watch closely (1)");
    await page
      .getByRole("button", { name: "Delete group", exact: true })
      .click();
    await expect(
      page.getByText(
        "Only this group is deleted. Trader favorites and alerts are retained.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Confirm group deletion", exact: true })
      .click();
    await expect(
      page.getByLabel("Choose favorite group").locator("option"),
    ).toHaveCount(1);
    await expect(favoriteRows).toHaveCount(originalRows);
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

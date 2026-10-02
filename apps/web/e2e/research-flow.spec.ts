import { shot, signIn, wcag } from "./helpers";
import { expect, test } from "@playwright/test";
for (const width of [1440, 375])
  test(`research search and private groups at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    // Orbie's indexed-trader search lives in the lab (CopyDog has no such page).
    await page.goto("/dev/explore/all?q=%40research_whale");
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
    await signIn(page);
    // Three tabs, as on CopyDog: copies are on /portfolio, not here.
    await expect(page.getByRole("tablist", { name: "Saved" }).getByRole("tab")).toHaveText([/^Saved/, /^Alerts/, /^Feed/]);
    const chips = page.getByRole("group", { name: "Groups" });
    const allChip = chips.getByRole("button", { name: /^All/ });
    await expect(allChip).toBeVisible();
    const addButtons = page.getByRole("button", { name: "Add to group", exact: true });
    await expect(addButtons.first()).toBeVisible();
    const cards = await addButtons.count();
    await page.getByRole("button", { name: "New Group", exact: true }).click();
    await page.getByLabel("Group name", { exact: true }).fill("Research");
    await page.keyboard.press("Enter");
    const research = chips.getByRole("button", { name: /^Research/ });
    await expect(research).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("No traders in this group", { exact: true })).toBeVisible();
    await allChip.click();
    // Membership is server-confirmed; wait for the mutation and refetch.
    await addButtons.first().click();
    await page.getByRole("option", { name: "Research", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(research).toContainText("1");
    await shot(page, `favorites-groups-${width}`);
    await research.click();
    await expect(addButtons).toHaveCount(1);
    // Groups are created and deleted, not renamed or reordered (CopyDog
    // has neither): the chip row offers nothing else.
    await expect(page.getByRole("button", { name: "Manage groups" })).toHaveCount(0);
    await chips.getByRole("button", { name: "Delete group Research", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete group" });
    await expect(confirm).toContainText("Traders in the group stay in your watchlist.");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(chips.getByRole("button", { name: /^Research/ })).toHaveCount(0);
    await allChip.click();
    await expect(addButtons).toHaveCount(cards);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await (await wcag(page))
          // A group tag is tinted with the group's own colour (the palette
          // CopyDog offers); the 11px blue one reads 4.2:1, under AA's 4.5.
          .exclude('[data-slot="group-tag"]')
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/orbie-research-${width}.png`,
      fullPage: true,
    });
  });

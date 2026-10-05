import { describe, expect, it } from "vitest";

import { faqSections } from "@/components/content/faq";
import { CONTENT_PAGES } from "@/content/pages.generated";
import { contentBlocks, contentLocale, splitTitle } from "@/lib/content";
import { inlineText, parseInline, parseMarkdown } from "@/lib/markdown";
import { renderContentModule } from "../scripts/sync-content.mjs";
import { readFileSync } from "node:fs";

describe("long-form content", () => {
  it("the app's copy matches docs/content (run content:sync after editing docs)", () => {
    const generated = readFileSync(new URL("../src/content/pages.generated.ts", import.meta.url), "utf8");
    expect(generated).toBe(renderContentModule());
  });

  it("zh-TW reads 繁中; every other locale reads English", () => {
    expect(contentLocale("zh-TW")).toBe("zh-TW");
    expect(contentLocale("en")).toBe("en");
    for (const page of Object.keys(CONTENT_PAGES) as Array<keyof typeof CONTENT_PAGES>) {
      expect(splitTitle(contentBlocks(page, "en")).title).not.toBe("");
      expect(splitTitle(contentBlocks(page, "zh-TW")).title).not.toBe("");
    }
  });

  it("parses the subset the pages use", () => {
    const blocks = parseMarkdown([
      "> **Draft** note",
      "",
      "# Title",
      "<!-- dropped",
      "comment -->",
      "Effective: 【待填：date】",
      "",
      "## Section",
      "- one",
      "  continued",
      "- two",
      "1. first",
      "2. second",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "<small>fine print</small>",
      "---",
      "[Go](/help)",
    ].join("\n"));
    expect(blocks).toEqual([
      { type: "quote", text: "**Draft** note" },
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "Effective: 【待填：date】" },
      { type: "heading", level: 2, text: "Section" },
      { type: "list", ordered: false, items: ["one continued", "two"] },
      { type: "list", ordered: true, items: ["first", "second"] },
      { type: "table", head: ["A", "B"], rows: [["1", "2"]] },
      { type: "small", text: "fine print" },
      { type: "hr" },
      { type: "paragraph", text: "[Go](/help)" },
    ]);
    expect(parseInline("a **b [c](/x)** `d` 【待填：e】 f")).toEqual([
      { type: "text", text: "a " },
      { type: "bold", children: [{ type: "text", text: "b " }, { type: "link", href: "/x", children: [{ type: "text", text: "c" }] }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
      { type: "text", text: " " },
      { type: "placeholder", text: "【待填：e】" },
      { type: "text", text: " f" },
    ]);
    expect(inlineText("**Bold** and [link](/a)")).toBe("Bold and link");
  });

  it("dates the legal pages, leaves no placeholders in them, and links the FAQ at /help", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      for (const page of ["privacy", "terms"] as const) {
        // Anonymous: no 【待填】 slots for a company, address or email.
        expect(CONTENT_PAGES[page][locale], `${page}.${locale}`).not.toContain("【待填");
        expect(CONTENT_PAGES[page][locale], `${page}.${locale}`).toContain("https://x.com/orbie_fun");
        // The date is the first paragraph, which LegalDocument shows under the title.
        const { rest } = splitTitle(contentBlocks(page, locale));
        expect(rest[0], `${page}.${locale}`).toEqual({ type: "paragraph", text: locale === "zh-TW" ? "最後更新：2026-10-05" : "Last updated: 2026-10-05" });
      }
      // The "numbers you can see" section (Orbie-only, shown on /dev) links the FAQ.
      expect(CONTENT_PAGES.numbers[locale]).toContain("](/help)");
      expect(CONTENT_PAGES.numbers[locale]).not.toContain("](/faq)");
      expect(CONTENT_PAGES.about[locale]).not.toContain("](/faq)");
    }
  });

  it("groups the FAQ into sections of questions", () => {
    const sections = faqSections(contentBlocks("faq", "zh-TW"));
    expect(sections.length).toBeGreaterThan(5);
    expect(sections.reduce((n, s) => n + s.questions.length, 0)).toBe(43);
    expect(sections[0].questions[0].question).toBe("Orbie 是什麼？");
    expect(sections[0].questions[0].answer.length).toBeGreaterThan(0);
  });
});

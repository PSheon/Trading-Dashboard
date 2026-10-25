// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AboutPage } from "@/components/content/about-page";
import { CONTENT_PAGES } from "@/content/pages.generated";
import { contentBlocks } from "@/lib/content";

vi.mock("@/components/content/about-visuals", () => ({
  KolMarquee: () => <div data-testid="marquee" />,
  AvatarStack: () => <div data-testid="avatars" />,
  BoardMock: () => <div data-testid="step-picture" />,
  ProfileMock: () => <div data-testid="step-picture" />,
  CopyMock: () => <div data-testid="step-picture" />,
  PortfolioMock: () => <div />,
  AlertsMock: () => <div />,
}));
vi.mock("@/i18n/navigation", () => ({ Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

/** /about stays minimal (Paul, 2026-10-25): hero, marquee, three titled
 * steps, the funds-safety title with a Privy badge, the closing button. */
describe("about page", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    it(`${locale}: hero + one subtitle + CTA, three step titles with pictures and no paragraph, a Privy badge, the closing CTA`, () => {
      const doc = new DOMParser().parseFromString(renderToStaticMarkup(<AboutPage blocks={contentBlocks("about", locale)} />), "text/html");
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      // One paragraph: the hero's subtitle (and the small "built on" line).
      const paragraphs = [...doc.querySelectorAll("p")].map((p) => p.textContent ?? "");
      expect(paragraphs).toHaveLength(2);
      expect(doc.querySelectorAll('[data-testid="marquee"]')).toHaveLength(1);
      const steps = [...doc.querySelectorAll("figure")];
      expect(steps).toHaveLength(3);
      for (const step of steps) {
        expect(step.querySelector('[data-testid="step-picture"]')).not.toBeNull();
        expect(step.querySelector("p")).toBeNull();
        const title = step.querySelector("h3")!.textContent!;
        if (locale === "zh-TW") expect([...title].length, title).toBeLessThanOrEqual(8);
        else expect(title.split(/\s+/).length, title).toBeLessThanOrEqual(4);
      }
      const h2 = [...doc.querySelectorAll("h2")].map((h) => h.textContent);
      expect(h2).toEqual(locale === "zh-TW"
        ? ["三步驟：找人、看懂、跟上", "你的資金，由你掌控", "讓最強的交易員替你帶路"]
        : ["Three steps: find, understand, follow", "Your funds, your control", "Let the best traders lead the way"]);
      const badge = doc.querySelector('[data-testid="about-provider"]')!;
      expect(badge.textContent).toBe("Privy");
      expect(badge.getAttribute("title")).toBe(locale === "zh-TW" ? "錢包由 Privy 提供" : "Wallets by Privy");
      expect([...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/explore", "/"]);
    });
  }

  it("has no testnet wording and none of the removed sections", () => {
    for (const text of [CONTENT_PAGES.about["zh-TW"], CONTENT_PAGES.about.en]) {
      expect(text).not.toMatch(/測試網|testnet/i);
      expect(text).not.toMatch(/你的資金一目了然|他一出手，你就知道|your money at a glance|know the moment they move/i);
    }
  });
});
